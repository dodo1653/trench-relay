// trench-relay on Cloudflare Workers (free plan, no card): the same relay as ../index.mjs, inside one Durable Object so
// every Roblox server reads the same state. The object wakes on the first request, opens PumpPortal's websocket, and an
// alarm reads the bonding curves every TICK_MS. With no requests for IDLE_MS it closes the socket and stops its alarm
// (nobody playing = nothing used from the free quota). API: GET /v1/feed?since=&t=, GET /v1/coin?mint=, GET /health.
import { DurableObject } from "cloudflare:workers"
import { Buffer } from "node:buffer"
import crypto from "node:crypto"

const RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet.solana.com", "https://api.mainnet-beta.solana.com"]   // the beta endpoint blocks Cloudflare
const TICK_MS = 3000
const IDLE_MS = 10 * 60 * 1000
const MAX_TRACK = 160
const MIN_REAL_SOL = 0.1
const KEEP_TICKS = 300
const PIN_MS = 2 * 3600 * 1000

export default {
  async fetch(req, env) {
    const stub = env.RELAY.get(env.RELAY.idFromName("main7"))
    return stub.fetch(req)
  },
}

// ---------------------------------------------------------------- PDA of a mint's bonding curve (no deps)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
function b58decode(s) {
  let n = 0n
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("b58"); n = n * 58n + BigInt(i) }
  const out = []
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n }
  for (const ch of s) { if (ch !== "1") break; out.unshift(0) }
  return Buffer.from(out)
}
function b58encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), s = ""
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of buf) { if (b !== 0) break; s = "1" + s }
  return s
}
const P = 2n ** 255n - 19n
const modp = (a) => ((a % P) + P) % P
function powp(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n } return r }
const D = modp(-121665n * powp(121666n, P - 2n))
function onCurve(bytes) {
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i])
  y &= (1n << 255n) - 1n
  if (y >= P) return false
  const u = modp(y * y - 1n), v = modp(D * y * y + 1n)
  const x = modp(u * powp(v, 3n) * powp(u * powp(v, 7n), (P - 5n) / 8n))
  const vx2 = modp(v * x * x)
  return vx2 === u || vx2 === modp(-u)
}
const PUMP = b58decode("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
function curveOf(mint) {
  const m = b58decode(mint)
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash("sha256").update(Buffer.concat([Buffer.from("bonding-curve"), m, Buffer.from([bump]), PUMP, Buffer.from("ProgramDerivedAddress")])).digest()
    if (!onCurve(h)) return b58encode(h)
  }
  return null
}

// ---------------------------------------------------------------- the relay
export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.env = env
    this.seq = 0
    this.coins = new Map()
    this.dropped = []
    this.ws = null
    this.lastReq = 0
    this.tickN = 0
  }

  // ------------------------------------------------ launches
  connect() {
    if (this.ws) return
    this.ws = "connecting"
    ;(async () => {
      try {
        const resp = await fetch("https://pumpportal.fun/api/data", { headers: { Upgrade: "websocket" } })
        const ws = resp.webSocket
        if (!ws) throw new Error("no websocket")
        ws.accept()
        ws.send(JSON.stringify({ method: "subscribeNewToken" }))
        ws.addEventListener("message", (e) => { this.lastMsg = Date.now(); this.onLaunch(e.data) })
        const drop = () => { if (this.ws === ws) this.ws = null }
        ws.addEventListener("close", drop)
        ws.addEventListener("error", drop)
        this.ws = ws
        this.lastMsg = Date.now()
      } catch (e) {
        console.log('pumpportal connect failed', String(e))
        this.ws = null
      }
    })()
  }
  onLaunch(data) {
    let m
    try { m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) } catch { return }
    if (m.txType !== "create" || m.pool !== "pump" || !m.mint || !m.bondingCurveKey) return
    if (Math.abs((m.vSolInBondingCurve || 0) - 30 - (m.solAmount || 0)) > 2 && m.vSolInBondingCurve !== 30) return
    const name = String(m.name || "").trim().slice(0, 32), symbol = String(m.symbol || "").trim().slice(0, 12)
    if (!name || !symbol) return
    const c = {
      mint: m.mint, curve: m.bondingCurveKey, name, symbol, createdAt: Date.now(),
      vSol: m.vSolInBondingCurve || 30, vTok: m.vTokensInBondingCurve || 1073000000, rSol: Math.max(0, (m.vSolInBondingCurve || 30) - 30), complete: false,
      mc: m.marketCapSol || 28, published: false, seq: 0, ticks: [], lastMove: Date.now(), pinnedUntil: 0,
    }
    this.coins.set(m.mint, c)
    if (c.rSol >= MIN_REAL_SOL) { c.published = true; this.tick(c, c.mc) }
    this.prune()
  }
  score(c) { return (c.published ? 1e6 : 0) + c.mc * 1000 - (Date.now() - c.lastMove) / 1000 }
  prune() {
    if (this.coins.size <= MAX_TRACK) return
    const now = Date.now()
    const list = [...this.coins.values()].filter((c) => c.pinnedUntil < now).sort((a, b) => this.score(a) - this.score(b))
    for (const c of list) {
      if (this.coins.size <= MAX_TRACK) break
      this.coins.delete(c.mint)
      if (c.published) this.dropped.push([++this.seq, c.mint])
    }
    while (this.dropped.length > 500) this.dropped.shift()
  }

  // ------------------------------------------------ prices
  async rpc(method, params) {
    let last
    const list = this.env.RPC_URL ? [this.env.RPC_URL] : RPCS
    for (let i = 0; i < list.length; i++) {
      const url = list[((this.rpcIdx || 0) + i) % list.length]
      try { const out = await this.rpcAt(url, method, params); this.rpcIdx = list.indexOf(url); return out } catch (e) { last = e; (this.errs = this.errs || {})[this.env.RPC_URL ? 'keyed' : url] = String(e).slice(0, 140) }
    }
    throw last
  }
  async rpcAt(url, method, params) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    const txt = await r.text()
    let j
    try { j = JSON.parse(txt) } catch { throw new Error("rpc " + r.status + " " + txt.slice(0, 120)) }
    if (j.error) throw new Error(j.error.message)
    return j.result
  }
  tick(c, mc) {
    const now = Date.now()
    c.ticks.push([now, +mc.toFixed(4), +c.rSol.toFixed(4)])
    if (c.ticks.length > KEEP_TICKS) c.ticks.splice(0, c.ticks.length - KEEP_TICKS)
    c.mc = mc; c.lastMove = now; c.seq = ++this.seq
  }
  async pollCurves() {
    // publicnode (the free RPC that lets Cloudflare in) takes 10 accounts a call: every published coin each round (60 max,
    // freshest moves first), the not-yet-published ones 20 at a time in rotation
    const open = [...this.coins.values()].filter((c) => !c.complete && c.curve)
    const big = !!this.env.RPC_URL
    const pub = open.filter((c) => c.published).sort((a, b) => b.lastMove - a.lastMove).slice(0, big ? 120 : 60)
    const rest = open.filter((c) => !c.published)
    this.rot = ((this.rot || 0) + 20) % Math.max(rest.length, 1)
    const list = big ? pub.concat(rest) : pub.concat(rest.slice(this.rot, this.rot + 20))
    const per = big ? 100 : 10
    for (let i = 0; i < list.length; i += per) {
      const batch = list.slice(i, i + per)
      let res
      try { res = await this.rpc("getMultipleAccounts", [batch.map((c) => c.curve), { encoding: "base64" }]); this.rpcOk = (this.rpcOk || 0) + 1 } catch (e) { this.lastErr = String(e).slice(0, 200); return }
      res.value.forEach((acc, j) => {
        const c = batch[j]
        if (!acc) return
        const b = Buffer.from(acc.data[0], "base64")
        if (b.length < 49) return
        const vTok = Number(b.readBigUInt64LE(8)) / 1e6, vSol = Number(b.readBigUInt64LE(16)) / 1e9
        const rSol = Number(b.readBigUInt64LE(32)) / 1e9, complete = b[48] === 1
        if (complete) { c.complete = true; c.seq = ++this.seq; return }
        if (vTok <= 0 || Math.abs(vSol - rSol - 30) > 0.5) return
        const mc = (vSol / vTok) * 1e9
        const changed = Math.abs(vSol - c.vSol) > 1e-6
        c.vSol = vSol; c.vTok = vTok; c.rSol = rSol
        if (!c.published && rSol >= MIN_REAL_SOL) { c.published = true; this.tick(c, mc) }
        else if (changed && c.published) this.tick(c, mc)
      })
    }
  }
  async pollGraduated() {
    const list = [...this.coins.values()].filter((c) => c.complete && c.published)
    for (let i = 0; i < list.length; i += 30) {
      const batch = list.slice(i, i + 30)
      try {
        const r = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + batch.map((c) => c.mint).join(","))
        const pairs = await r.json()
        for (const c of batch) {
          const p = (Array.isArray(pairs) ? pairs : []).filter((x) => x.baseToken && x.baseToken.address === c.mint)
            .sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0]
          if (!p || !p.priceNative) continue
          const mc = +p.priceNative * 1e9
          if (Math.abs(mc - c.mc) / Math.max(c.mc, 1e-9) > 0.001) { c.liqUsd = (p.liquidity || {}).usd || 0; this.tick(c, mc) }
        }
      } catch {}
    }
  }
  async adopt(mint) {
    if (this.coins.has(mint)) return this.coins.get(mint)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null
    try {
      const curve = curveOf(mint)
      const res = await this.rpc("getAccountInfo", [curve, { encoding: "base64" }])
      if (!res || !res.value) return null
      const b = Buffer.from(res.value.data[0], "base64")
      if (b.length < 49) return null
      const c = { mint, curve, name: "", symbol: "", createdAt: Date.now(), vSol: 30, vTok: 1073000000, rSol: 0, complete: b[48] === 1,
        mc: 28, published: true, seq: 0, ticks: [], lastMove: Date.now(), pinnedUntil: 0 }
      if (!c.complete) {
        c.vTok = Number(b.readBigUInt64LE(8)) / 1e6; c.vSol = Number(b.readBigUInt64LE(16)) / 1e9; c.rSol = Number(b.readBigUInt64LE(32)) / 1e9
        if (c.vTok <= 0 || Math.abs(c.vSol - c.rSol - 30) > 0.5) return null
        this.tick(c, (c.vSol / c.vTok) * 1e9)
      } else {
        c.rSol = 85
        const r = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + mint)
        const p = ((await r.json()) || []).sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0]
        if (!p || !p.priceNative) return null
        c.name = p.baseToken.name.slice(0, 32); c.symbol = p.baseToken.symbol.slice(0, 12)
        this.tick(c, +p.priceNative * 1e9)
      }
      this.coins.set(mint, c)
      return c
    } catch { return null }
  }

  // ------------------------------------------------ the loop (alarm) and requests
  async alarm() {
    if (Date.now() - this.lastReq > IDLE_MS) {
      try { if (this.ws && this.ws !== "connecting") this.ws.close() } catch {}
      this.ws = null
      return   // asleep until the next request
    }
    if (this.ws && this.ws !== "connecting" && Date.now() - (this.lastMsg || 0) > 45000) {
      try { this.ws.close() } catch {}
      this.ws = null; this.reconnects = (this.reconnects || 0) + 1
    }
    this.connect()
    await this.pollCurves()
    if (++this.tickN % 8 === 0) await this.pollGraduated()
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
  }
  view(c, sinceT) {
    return { id: c.mint, n: c.name, s: c.symbol, t: c.createdAt, r: +c.rSol.toFixed(4), v: +c.vSol.toFixed(6), k: Math.round(c.vTok),
      g: c.complete, mc: +c.mc.toFixed(4), liq: c.liqUsd || 0, ticks: c.ticks.filter((x) => !sinceT || x[0] > sinceT) }
  }
  async fetch(req) {
    this.lastReq = Date.now()
    this.connect()
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 500)
    const u = new URL(req.url)
    const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } })
    if (u.pathname === "/v1/feed") {
      const since = +(u.searchParams.get("since") || 0), sinceT = +(u.searchParams.get("t") || 0)
      const out = []
      for (const c of this.coins.values()) if (c.published && c.seq > since) out.push(this.view(c, sinceT))
      out.sort((a, b) => b.t - a.t)
      return json(200, { seq: this.seq, now: Date.now(), coins: out.slice(0, 120), dropped: this.dropped.filter((d) => d[0] > since).map((d) => d[1]) })
    }
    if (u.pathname === "/v1/coin") {
      const c = this.coins.get(u.searchParams.get("mint") || "") || (await this.adopt(u.searchParams.get("mint") || ""))
      if (!c) return json(404, { error: "unknown" })
      c.pinnedUntil = Date.now() + PIN_MS
      return json(200, this.view(c, 0))
    }
    if (u.pathname === "/" || u.pathname === "/health") {
      return json(200, { ok: true, tracked: this.coins.size, published: [...this.coins.values()].filter((c) => c.published).length, seq: this.seq, socket: this.ws ? (this.ws === "connecting" ? "connecting" : "open") : "closed", rpcOk: this.rpcOk || 0, lastMsgAgo: this.lastMsg ? Date.now() - this.lastMsg : null, reconnects: this.reconnects || 0, lastErr: this.lastErr || null, errs: this.errs || null, ticks: this.tickN })
    }
    return json(404, { error: "not found" })
  }
}

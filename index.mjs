// trench-relay: live pump.fun launches for Trench County (2026-10-22).
// Roblox servers can't open websockets, so this small service does it for them:
//   1. PumpPortal's free websocket tells us about every new pump.fun launch (name, symbol, mint, bonding curve).
//   2. Every POLL_MS we read the tracked coins' bonding curves straight from Solana (getMultipleAccounts, free public
//      RPC): virtual / real reserves -> price and market cap in SOL, and whether the coin graduated.
//   3. Graduated coins are priced from DexScreener every 30 s.
//   4. Roblox polls GET /v1/feed?since=<seq> for what changed, and GET /v1/coin?mint=<mint> keeps a coin someone
//      holds in game tracked ("pinned") even after it falls off the fresh list.
// No dependencies (Node 20+: global WebSocket in 22, fetch). PORT from the environment.
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = +(process.env.PORT || 8787)
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com'
const POLL_MS = +(process.env.POLL_MS || 2500)
const MAX_TRACK = +(process.env.MAX_TRACK || 160)      // coins whose curves we read each cycle
const MIN_REAL_SOL = +(process.env.MIN_REAL_SOL || 0.25) // publish a coin once someone besides the dev bought in
const KEEP_TICKS = 400
const PIN_MS = 2 * 3600 * 1000

let seq = 0
const coins = new Map()   // mint -> coin
const dropped = []        // [seq, mint]
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ------------------------------------------------------------------ launches (PumpPortal)
function connect() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data')
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ method: 'subscribeNewToken' })); log('pumpportal: subscribed') })
  ws.addEventListener('message', (e) => {
    let m
    try { m = JSON.parse(e.data) } catch { return }
    if (m.txType !== 'create' || m.pool !== 'pump' || !m.mint || !m.bondingCurveKey) return
    // only standard SOL-quoted curves (30 virtual SOL at launch); newer quote variants price differently
    if (Math.abs((m.vSolInBondingCurve || 0) - 30 - (m.solAmount || 0)) > 2 && m.vSolInBondingCurve !== 30) return
    const name = String(m.name || '').trim().slice(0, 32), symbol = String(m.symbol || '').trim().slice(0, 12)
    if (!name || !symbol) return
    coins.set(m.mint, {
      mint: m.mint, curve: m.bondingCurveKey, name, symbol, createdAt: Date.now(),
      vSol: m.vSolInBondingCurve || 30, vTok: m.vTokensInBondingCurve || 1_073_000_000, rSol: 0, complete: false,
      mc: m.marketCapSol || 28, published: false, seq: 0, ticks: [], lastMove: Date.now(), pinnedUntil: 0,
    })
    prune()
  })
  const retry = () => { log('pumpportal: reconnecting'); setTimeout(connect, 3000) }
  ws.addEventListener('close', retry, { once: true })
  ws.addEventListener('error', () => { try { ws.close() } catch {} }, { once: true })
}

// keep the tracked set small: drop the oldest quiet coins first, never pinned ones
function prune() {
  if (coins.size <= MAX_TRACK) return
  const now = Date.now()
  const list = [...coins.values()].filter((c) => c.pinnedUntil < now)
  list.sort((a, b) => score(a) - score(b))
  for (const c of list) {
    if (coins.size <= MAX_TRACK) break
    coins.delete(c.mint)
    if (c.published) dropped.push([++seq, c.mint])
  }
  while (dropped.length > 500) dropped.shift()
}
const score = (c) => (c.published ? 1e6 : 0) + c.mc * 1000 - (Date.now() - c.lastMove) / 1000

// ------------------------------------------------------------------ prices (Solana RPC)
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}
function tick(c, mc) {
  const now = Date.now()
  c.ticks.push([now, +mc.toFixed(4), +c.rSol.toFixed(4)])
  if (c.ticks.length > KEEP_TICKS) c.ticks.splice(0, c.ticks.length - KEEP_TICKS)
  c.mc = mc; c.lastMove = now; c.seq = ++seq
}
async function pollCurves() {
  const list = [...coins.values()].filter((c) => !c.complete)
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100)
    let res
    try { res = await rpc('getMultipleAccounts', [batch.map((c) => c.curve), { encoding: 'base64' }]) } catch (e) { log('rpc', e.message); return }
    res.value.forEach((acc, j) => {
      const c = batch[j]
      if (!acc) return
      const b = Buffer.from(acc.data[0], 'base64')
      if (b.length < 49) return
      const vTok = Number(b.readBigUInt64LE(8)) / 1e6, vSol = Number(b.readBigUInt64LE(16)) / 1e9
      const rSol = Number(b.readBigUInt64LE(32)) / 1e9, complete = b[48] === 1
      if (complete) { c.complete = true; c.seq = ++seq; return }
      if (vTok <= 0 || Math.abs(vSol - rSol - 30) > 0.5) return   // not a standard SOL curve
      const mc = (vSol / vTok) * 1e9
      const changed = Math.abs(vSol - c.vSol) > 1e-6
      c.vSol = vSol; c.vTok = vTok; c.rSol = rSol
      if (!c.published && rSol >= MIN_REAL_SOL) { c.published = true; tick(c, mc) }
      else if (changed && c.published) tick(c, mc)
    })
  }
}
// graduated coins: price from DexScreener (up to 30 addresses a call)
async function pollGraduated() {
  const list = [...coins.values()].filter((c) => c.complete && c.published)
  for (let i = 0; i < list.length; i += 30) {
    const batch = list.slice(i, i + 30)
    try {
      const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + batch.map((c) => c.mint).join(','))
      const pairs = await r.json()
      for (const c of batch) {
        const p = (Array.isArray(pairs) ? pairs : []).filter((x) => x.baseToken && x.baseToken.address === c.mint)
          .sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0]
        if (!p || !p.priceNative) continue
        const mc = +p.priceNative * 1e9
        if (Math.abs(mc - c.mc) / Math.max(c.mc, 1e-9) > 0.001) { c.liqUsd = (p.liquidity || {}).usd || 0; tick(c, mc) }
      }
    } catch (e) { log('dexscreener', e.message) }
  }
}
// ------------------------------------------------------------------ bonding-curve address of any mint (PDA, no deps)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58decode(s) {
  let n = 0n
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error('b58'); n = n * 58n + BigInt(i) }
  const out = []
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n }
  for (const ch of s) { if (ch !== '1') break; out.unshift(0) }
  return Buffer.from(out)
}
function b58encode(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0')), s = ''
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of buf) { if (b !== 0) break; s = '1' + s }
  return s
}
// ed25519: is this 32-byte string a valid curve point? (PDAs must not be)
const P = 2n ** 255n - 19n
const modp = (a) => ((a % P) + P) % P
function powp(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n } return r }
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
const PUMP = b58decode('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
function curveOf(mint) {
  const m = b58decode(mint)
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('bonding-curve'), m, Buffer.from([bump]), PUMP, Buffer.from('ProgramDerivedAddress')])).digest()
    if (!onCurve(h)) return b58encode(h)
  }
  return null
}

// a coin someone holds in game but that we don't track (relay restarted, or it was pruned): read its curve by mint.
// Graduated coins are priced from DexScreener instead.
async function adopt(mint) {
  if (coins.has(mint)) return coins.get(mint)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null
  try {
    const curve = curveOf(mint)
    const res = await rpc('getAccountInfo', [curve, { encoding: 'base64' }])
    if (!res || !res.value) return null
    const b = Buffer.from(res.value.data[0], 'base64')
    if (b.length < 49) return null
    const c = { mint, curve, name: '', symbol: '', createdAt: Date.now(), vSol: 30, vTok: 1_073_000_000, rSol: 0, complete: b[48] === 1,
      mc: 28, published: true, seq: 0, ticks: [], lastMove: Date.now(), pinnedUntil: 0 }
    if (!c.complete) {
      c.vTok = Number(b.readBigUInt64LE(8)) / 1e6; c.vSol = Number(b.readBigUInt64LE(16)) / 1e9; c.rSol = Number(b.readBigUInt64LE(32)) / 1e9
      if (c.vTok <= 0 || Math.abs(c.vSol - c.rSol - 30) > 0.5) return null
      tick(c, (c.vSol / c.vTok) * 1e9)
    } else {
      c.rSol = 85
      const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + mint)
      const p = ((await r.json()) || []).sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0]
      if (!p || !p.priceNative) return null
      c.name = p.baseToken.name.slice(0, 32); c.symbol = p.baseToken.symbol.slice(0, 12)
      tick(c, +p.priceNative * 1e9)
    }
    coins.set(mint, c)
    return c
  } catch (e) { log('adopt', e.message); return null }
}

function view(c, since) {
  return { id: c.mint, n: c.name, s: c.symbol, t: c.createdAt, r: +c.rSol.toFixed(4), v: +c.vSol.toFixed(6), k: Math.round(c.vTok),
    g: c.complete, mc: +c.mc.toFixed(4), liq: c.liqUsd || 0, ticks: c.ticks.filter((x) => !since || x[0] > since.t) }
}

// ------------------------------------------------------------------ http
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) }
  if (u.pathname === '/v1/feed') {
    const since = +(u.searchParams.get('since') || 0)
    const sinceT = +(u.searchParams.get('t') || 0)
    const out = []
    for (const c of coins.values()) if (c.published && c.seq > since) out.push(view(c, sinceT ? { t: sinceT } : null))
    out.sort((a, b) => b.t - a.t)
    return send(200, { seq, now: Date.now(), coins: out.slice(0, 120), dropped: dropped.filter((d) => d[0] > since).map((d) => d[1]) })
  }
  if (u.pathname === '/v1/coin') {
    const mint = u.searchParams.get('mint') || ''
    const c = coins.get(mint) || (await adopt(mint))
    if (!c) return send(404, { error: 'unknown' })
    c.pinnedUntil = Date.now() + PIN_MS
    return send(200, view(c, null))
  }
  if (u.pathname === '/' || u.pathname === '/health') return send(200, { ok: true, tracked: coins.size, published: [...coins.values()].filter((c) => c.published).length, seq })
  send(404, { error: 'not found' })
})

server.listen(PORT, () => log('trench-relay on :' + PORT))
connect()
setInterval(() => { pollCurves().catch((e) => log('poll', e.message)) }, POLL_MS)
setInterval(() => { pollGraduated().catch(() => {}) }, 30000)

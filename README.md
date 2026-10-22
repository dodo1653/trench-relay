# trench-relay

Live pump.fun launches for Trench County's Pulse terminal. Roblox servers can't open websockets, so this tiny Node
service (no dependencies, Node 22+) does it for them and serves plain JSON.

- **Launches:** PumpPortal's free websocket (`subscribeNewToken`). Only standard SOL-quoted pump curves (`pool == "pump"`,
  30 virtual SOL); a coin is published once its curve holds 0.25 SOL of real buys (`MIN_REAL_SOL`).
- **Prices:** every 2.5 s the tracked coins' bonding-curve accounts are read with `getMultipleAccounts` (public Solana RPC
  or `SOLANA_RPC`). Layout after the 8-byte discriminator: u64 virtual token reserves, virtual SOL, real token, real SOL,
  supply, then `complete`. Price = (vSol / 1e9) / (vTok / 1e6); market cap = price x 1e9.
- **Graduated coins:** DexScreener, every 30 s.
- **Re-adopting a coin** a player holds (`/v1/coin?mint=`): the bonding-curve address is derived from the mint (PDA,
  `["bonding-curve", mint]` under the pump program), so it works after a restart too. Asking pins the coin for 2 h.

## API
- `GET /v1/feed?since=<seq>&t=<ms>` -> `{ seq, now, coins: [{ id, n, s, t, r, v, k, g, mc, liq, ticks: [[ms, mcSol, realSol]] }], dropped }`
  (only coins changed after `since`; ticks newer than `t`)
- `GET /v1/coin?mint=<mint>` -> one coin (and pins it)
- `GET /health`

## Run / deploy
`node index.mjs` (PORT, SOLANA_RPC, POLL_MS, MAX_TRACK, MIN_REAL_SOL from the environment).
Render: New > Blueprint (or Web Service) from this repo, free plan; `render.yaml` is included. Put the URL in Studio on
`ServerScriptService.RealCoins`, attribute `RelayUrl`.

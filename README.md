# Hyperworker

An always-on, multi-tenant trailing stop-loss engine for Hyperliquid perpetuals.

Hyperworker runs as a single long-lived Node.js process. For every configured
account (tenant) it keeps a native reduce-only stop-market trigger order
resting on the exchange at all times, and only ever **tightens** it as price
moves in the position's favor. Hyperliquid is the source of truth for
position and the resting stop; the service holds no authoritative state of
its own and can be restarted at any time without risk.

## How it works

- Every `POLL_MS` (default 3000ms), the engine fetches the mid price for
  `COIN` once and reuses it for every tenant.
- For each tenant it reads the live position and the resting stop-loss
  trigger order directly from Hyperliquid (`clearinghouseState` /
  `frontendOpenOrders`).
- If the position has grown/shrunk, the resting stop's size is updated to
  match (`modify`, same order, no cancel).
- If the trailing distance implies a tighter stop than what is currently
  resting, the engine moves it with `modify` — the order ID never changes and
  the position is never left unprotected.
- The stop is **never loosened**. The only allowed failure mode is "the stop
  stops moving"; a stale-but-present stop is always safer than no stop.
- On startup (or after any redeploy/crash), the engine reconciles from
  scratch: an open position with no resting stop gets one created
  immediately; an existing stop is adopted by its order ID and trailing
  resumes from there.

## Multi-tenant configuration

Hyperworker manages any number of Hyperliquid accounts at once, all trading
the same `COIN`. Each tenant is a master account address plus its own
trade-only agent wallet and trailing configuration, supplied via indexed
environment variables:

```
HL_ACCOUNT_ADDRESS_1=0x...
HL_AGENT_PRIVATE_KEY_1=0x...
TRAIL_TYPE_1=pct        # "pct" or "abs"
TRAIL_VALUE_1=0.02      # 2% trailing distance

HL_ACCOUNT_ADDRESS_2=0x...
HL_AGENT_PRIVATE_KEY_2=0x...
TRAIL_TYPE_2=abs
TRAIL_VALUE_2=500       # $500 trailing distance
```

The engine enumerates tenants starting at `1` and stops at the first missing
`HL_AGENT_PRIVATE_KEY_{N}`, so tenants must be numbered contiguously from 1
with no gaps. You can also set global `TRAIL_TYPE` / `TRAIL_VALUE` as
defaults for any tenant that omits its own.

Trail modes:

- `pct` — a fraction of price (e.g. `0.02` = stop trails 2% behind price).
- `abs` — a fixed absolute price distance in quote/USD (e.g. `500` = stop
  stays $500 behind price, regardless of price level).

Each tenant's failures are isolated: an error on one account (rate limit,
transient API error, bad config) is logged and retried next loop, and never
affects the other tenants or crashes the process.

See [`.env.example`](.env.example) for the full list of variables.

## Agent wallet setup (safety model)

Hyperworker signs every exchange action with a Hyperliquid **API/agent
wallet**, never with a master account's private key.

1. In the Hyperliquid UI (or via the SDK), generate a new wallet keypair to
   use as the agent. This is a throwaway key — write down the address and
   private key.
2. From each master account you want to protect, call `approveAgent` (via the
   UI's "API Wallets" settings, or `ExchangeClient.approveAgent`) to approve
   the agent's address to trade on that account's behalf.
3. Agent wallets approved this way can place, modify, and cancel orders, but
   **cannot withdraw or transfer funds** — they have no access to the
   account's collateral beyond placing/adjusting orders.
4. Put the agent's private key in `HL_AGENT_PRIVATE_KEY_{N}` for that
   tenant's slot, and the master account's address in
   `HL_ACCOUNT_ADDRESS_{N}`. The master account's own private key should
   never be entered anywhere in this service's configuration.
5. Repeat for each additional tenant, using a distinct agent wallet per
   master account (recommended) or approving the same agent on multiple
   accounts.

If an agent's approval is ever revoked or expires, the engine will start
failing to place/modify orders for that tenant; it will log and alert on
every failed attempt but will not crash, and the previously-resting stop (if
any) remains in place on the exchange regardless.

## Testnet vs mainnet

`HL_BASE` selects the environment:

- Testnet: `https://api.hyperliquid-testnet.xyz`
- Mainnet: `https://api.hyperliquid.xyz`

**Always validate against testnet first.** Fund a testnet account, open a
small position, approve a testnet agent wallet, and run the service against
`HL_BASE=https://api.hyperliquid-testnet.xyz` to confirm reconciliation,
trailing, and resizing all behave as expected before pointing at mainnet.
Testnet and mainnet use entirely separate accounts/keys — a mainnet agent
approval does not carry over to testnet, and vice versa.

## The singleton constraint

This service **must run as exactly one instance at all times.** It uses
`modify` (not cancel-then-place) to keep the same resting order alive, and
two instances racing to `modify` the same order — or worse, disagreeing on
whether a stop needs to be created — is the core hazard this design exists
to avoid.

Two layers of protection:

1. **Railway-level:** [`railway.json`](railway.json) pins `numReplicas: 1`.
   Never manually scale this service beyond 1 replica, and never run it as a
   second Railway service against the same accounts.
2. **Redis-level (defense in depth):** on startup the process acquires a
   short-TTL lock (`bot:lock`) in Upstash Redis and renews it every loop. If
   a second instance starts (e.g. during a rolling deploy overlap) and can't
   acquire the lock, it logs an error and exits immediately rather than
   racing the incumbent. If the active instance crashes without releasing
   the lock, it expires automatically after 30 seconds so a replacement can
   take over.

On graceful shutdown (`SIGTERM`/`SIGINT`) the engine finishes its in-flight
loop iteration, releases the Redis lock, and exits — it never cancels any
resting stop order as part of shutdown, since the whole point is that
protection must survive restarts and deploys.

## Observability

- A JSON state snapshot is written to Upstash Redis at `bot:state:<address>`
  every loop for each tenant, and the tenant's address is added to the
  `bot:tenants` set for discovery. On any change to a tenant's state, the
  snapshot is also published to the `bot:updates` channel.

  ```json
  {
    "address": "0xabc...",
    "coin": "BTC",
    "price": 97234.5,
    "position": { "side": "long", "size": 0.1, "entryPx": 95000.0 },
    "stop": { "triggerPx": 95289.6, "orderId": 12345 },
    "trail": { "type": "abs", "value": 500 },
    "lastAction": "moved stop 95100 -> 95289.6",
    "updatedAt": "2026-07-17T10:31:02Z"
  }
  ```

- `HEALTHCHECK_URL` (e.g. a [healthchecks.io](https://healthchecks.io) check)
  is pinged once per loop — a dead-man's switch that fires if the process
  hangs or crashes. Set the check's grace period to a few multiples of
  `POLL_MS`.
- Structured logs are emitted via `pino`, with every tenant's log lines
  bound to its account `address`.
- Alerts (warn/error level logs) fire on: a stop being moved, any error, and
  position-opened / position-closed transitions.

## Local development

```bash
cp .env.example .env
# fill in .env with testnet credentials
npm install
npm run dev
```

## Deploying to Railway

1. Push this repo to a Git provider Railway can access.
2. Create a new Railway service from the repo — it will build from the
   included `Dockerfile` and apply [`railway.json`](railway.json)
   (`numReplicas: 1`).
3. Set all environment variables from `.env.example` in the Railway service
   settings.
4. Deploy. Confirm in the logs that reconciliation ran successfully for
   every tenant before considering the deploy healthy.

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
- The stop is **never loosened** by automatic trailing. The only allowed
  failure mode is "the stop stops moving"; a stale-but-present stop is always
  safer than no stop. (A deliberate `type`/`value` change via Redis is the one
  exception — see [Runtime overrides via Redis](#runtime-overrides-via-redis).)
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

## Runtime overrides via Redis

The env-var trail settings are **defaults**. Each tenant's trail type, value,
and an on/off toggle can be overridden at runtime — without a redeploy — by
writing to a per-tenant Redis hash at `bot:config:<address>` (address
lowercased, matching the state key). The engine reads it every loop and merges
it over the configured defaults:

| Field     | Values                              | Effect                                                    |
| --------- | ----------------------------------- | -------------------------------------------------------- |
| `type`    | `pct` \| `abs`                      | Overrides the trail type.                                 |
| `value`   | positive number                     | Overrides the trail distance.                            |
| `enabled` | `true`/`false` (`1`/`0`, `on`/`off`) | Turns trailing on/off for the tenant (default `true`).   |

Any field left unset falls back to the env default. Only fields that are set
are overridden, so you can flip a single value while leaving the rest on the
configured defaults. If an override is malformed (bad enum, non-positive
value, or a `pct` value ≥ 1 after merging), it is ignored with a logged
warning and the configured default is used instead.

```bash
# Trail 1% instead of the configured default
redis-cli hset bot:config:0xabc... type pct value 0.01

# Turn the trail OFF for this tenant (resting stop is canceled while a
# position is open)
redis-cli hset bot:config:0xabc... enabled false

# Turn it back ON (a fresh stop is created for the open position)
redis-cli hset bot:config:0xabc... enabled true

# Drop all overrides and revert entirely to env defaults
redis-cli del bot:config:0xabc...
```

**Toggle behavior with an open position:** setting `enabled=false` cancels the
tenant's resting stop on the next loop, and setting it back to `enabled=true`
recreates a stop from the current price (and then resumes tightening). Toggling
has no exchange effect while flat — there is simply no stop to add or remove.

**Changing `type` / `value` with an open position:** a change to the trail
distance is treated as a deliberate instruction and is applied on the next loop
even if it *loosens* the stop (moves it further from price). This is the one
exception to the "never loosen" rule, which otherwise governs automatic
price-driven trailing: once a reconfigured stop is in place, ordinary trailing
resumes and only ever tightens from there. If you change the value while flat,
it simply takes effect when the next position opens.

## Trading API

Besides trailing, the same process exposes a small HTTP API so a frontend can
**open and close positions on demand** (e.g. buy/sell buttons). It runs inside
the singleton engine — not a separate service — so it reuses each tenant's
already-loaded agent wallet and never duplicates private keys. Because
Hyperliquid is the source of truth, any position opened through the API is
picked up and protected by a trailing stop on the **next poll** (within
`POLL_MS`), exactly like a position opened by hand; there is a brief unprotected
window until that first stop is placed.

The API listens on `PORT` (Railway injects this automatically; defaults to
`8080` locally). An order with **no `price`** is placed as an IOC ("market")
order, priced `MARKET_MAX_SLIPPAGE` through the mid so it crosses the book and
fills immediately. An order **with a `price`** is placed as a resting GTC limit
order at exactly that price, which stays on the book until it fills or is
canceled (it only opens a position — and thus only gets a trailing stop — once
filled). Per-tenant requests are serialized so a manual order can't interleave
mid-flight with the engine's stop `modify`.

### Endpoints

| Method | Path                             | Body                                             | Effect                                                            |
| ------ | -------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| `GET`  | `/health`                        | —                                                | Liveness check (no auth).                                         |
| `POST` | `/api/tenants/:address/order`    | `{ "side": "buy"\|"sell", "size": <coin units>, "price": <number?>, "reduceOnly": <bool?> }` | `price` set → resting GTC limit at that price; `price` empty → market IOC at the live mid. `reduceOnly:false` opens/adds; `reduceOnly:true` reduces. |
| `GET`  | `/api/tenants/:address/orders`   | —                                                | Lists the tenant's open (resting) orders for `COIN`, including any trailing stop, with their order IDs. |
| `POST` | `/api/tenants/:address/cancel`   | `{ "oid": <order id> }`                          | Cancels a single open order by its order ID. |
| `POST` | `/api/tenants/:address/close`    | —                                                | Flattens the tenant's open position (full-size reduce-only market). |

`:address` is the tenant's **master account address** (as configured in
`HL_ACCOUNT_ADDRESS_{N}`); the engine maps it to that tenant's stored agent
wallet to sign. `size` is in coin units (e.g. `0.01` BTC). `side` chooses
direction: `buy` = long, `sell` = short. `price` is optional — omit it (or send
`null`/`""`) to trade at the current market price, or set it for a limit order.

Use `GET /api/tenants/:address/orders` to list the tenant's resting orders (e.g.
an unfilled limit order) and read their `oid`, then `POST
/api/tenants/:address/cancel` with that `oid` to cancel one. Cancels are
serialized with the engine's stop `modify` per tenant, exactly like order
placement. Note that cancelling the engine's own trailing stop while a position
is open only removes it until the **next poll** (within `POLL_MS`), when the
engine notices the position is unprotected and recreates the stop from the
current price; to keep a stop off, disable trailing for the tenant via the Redis
`enabled=false` override instead (see
[Runtime overrides via Redis](#runtime-overrides-via-redis)).

```bash
# Market buy: 0.01 BTC long at the current price (no price field)
curl -X POST http://localhost:8080/api/tenants/0xabc.../order \
  -H 'authorization: Bearer <API_AUTH_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"side":"buy","size":0.01}'

# Limit buy: 0.01 BTC long resting at $95,000
curl -X POST http://localhost:8080/api/tenants/0xabc.../order \
  -H 'authorization: Bearer <API_AUTH_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"side":"buy","size":0.01,"price":95000}'

# Market short: 0.01 BTC at the current price
curl -X POST http://localhost:8080/api/tenants/0xabc.../order \
  -H 'authorization: Bearer <API_AUTH_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"side":"sell","size":0.01}'

# List open (resting) orders and their order IDs
curl http://localhost:8080/api/tenants/0xabc.../orders \
  -H 'authorization: Bearer <API_AUTH_TOKEN>'

# Cancel a single open order by its order ID
curl -X POST http://localhost:8080/api/tenants/0xabc.../cancel \
  -H 'authorization: Bearer <API_AUTH_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"oid":123456789}'

# Flatten the position (always market)
curl -X POST http://localhost:8080/api/tenants/0xabc.../close \
  -H 'authorization: Bearer <API_AUTH_TOKEN>'
```

### Authentication and CORS

The trading API moves real money and is publicly reachable on Railway, and
master account addresses are public on-chain — so the address alone is **not** a
secret. Set `API_AUTH_TOKEN` to require an `Authorization: Bearer <token>`
header on every `/api/*` request. If it is left unset the API runs
**unauthenticated** and logs a warning at startup; only do that on testnet.
Set `CORS_ORIGIN` to your frontend's exact origin in production (defaults to
`*`).

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

## Redis

Hyperworker connects to a regular Redis server (not a REST-based service) via
`REDIS_URL`, using the standard `redis://` protocol. Redis is used for:

- the per-tenant state snapshots and `bot:updates` pub/sub channel consumed
  by a UI (see [Observability](#observability)), and
- the `bot:lock` singleton lock described below.

Run it side by side with the app rather than as an external managed service:

- **Locally:** `docker run -p 6379:6379 redis:7-alpine`, then
  `REDIS_URL=redis://localhost:6379`.
- **On Railway:** add Railway's official **Redis** template as a second
  service in the same project as this app. Railway exposes that service's
  connection string as `REDIS_URL` on the Redis service itself; reference it
  from this app's service variables with
  `REDIS_URL=${{Redis.REDIS_URL}}` (substitute the actual service name if
  you rename it). Because both services live in the same Railway project,
  the connection stays on Railway's private network — no public exposure or
  extra egress needed.

Redis connection errors are logged but never crash the process on their
own — reconnection is handled by the Redis client. A lost lock renewal
(e.g. because Redis was unreachable for longer than the lock TTL) causes the
engine to exit for safety per the singleton constraint below, and Railway's
restart policy brings it back up against a fresh lock.

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
   short-TTL lock (`bot:lock`) in Redis and renews it every loop. If a
   second instance starts (e.g. during a rolling deploy overlap) and can't
   acquire the lock, it logs an error and exits immediately rather than
   racing the incumbent. If the active instance crashes without releasing
   the lock, it expires automatically after 30 seconds so a replacement can
   take over.

On graceful shutdown (`SIGTERM`/`SIGINT`) the engine finishes its in-flight
loop iteration, releases the Redis lock, and exits — it never cancels any
resting stop order as part of shutdown, since the whole point is that
protection must survive restarts and deploys.

## Observability

- A JSON state snapshot is written to Redis at `bot:state:<address>` every
  loop for each tenant, and the tenant's address is added to the
  `bot:tenants` set for discovery. On any change to a tenant's state, the
  snapshot is also published to the `bot:updates` channel.

  ```json
  {
    "address": "0xabc...",
    "coin": "BTC",
    "price": 97234.5,
    "position": { "side": "long", "size": 0.1, "entryPx": 95000.0 },
    "stop": { "triggerPx": 95289.6, "orderId": 12345 },
    "trail": { "type": "abs", "value": 500, "enabled": true },
    "lastAction": "moved stop 95100 -> 95289.6",
    "updatedAt": "2026-07-17T10:31:02Z"
  }
  ```

- `HEALTHCHECK_URL` (optional; e.g. a [healthchecks.io](https://healthchecks.io)
  check) is pinged once per loop — a dead-man's switch that fires if the
  process hangs or crashes. Set the check's grace period to a few multiples
  of `POLL_MS`. If left unset, the heartbeat ping is skipped entirely (a
  warning is logged once at startup).
- Structured logs are emitted via `pino`, with every tenant's log lines
  bound to its account `address`.
- Alerts (warn/error level logs) fire on: a stop being moved, any error, and
  position-opened / position-closed transitions.

## Push notifications on position changes

When a tenant's position is opened, modified (its size or side changes while
it stays open), or closed, Hyperworker sends a
[web-push](https://www.npmjs.com/package/web-push) notification directly to
every browser that subscribed via the companion dashboard PWA — no HTTP call
back into the dashboard is involved.

- **Subscription source:** the dashboard writes each browser's subscription to
  a Redis hash at `push:subs:<address>` (address lowercased). The field is the
  subscription `endpoint` URL and the value is the `JSON.stringify`'d
  subscription (`{ endpoint, keys: { p256dh, auth } }`). Hyperworker only reads
  and prunes this hash; the dashboard owns writes.
- **Triggers:** all three transitions are detected in the same state loop that
  emits the matching `position_opened` / `position_closed` alerts:
  - **Opened** — a tenant goes from flat to holding a position.
  - **Modified** — an already-open position's size (or side) changes between
    polls, e.g. when adding to or partially reducing a position.
  - **Closed** — the position transitions from open to flat. PnL is estimated
    from the last-known position (`entryPx`, `size`, `side`) against the
    current mid price at the moment the close is observed, so it is an
    approximation of realized PnL, not the exact fill.
- **Payload:** matches what the dashboard's service worker expects —
  `{ title, body, url, tag }`. `tag` is `"<address>:<coin>:open"`,
  `"<address>:<coin>:modify"`, or `"<address>:<coin>:close"` so repeated
  notifications of the same kind collapse into one on supported platforms.
- **Stale-subscription cleanup:** if a send fails with `404`/`410` the
  subscription is gone/expired and is `HDEL`'d from the hash; other failures
  are logged and the endpoint is left in place.

Configure the VAPID keys to enable it (see [`.env.example`](.env.example)):

```
VAPID_PUBLIC_KEY=<same key as dashboard's NEXT_PUBLIC_VAPID_PUBLIC_KEY>
VAPID_PRIVATE_KEY=<private key, worker-only>
VAPID_SUBJECT=mailto:you@example.com
```

Generate a keypair once with `npx web-push generate-vapid-keys`. The public key
**must match** the dashboard's `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, since browsers
subscribed using that key. If any of the three variables is unset, push is
disabled (logged once at startup) and the rest of the engine runs unchanged.

## Local development

```bash
docker run -d --name hyperworker-redis -p 6379:6379 redis:7-alpine
cp .env.example .env
# fill in .env with testnet credentials (REDIS_URL=redis://localhost:6379 works out of the box)
npm install
npm run dev
```

## Deploying to Railway

1. In your Railway project, add Railway's **Redis** template as its own
   service (New → Database → Redis, or "Deploy a Template" → Redis).
2. Push this repo to a Git provider Railway can access, and create a second
   service in the same project from that repo — it will build from the
   included `Dockerfile` and apply [`railway.json`](railway.json)
   (`numReplicas: 1`).
3. Set all environment variables from `.env.example` on this app's service,
   pointing `REDIS_URL` at the Redis service via a variable reference (e.g.
   `REDIS_URL=${{Redis.REDIS_URL}}`). Set `API_AUTH_TOKEN` to a long random
   string and `CORS_ORIGIN` to your frontend's origin.
4. Deploy. Confirm in the logs that reconciliation ran successfully for
   every tenant before considering the deploy healthy.
5. To let the frontend reach the [Trading API](#trading-api), generate a public
   domain for this service (Settings → Networking → Generate Domain). Railway
   sets `PORT` automatically and routes the domain to it — do not hard-code
   `PORT`. Because the singleton lock means only the live instance ever serves,
   there is no risk of a second replica answering trade requests.

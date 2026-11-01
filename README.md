# P2P Energy Trading Demo — four platforms on a real Beckn/onix network

Four independent web apps trade solar energy with each other over a **real,
locally-running Beckn 2.0 network** (signed messages, schema validation, OPA/rego
contract policy, real settlement maths) — not a mock or a replay.

| App | URL | Who it is |
|---|---|---|
| **Seller Platform** | http://localhost:4002 | A prosumer. Publishes offers, accepts / counters / declines bids, reports delivery. |
| **Buyer Platform** | http://localhost:4001 | An independent buyer. Buys directly or bids; can negotiate a counter-offer. |
| **Aggregator Platform** | http://localhost:4003 | Pools one or more sellers' offers into a block, prices it, sells it, pays each seller from their own meter reading. |
| **Grid/DISCOM Platform** | http://localhost:4004 | The demand side. Posts a bulk requirement and buys the block built for it. |

Every dashboard has a **wallet** in its header — click it for the full
transaction history and the exact calculation behind every rupee.

You only need this one repository. `npm run setup` downloads the upstream
`beckn/DEG` devkit at a pinned commit and layers our changes on top (the two
extra onix adapters for the Aggregator and the DISCOM, routing, Caddy, compose
and the amended contract policy — all in [`network/overlay/`](network/README.md)).

---

## Quick start (fresh machine)

**You need:**

| | |
|---|---|
| **Docker** | Docker Desktop (Windows / macOS) or Docker Engine + the Compose v2 plugin (Linux). Must be **running**. ~8 GB RAM free recommended; first start pulls ~1 GB of images. |
| **Node.js 22.5+** | The apps use the built-in `node:sqlite`. `node -v` to check. |
| **Git** | To clone, and for setup to fetch the upstream devkit. |
| **Internet** | The adapters fetch Beckn schemas and talk to the public IES catalog/ledger. |
| *(optional)* **cloudflared** | Only for the Buyer's *Discover offers* button — see below. |

**Free ports:** 4001–4004 (apps), 8099 (policy server), 8081, 8083–8086, 9000,
18082, 18084, 18085, 3003, 3004 (Docker network).

```bash
git clone https://github.com/Sanjay-dev22/p2p-trading-demo-app.git
cd p2p-trading-demo-app
npm run setup      # ~15 s: pinned devkit + our overlay + npm install for the four apps
npm run up         # starts Docker network, policy server, and the four apps
```

Then open the four URLs above (ideally side by side). Check anything with
`npm run status`; stop with `npm run down` (or `npm run down:all` to stop Docker too).

> **First publish / first request after a start is slow** (10–30 s). The
> adapters download Beckn JSON-LD schemas live and cache them in memory. Do one
> throw-away publish before presenting, then **Reset**.

### What works without a tunnel (everything except one button)

The Buyer's **Discover offers** asks the *shared public* catalog, which must
call you back on a public URL. Without one, that button returns nothing. All of
this works **without** it:

- Seller → Buyer direct trades: copy the offer ID from the Seller dashboard
  (**Copy ID**) and paste it into the Buyer's **Buy directly / place a bid**.
- The whole Aggregator ↔ Grid/DISCOM flow, wallets, delivery, withdrawals.

To enable Discover too: install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(free, no account) and run `npm run up:tunnel`. Quick-tunnel URLs change every
run, so re-run it after any restart.

---

## Commands

| Command | Does |
|---|---|
| `npm run setup` | One-time: fetch devkit (pinned), apply overlay, `npm ci` in each app. Re-runnable. |
| `npm run up` / `npm run up:tunnel` | Start everything (idempotent — safe to re-run). |
| `npm run status` | Health of every app and adapter. |
| `npm run reset` | Wipe all four dashboards to empty (same as any **Reset demo** button). |
| `npm run down` | Stop the four apps + policy server. `npm run down:all` also stops Docker. |
| `npm test` | 99-check end-to-end suite against the live stack. **Resets the demo first and last.** |

Logs are in `.run/*.log`; each app also keeps its data in a `*.db` file in its
own folder (delete those, with the apps stopped, for a hard reset).

---

## Presenting it (≈15 minutes)

Start from a clean state (`npm run reset`). Do one throw-away publish first.

### Act 1 — direct peer-to-peer trade (Seller ↔ Buyer)
1. **Seller:** Quantity `10`, Price `9` → **Publish offer**. Click **Copy ID**.
2. **Buyer:** paste the ID into *Buy directly / place a bid*, bid `8` → **Send bid**
   (or, with a tunnel, **Refresh offers** and use the card).
3. **Seller:** the bid appears under *Incoming requests* → **Send counter-offer** at `8.5`.
4. **Buyer:** **Accept counter — confirm**. Both sides go **Active**.
5. **Seller:** **Report delivery & settle**, deliver `9` of `10` kWh. Show the
   breakdown (energy, wheeling ₹0.50/kWh each side, shortfall penalty ₹2.50/kWh).
   Click **Show trace** for the signed message timeline. Click the **wallet** for history.

### Act 2 — the aggregator serving a DISCOM
1. **Seller:** publish three small offers, e.g. `5 @ ₹7`, `8 @ ₹7.5`, `6 @ ₹9.5`.
2. **Grid:** *Post a requirement*: `15` kWh, max `₹10`/kWh.
3. **Aggregator:** the offers are already listed (live from the Seller platform);
   on the requirement click **Recommend pool → Apply recommendation to pool**.
   Note the *"How the block price is calculated"* breakdown, then **Publish pooled block**
   (*Serve requirement* is pre-selected).
4. **Grid:** **Buy available energy** (the block is reserved for this DISCOM — the Buyer app cannot take it).
5. **Aggregator:** **Suggest readings** (one seller falls short) → **Report delivery**.
   Expand a seller row for their own calculation; open the **wallet** history for the whole chain
   (buyer paid → aggregator received → each seller → margin kept).
6. **Seller:** the pooled sellers' wallets were credited with their own share; their payout panel shows why.

### Act 3 — "what if supply is short?"
Post a requirement bigger than the pool (e.g. `100` kWh): the aggregator publishes what it can,
the Grid shows **PARTLY COVERED** with the unmet remainder, and a later top-up block can be
bought the same way. Also try **Withdraw unsold** (capacity returns to the sellers — their offers are never touched)
and a block built from a **single** large seller.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm run up` says Docker daemon not running | Start Docker Desktop and wait for it to say *running*. |
| `docker compose up` fails on a port | Something else holds one of the ports above. Stop it, or edit the left-hand number in `network/DEG-repo/devkits/p2p-trading-ies-wave2/install/docker-compose.yml` and set the matching env var (`ONIX_SELLER_URL`, `ONIX_BUYER_URL`, `ONIX_AGGREGATOR_URL`, `ONIX_GRID_URL`) before `npm run up`. *(On the original dev machine Windows' Edge held 8082, which is why the seller adapter is published on **18082**.)* |
| Seller "Publish offer" → `network error reaching http://localhost:1808x…` | The apps can't reach their adapter. `npm run status`; the adapter container may still be starting (wait ~30 s) or the port differs from the env var. |
| Buyer **Discover** shows nothing | Expected without a tunnel — use **Buy directly** or `npm run up:tunnel`. If you used a tunnel earlier it is dead after a restart; re-run `npm run up:tunnel`. |
| Everything very slow the first time | Schemas are downloaded live then cached (see note above). |
| Corporate network / proxy | Configure Docker Desktop's proxy for image pulls, and `npm config set proxy …` for setup. The compose file already sets `NO_PROXY` for the local test hostnames. |
| Linux: adapters can't reach the apps | Handled — the compose file maps `host.docker.internal` via `extra_hosts`. Make sure the apps listen on all interfaces (they do by default) and no host firewall blocks 4001–4004 / 8099 from Docker's bridge. |
| Windows: `bad interpreter` / CRLF errors | `.gitattributes` forces LF for config files; if you cloned with an old Git config, re-clone or `git add --renormalize .`. |
| A dashboard looks stale | Polls every 4–5 s. Click **Reset demo** if state got confusing. |

---

## What's where

```
seller-app/ buyer-app/ aggregator-app/ grid-app/   the four Node apps (Express + SQLite + WebSocket)
network/overlay/        every change we made to the upstream devkit (see network/README.md)
network/DEG-repo/       downloaded by `npm run setup` (gitignored — not our code)
scripts/                setup.js, demo.js (up/down/status/reset/test), policy-server.js
tests/e2e.js            the 99-check end-to-end suite
KNOWLEDGE-BASE.md       engineering history: every bug, decision and incident (read this before changing logic)
ARCHITECTURE.md         original pre-build design doc (history only)
```

## Honest limits

- **One of each platform.** There is a single aggregator, so a DISCOM can't yet shop one requirement across several.
- **Meter readings are typed in** by the aggregator operator (there is no smart-meter feed); the settlement maths driven by them is real and per-seller.
- **Wallets are a settled-cash ledger** derived from real settled trades — not a payment rail.
- The Aggregator and DISCOM adapters **reuse the Seller's and Buyer's already-registered signing keys** (`sellerapp.example.com` / `buyerapp.example.com`) rather than new registered identities; see `network/README.md` and `KNOWLEDGE-BASE.md` §9 for why that is safe here.
- The contract policy is a **locally-amended copy** (real shortfall penalty, price-sanity band, FIRM/BEST_EFFORT) served from `:8099`; the production DeDi policy source stays allowed too.

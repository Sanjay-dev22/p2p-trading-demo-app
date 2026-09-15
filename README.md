# P2P Trading Demo App

Two real, independent web apps — a **Seller Platform** and a **Buyer
Platform** — that trade real solar energy over the real local Beckn/onix
network (`ies-devkit/devkits/p2p-trading-ies-wave2`), replacing the
`fidedocker/sandbox-2.0` fixture-replay stub the devkit ships with.

See `ARCHITECTURE.md` for the (currently shelved, future) production-grade
design, and `DEMO-APP-PLAN.md` for the design this actually implements.

## What's real here

Every message (`catalog/publish`, `discover`, `init`, `on_init`, `confirm`,
`on_confirm`, `on_status`) is a genuine, signed Beckn v2 call through the
real `onix-buyerapp`/`onix-sellerapp` adapters — real schema validation,
real `.rego` policy enforcement (including a real live rejection path),
real settlement math. Nothing is scripted or replayed; every number in the
UI came from a real HTTP round trip started by an actual click.

**Storage**: SQLite (one file per app, `seller-app/seller-app.db` /
`buyer-app/buyer-app.db`) — no external DB server. **Live updates**: a
plain WebSocket per app — no Redis, no job queue. **Auth**: none — you
operate both platforms yourself, exactly like the underlying devkit's own
demo does.

## One-time setup

The Beckn network itself lives in the working devkit copy at
`p2p-trading/DEG-repo/devkits/p2p-trading-ies-wave2/` (not the read-only
reference clone under `ies-devkit/`). Its `install/docker-compose.yml` has
`sandbox-buyerapp`/`sandbox-sellerapp` commented out, and
`config/local-p2p-trading-routing-{BuyerApp-BapReceiver,SellerApp-BppReceiver}.yaml`
repointed at `host.docker.internal:4001`/`:4002` — this app's own ports —
instead of those containers.

```bash
cd p2p-trading/DEG-repo/devkits/p2p-trading-ies-wave2/install
docker compose up -d
docker compose ps   # confirm everything is Up/healthy — no sandbox-buyerapp/sandbox-sellerapp rows
```

Install each app's dependencies once:
```bash
cd p2p-trading-app/seller-app && npm install
cd ../buyer-app && npm install
```

## Running the demo

Two terminals, from `p2p-trading-app/`:
```bash
cd seller-app && npm start   # http://localhost:4002
cd buyer-app  && npm start   # http://localhost:4001
```

Open both URLs — ideally side by side, two browser windows. Live updates
push over WebSocket in both directions; nothing needs a manual refresh.

## The demo script

1. **Seller** (`:4002`): type a quantity/price, click **Publish offer**.
   This really calls `catalog/publish` on `onix-sellerapp`.
2. **Buyer** (`:4001`): paste that offer's id into "Buy directly / place a
   bid" (or wait — "Discover offers" fires a real `discover` too, though
   the shared discovery service it hits doesn't reliably echo back a very
   recent publish in this sandbox — see the honesty note below). The bid
   price field is prefilled with the seller's real ask but is editable —
   leave it as-is to buy outright, or lower it to negotiate. Click
   **Send bid**. This fires a real, signed `init` carrying that price as
   the buyer's actual bid.
3. **Seller**: the request appears live in "Incoming requests," showing the
   bid against the seller's own current ask. Three real outcomes, not one:
   - **Accept bid** — sends a real `on_init` echoing the buyer's terms.
   - **Send counter-offer** — sends a real `on_init` with the seller's own
     price/quantity instead (same message shape, different numbers).
   - **Decline** — no onix call at all (a BPP simply never answering an
     `init` is valid Beckn behavior); the buyer is told directly over a
     small app-to-app notification endpoint, since there's no real
     NACK-shaped `on_init` to send for this.
4. If the seller countered, the buyer sees "Seller countered: ₹X/kWh for Y
   kWh" with **Accept counter** (sends a real `confirm`) or **Decline
   counter** (no network message; the seller is notified the same way as
   step 3's decline). If the seller's `on_init` matched the original bid
   exactly, this step is skipped — `confirm` fires automatically, exactly
   as a plain accept always has.
5. Once confirmed, seller auto-sends `on_confirm` on receiving `confirm`.
   Both dashboards flip to **Active**, live.
6. **Seller**: the active trade shows a **Report delivery & settle** form
   prefilled with a suggested, editable meter reading (85%–105% of what was
   agreed) — this is the seller's real smart-meter reading after physical
   delivery, which real settlement always pays on. Submitting sends a real
   `on_status` using whatever quantity was actually agreed (the counter
   terms, if there was one). Both dashboards flip to **Settled**, live,
   with the real computed ₹ amount.
7. **The rejected path**: on the buyer's form, set "Trade as" to
   **Blocked discom** before bidding. The real `contractpolicyenforcer`
   step on `onix-sellerapp` NACKs it live, with the real, specific,
   human-readable policy violation message — not a canned error.
8. **Full protocol trace**: any trade row's **Show trace** toggle expands
   every real Beckn hop logged for that transaction (`init`, `on_init`,
   `confirm`, `on_confirm`, `on_status`, plus any decline) with its
   direction, timestamp, and the actual raw payload sent or received —
   nothing simulated, each row is written at the moment the real
   send/receive happened.
9. **Filters**: the buyer's discovered-offers list has live price/quantity
   range filters, a sort dropdown, and an "only buyable" toggle — purely
   client-side narrowing of what `/api/offers` already returns.

## Honesty notes (read before demoing)

- **Discover is best-effort.** The real shared discovery service
  (`34.93.165.42.sslip.io`) is a different real backend than the one
  `catalog/publish` hits (`fabric.nfh.global`) — a quirk already flagged
  in Grid Pulse. In testing, a `discover` call gets accepted by onix but
  no `catalog` callback reliably arrives. "Buy directly" (typing the offer
  id) is the reliable path — this mirrors how the original scripted demo
  worked too (`discover` and the trade steps were always independent
  workflows, never actually chained).
- **Settlement math is computed twice, deliberately.** The real
  `contractpolicyenforcer` plugin on `onix-sellerapp` independently
  evaluates the linked `.rego` policy against whatever `on_status` payload
  it receives. This app also computes the same `FINAL_ALLOC × PRICE_PER_KWH`
  formula itself, purely so the seller's own UI has an amount to display
  immediately (the real settlement flow has no callback *to* the seller
  after it sends `on_status` — there'd be nothing to display otherwise).
  Both use the identical, already-verified formula.
- **Two real bugs were caught by the real system while building this**,
  not invented for effect: an `init` message needs `AVAILABLE_QTY`
  declared in `payloadDescriptors`, and `SettlementTerm`'s real schema
  lives at `.../SettlementTerm/v2.0/attributes.yaml` — the devkit's own
  example fixture omits the `v`. Both are fixed in `beckn.js` on each
  side.

## Resetting between demo runs

Stop both `npm start` processes, then delete the SQLite files:
```bash
rm seller-app/seller-app.db* buyer-app/buyer-app.db*
```
Restart — both dashboards come up empty.

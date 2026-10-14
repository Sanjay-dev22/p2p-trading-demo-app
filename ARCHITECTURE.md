# P2P Trading App — Architecture

**Status: planning only. No scaffolding has been started — build begins only when
explicitly told to.**

This document is the agreed design for a **real, full-stack P2P energy trading
application**, built on top of the existing local Beckn/onix Docker network
(`ies-devkit/devkits/p2p-trading-ies-wave2`). It replaces the current stub
sandbox apps with two independently-built platforms, without touching any of
the protocol infrastructure underneath them.

This folder (`p2p-trading-app/`) is a **new, separate workspace** for that
build. It is not the same thing as the existing `p2p-trading/` folder at the
DEG root, which remains the active workspace for the already-finished demo +
Grid Pulse visualizer (RUNBOOK, demo-logs, guides) — that work is done and
untouched by this.

---

## 1. What's actually running today, underneath the sandbox

Verified directly from the devkit source before writing this document:

- `sandbox-sellerapp` and `sandbox-buyerapp`, in
  `ies-devkit/devkits/p2p-trading-ies-wave2/install/docker-compose.yml`, are
  both the **same stock image**: `fidedocker/sandbox-2.0` — a generic
  reference tool from the Beckn tooling ecosystem, not a real application.
- It has no database, no UI, and no real business logic.
- It answers `init` / `confirm` / `on_status` by looking up a **static JSON
  fixture file** keyed by `context.networkId` + persona
  (`responses/sellerapp/on_init.json`, `on_confirm.json`) and replaying it
  verbatim.
- The seller's "ledger routing" is literally injected via a Docker
  environment variable (`SELLER_LEDGER_URI=...`) baked into the fixture at
  container startup (`docker-compose.yml` lines ~116–141).

Everything *below* this stub — the `onix-buyerapp` / `onix-sellerapp`
adapters (`bapTxnCaller`/`bapTxnReceiver`/`bppTxnCaller`/`bppTxnReceiver`),
`beckn-router` (Caddy), `contractpolicyenforcer`, `degledgerrecorder`, the
discom ledger sandboxes, the real DeDi registry lookups, and the real
`.rego` policy fetch — is genuinely real, already verified, and **stays
exactly as-is**. This build only replaces the two boxes above.

---

## 2. The one architectural decision that determines everything else

**Build this as two completely independent, separately-owned platforms —
not one shared app wearing two hats.**

This isn't a stylistic preference — it's the only version that's actually
*correct*, because it mirrors how Beckn/DEG is designed to work in the real
world: every participant on the network deploys, owns, and operates their
own software. A DISCOM's procurement desk and a rooftop-solar prosumer's app
are built by different teams, on different stacks, with different
databases, and the *only* thing connecting them is the protocol messages
passing through the router. The fact that we control both sides here is a
demo convenience, not something the architecture should assume or bake in.

Concretely: **no shared database, no shared backend, no "god object" that
peeks at both sides' state.** Each platform only ever knows what the Beckn
messages it received actually told it — same as it would if a real,
unrelated third party were on the other end. That constraint is what makes
the eventual "swap in a real counterparty" step trivial instead of a
rewrite.

---

## 3. High-level architecture

```
┌─────────────────────────────┐                    ┌─────────────────────────────┐
│   BUYER PLATFORM (new)      │                    │   SELLER PLATFORM (new)     │
│  ─────────────────────────  │                    │  ─────────────────────────  │
│  Web dashboard (Next.js)    │                    │  Web dashboard (Next.js)    │
│  Buyer API + webhook (Node) │◄──── Beckn msgs ───►│  Seller API + webhook (Node)│
│  Postgres (own DB)          │   via beckn-router  │  Postgres (own DB)          │
│  Job worker (async matching)│      (Caddy,         │  Job worker (settlement)    │
└──────────────┬───────────────┘   untouched)        └──────────────┬───────────────┘
               │ replaces                                            │ replaces
               ▼                                                    ▼
      sandbox-buyerapp (stub)                              sandbox-sellerapp (stub)
               │                                                     │
               ▼                                                    ▼
      onix-buyerapp (untouched: bapTxnCaller/Receiver — signs, validates, routes)
                                                          onix-sellerapp (untouched: bppTxnCaller/Receiver)
                                                                      │
                                                          contractpolicyenforcer, degledgerrecorder (untouched)
                                                                      │
                                              onix-ledger-buyerdiscom / -sellerdiscom (untouched)
                                                                      │
                                                    real DeDi registry, real .rego policy, real IES ledger (untouched)
```

Each platform talks to its *own* onix adapter over the same webhook contract
the stub currently implements (`/api/webhook/init`, `/api/webhook/confirm`,
`/api/webhook/status`, etc. — same interface, real logic behind it) and
*initiates* outbound calls the same way the stub's `npm start` process
currently would, just driven by real user action in a dashboard instead of a
canned script.

---

## 4. Per-side component breakdown

Each of the two platforms gets the same shape, independently:

| Layer | What it does |
|---|---|
| **Frontend** (Next.js/React) | The actual dashboard a human uses |
| **API + webhook service** (Node/TypeScript — matches the existing onix/sandbox stack) | Implements the inbound webhook contract onix calls into (`on_init`, `on_confirm`, `on_status` handlers become real code, not fixture lookups); exposes an internal API the frontend calls; fires outbound Beckn calls (`init`, `confirm`) through its own onix adapter when a user takes an action |
| **Postgres** (own instance, own schema) | Persists everything real — see data model below |
| **Async worker** | Beckn is ACK-now/answer-later — a queue-backed worker (BullMQ + Redis, reusing the Redis container pattern already in the compose) is what turns "an on_confirm callback arrived" into "update the dashboard, notify the user," decoupled from the HTTP request that received it |
| **Auth** | Real login, real RBAC — see §7 |

---

## 5. Data model

Minimum real schema, same shape on both sides (contents differ by role):

- `organizations` — the legal entity operating this platform (a DISCOM, or a
  prosumer aggregator)
- `users` — real accounts, roles (`trader`, `ops`, `compliance-viewer`,
  `admin`), scoped to an organization
- `meters` / `assets` — the physical thing generating or consuming (rooftop
  array, DISCOM feeder) — this is what eventually produces real
  `FINAL_ALLOC` numbers
- `catalogs` / `offers` (seller side) — what's actually listed, editable by
  a real user, not a static JSON blob
- `transactions` — one row per `transactionId`, the spine everything else
  hangs off — this *is* the concept Grid Pulse already visualizes, just now
  persisted instead of scripted
- `contracts` / `commitments` — mirrors the Beckn `contract`/`commitments`
  structure, tracks status transitions (`DRAFT → ACTIVE → COMPLETE`) as they
  really happen
- `settlements` — mirrors `settlementAttributes`, tracks `PENDING →
  SETTLED`
- `ledger_entries` — this platform's *own* copy of what it believes
  happened — deliberately separate from the discom ledger cascade, so a
  real reconciliation step (comparing your own record against the cascaded
  ledger copy) is possible later, exactly like a real accounting system
  would want
- `audit_log` — every state change, who/what/when, immutable —
  non-negotiable for anything positioning itself as government/regulator-
  facing

---

## 6. What each dashboard actually needs

These are genuinely different products, not the same UI with a different
color scheme.

### Seller Platform — a prosumer / aggregator's app
- **List an offer**: real form (quantity, price per slot, meter selection) →
  replaces hardcoded `PAY.publishCatalog`
- **Incoming requests inbox**: every `init` that arrived, live, with the
  buyer's discom identity shown plainly, and whether the policy engine would
  even allow it *before* committing (a "would this pass?" pre-check, reusing
  the real `.rego` policy lookup — big trust-building UX win)
- **Active contracts view**: status per contract, real-time (via the async
  worker + websocket/SSE push, not polling)
- **Delivery reporting**: where `FINAL_ALLOC` gets entered or ingested — see
  §7
- **Earnings/settlement view**: real running total, reconciled against what
  the ledger cascade actually recorded
- **Own ledger/audit export**: CSV/PDF, because a real seller (or their
  accountant, or a regulator) will ask for one

### Buyer Platform — a DISCOM procurement desk's app
- **Discover/search**: real filter UI on top of the real JSONPath `discover`
  mechanism — not a hardcoded query
- **Compare offers**: multiple sellers, multiple price bands, side by side
- **Initiate → confirm workflow**: a real multi-step trade flow with an
  explicit "you are about to commit to this" confirmation, not a
  fire-and-forget script
- **Portfolio/exposure view**: how much energy is currently committed across
  how many active contracts — this is the kind of view a real trading desk
  actually lives in
- **Settlement/payment view**: what's owed, what's been paid, reconciled
- **Compliance/audit export**: same non-negotiable as the seller side

### A third piece worth planning for now, not bolting on later: a Network Operator / Regulator console
A read-only, network-wide view of *every* trade happening across *all*
participants, not just your own. This is a natural evolution of Grid Pulse
itself: instead of replaying 31 scripted hops, it becomes a live feed of
real `transactionId`s as they actually occur — exactly the kind of oversight
layer a real regulator (or the IES Secretariat) would expect to exist before
trusting a network with real money.

---

## 7. The three "real vs. simulated" decisions to make explicitly, before writing code

1. **Metering** — real settlement needs a genuine `FINAL_ALLOC` number that
   differs from the request. Recommend a small, honest **meter simulator
   service**: generates plausible delivered-quantity data on a timer,
   deliberately *not* claiming to be a real smart meter integration. Keep it
   clearly labeled as such in the UI (same honesty standard as Grid Pulse's
   IES-ledger caveat).
2. **Payments** — the current fixture's `payTo`/bank fields are fully fake.
   Recommend keeping a real internal ledger (double-entry, in your own
   Postgres) as the source of truth, with an explicitly mocked "payment
   rail" behind it for now — architected so a real payment gateway is a
   swap-in later, not a rewrite.
3. **Identity/KYC** — app-level login (who's allowed to trade on behalf of
   which organization) is a separate concern from the protocol-level
   Ed25519 signing onix already does. Don't conflate them — a real
   prosumer's *account* and a real prosumer's *signing key* are different
   trust boundaries.

---

## 8. Suggested build order

Mirrors how a real regulated pilot gets staged, not just "MVP first":

1. **Phase 1 — replace the stub, keep it boring**: real DB + real backend +
   minimal UI on both sides, just enough to do exactly the same
   publish→discover→init→confirm→settle flow Grid Pulse already shows, but
   driven by real user clicks instead of a script. No meter simulator yet,
   no auth yet — prove the wiring first.
2. **Phase 2 — real auth + RBAC** on both platforms.
3. **Phase 3 — meter simulator** feeding genuinely-varying `FINAL_ALLOC`.
4. **Phase 4 — settlement reconciliation UI** (comparing own ledger vs.
   cascaded discom ledger copy).
5. **Phase 5 — Network Operator console**, evolving Grid Pulse.
6. **Phase 6 — hardening**: audit export, compliance views, real
   payment-gateway swap-in point, load/observability.

**No phase begins until explicitly told to start it.**

---

## 9. Open questions to resolve before Phase 1 starts

- Exact tech stack confirmation: Next.js + Node/TypeScript + Postgres +
  Redis/BullMQ, matching the existing onix/sandbox stack for consistency —
  confirm before scaffolding.
- Where these two new services live in the existing `docker-compose.yml` —
  as direct replacements of the `sandbox-buyerapp`/`sandbox-sellerapp`
  service blocks, or as new services alongside them during transition.
- Whether Phase 1's UI is genuinely two separate deployable apps from day
  one, or one monorepo with two clearly-separated packages (recommended:
  the latter, for local dev convenience, while keeping runtime deployment
  fully independent per §2).

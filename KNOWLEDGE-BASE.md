# P2P Trading Demo — Full Knowledge Base

This is the reference document for how the whole live P2P energy trading
stack actually works end to end: Beckn protocol, onix (BAP/BPP adapters),
the real external sandbox network, our two demo apps, the policy-fix
patches, and every operational gotcha found by direct investigation
(container logs, raw curl, Playwright) rather than assumption. Read this
before re-diagnosing anything from scratch.

Two other docs exist alongside this one — don't confuse them:
- `ARCHITECTURE.md` (this folder) — the *original planning doc* for
  building these two apps, written before they existed. Historical only.
- `GITHUB REPO/p2p-trading-live-demo/README.md` — the pushed, public
  write-up of the CLI/RUNBOOK version of this same devkit. Audience-facing.

This file is neither — it's the internal "how does this actually work and
what have we had to fix" reference.

---

## 1. The stack, layer by layer

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  Seller Platform (Node)  │        │  Buyer Platform (Node)   │
│  seller-app/ :4002       │        │  buyer-app/ :4001         │
│  server.js + beckn.js    │        │  server.js + beckn.js     │
└──────────┬───────────────┘        └──────────┬────────────────┘
           │ HTTP (host-side)                   │ HTTP (host-side)
           ▼                                    ▼
  onix-sellerapp :18082→8082          onix-buyerapp :8081
  (bppTxnCaller/Receiver)             (bapTxnCaller/Receiver)
           │                                    │
           └──────────────┬─────────────────────┘
                           ▼
                  beckn-router (Caddy) :9000
          virtual-hosts sellerapp.example.com,
          buyerapp.example.com, *-discom*.example.com
          → reverse-proxies to the matching onix container
                           │
        ┌──────────────────┼──────────────────────┐
        ▼                  ▼                      ▼
  onix-sellerdiscom  onix-buyerdiscom     onix-ledger-seller/buyerdiscom
  (contractpolicyenforcer, degledgerrecorder on these + seller/buyerapp)
        │
        ▼
  REAL EXTERNAL SERVICES (not ours, not local):
  - discover → https://34.93.165.42.sslip.io/beckn/discover   (sandbox Gateway)
  - publish  → https://fabric.nfh.global/beckn/catalog/publish (catalog cache)
  - schemas  → https://schema.nfh.global/.../*.jsonld + *.yaml (JSON-LD validation)
  - registry → subscribers.beckn.one (Ed25519 keyset lookups)
  - ledger   → https://ies-p2p-energy-ledger.beckn.io (real, independently queryable)
  - policy   → https://api.dedi.global/... (real) OR our local override (below)
```

12 containers total (`docker compose ps` in
`p2p-trading/DEG-repo/devkits/p2p-trading-ies-wave2/install/`):
`beckn-router`, `onix-buyerapp`, `onix-sellerapp`, `onix-buyerdiscom`,
`onix-sellerdiscom`, `onix-ledger-buyerdiscom`, `onix-ledger-sellerdiscom`,
`redis-bap`, `redis-bpp`, `redis-buyerdiscom`, `redis-sellerdiscom`,
`redis-ledger`, `sandbox-ledger-buyerdiscom`, `sandbox-ledger-sellerdiscom`.

**Everything above "beckn-router" is real, genuinely-signed Beckn 2.0
protocol traffic.** This is not a mock network — `discover`/`publish` leave
the machine and hit real internet hosts shared by whoever else is testing
against the same sandbox (`networkId:
indiaenergystack.in/test-ies-p2p-trading-network`).

---

## 2. How a hostname like `sellerapp.example.com` actually resolves

This confused us until we read `install/Caddyfile` directly. It is **not**
Docker service-name DNS and **not** a real public domain. The mechanism:

1. `beckn-router`'s docker-compose service is given **network aliases**
   (`sellerapp.example.com`, `buyerapp.example.com`,
   `sellerdiscom.example.com`, etc.) on the internal Docker networks
   (`bap_side`, `bpp_side`).
2. Any container on those same networks that tries to connect to
   `http://sellerapp.example.com:9000/...` actually reaches the
   `beckn-router` container (Caddy), because Docker's embedded DNS
   resolves that name to the router's IP via the alias.
3. Caddy then does **virtual-host routing**: it looks at the `Host:`
   header and reverse-proxies to the real target —
   `sellerapp.example.com:9000` → `onix-sellerapp:8082`.

**This only works for containers already on the same Docker network.**
From the host machine or the public internet, `sellerapp.example.com`
does not resolve to anything (it's not a real domain). This single fact
explains a lot of behavior below — see §4.

---

## 3. The Beckn message flow, hop by hop

1. **`catalog/publish`** (BPP → network): seller-app calls its local
   `onix-sellerapp`, which signs the message and **pushes the full catalog
   content directly to `fabric.nfh.global`** (a push/cache model — the
   whole offer body goes in the POST, not just a pointer).
2. **`discover`** (BAP → network): buyer-app calls `onix-buyerapp`, which
   signs and sends the request to **the real sandbox Gateway**
   (`34.93.165.42.sslip.io`). The request carries a `bapUri` — the address
   the Gateway must call back on to deliver results.
3. **`on_discover`** (network → BAP, async): the Gateway POSTs results back
   to whatever `bapUri` was given. **This callback has to be reachable
   from the public internet** — if `bapUri` points at something only
   reachable from inside the Docker network, this callback silently never
   arrives and `discover` looks permanently broken (empty results forever,
   no error) — see the incident in §5.
4. **`init` / `confirm`** (BAP → BPP, direct): the buyer's `onix-buyerapp`
   forwards straight to `http://sellerapp.example.com:9000/bpp/receiver/...`
   — resolved via the Caddy-alias trick in §2, so this **only needs the
   two apps to be on the same Docker network**, never the public internet.
5. **`on_init` / `on_confirm` / `on_status`** (BPP → BAP, direct): same
   mechanism in reverse, via `buyerapp.example.com:9000`.
6. Each onix container also calls back into **its own local demo app**
   over a plain host-side webhook:
   `http://host.docker.internal:4002/api/webhook/<action>` (seller),
   `http://host.docker.internal:4001/api/bap-webhook/<action>` (buyer).
   This is how `server.js` in each app learns "an `init` arrived" etc.

**Net effect: only step 2/3 (discover) ever needs real internet
reachability. Every other hop in a trade's lifecycle is Docker-internal.**

---

## 4. The policy engine (contractpolicyenforcer / OPA-rego)

- Every offer's `contractAttributes.policy.url` names a `.rego` file and a
  `queryPath` (`data.deg.contracts.p2p_trading`).
- `contractpolicyenforcer` (a Go plugin inside the onix pipeline) fetches
  that URL, evaluates it with the real message as input, and either
  **injects** computed values (e.g. `revenueFlows` on `on_status`) or
  **enforces** (rejects) based on the result.
- **Real production policy**:
  `https://api.dedi.global/dedi/lookup/indiaenergystack.in/ies-rulesets/p2p-trading-ies-contractpolicy-common`
  — resolved through the real DeDi registry.
- **Our local-amended override** (used for the Gap 1/4/12/wheeling fixes):
  `http://host.docker.internal:8099/p2p-trading-ies-wave2-contractpolicy-local-amended.rego`,
  served by a plain `python -m http.server 8099` run from
  `p2p-trading/DEG-repo/devkits/p2p-trading-ies-wave2/policies/`.
- **`allowedPolicyUrlPrefixes`** (in both `config/local-p2p-trading-*.yaml`,
  several occurrences each) is an explicit allowlist gate — any policy URL
  not matching a listed prefix is rejected/ignored. Our override had to be
  added there (`http://host.docker.internal:8099`) alongside the real DeDi
  prefix.
- **Policy cache (critical gotcha)**: the enforcer caches whatever it
  fetches, keyed by URL, for a long TTL (≥24h). **Editing the `.rego` file
  on disk does nothing until the cache expires or the onix containers are
  restarted.** Always
  `docker compose restart onix-sellerapp onix-buyerapp onix-buyerdiscom onix-sellerdiscom`
  after changing the policy content, and re-verify live.
- The amended policy currently fixes:
  - **Gap 1** — real non-zero delivery-shortfall penalty
    (`penalty_rate_per_kwh = 2.50`), was hardcoded to `0.0` upstream.
  - **Gap 4** — price-sanity band (`min_price_per_kwh = 6.00`,
    `max_price_per_kwh = 15.00`); upstream had no bound at all (a real
    0.01 INR/kWh offer used to pass every check).
  - **Gap 12** — FIRM vs. BEST_EFFORT commitment distinction; penalty only
    applies if `commitmentType == "FIRM"`, so an unstored-solar shortfall
    isn't punished like a battery breaking a firm promise.
  - **Wheeling charges** — `wheeling_charge_buyer_per_kwh` /
    `wheeling_charge_seller_per_kwh = 0.50` each (both were `0.0`
    upstream); applied per-kWh-delivered, deducted from the seller's
    payout and added to the buyer's cost.

### Settlement math (verified live, 2026-10-14)
For a 20 kWh offer @ ₹12.5/kWh with 19.4 kWh actually delivered
(shortfall 0.6 kWh):
```
base            = 19.4 × 12.5         = ₹242.50
penalty         = 0.6 × 2.50          = ₹1.50    (seller-side deduction)
seller wheeling = 19.4 × 0.50         = ₹9.70    (seller-side deduction)
buyer wheeling  = 19.4 × 0.50         = ₹9.70    (buyer-side addition)

seller receives = 242.50 − 1.50 − 9.70 = ₹231.30
buyer pays      = 242.50 + 9.70        = ₹252.20
```
The ₹20.90 gap between what the buyer pays and the seller receives nets
out exactly across `penalty` + `buyerDiscom` wheeling + `sellerDiscom`
wheeling — this is the real 4-role `revenueFlows` array
(`seller`/`buyer`/`buyerDiscom`/`sellerDiscom`) the policy injects into
the `on_status` message, not a 2-party split.

**Design quirk to remember**: the synchronous HTTP response any caller
gets back from onix (e.g. `POST /bpp/caller/on_status`) is only a bare
`{"message":{"ack":{"status":"ACK"}}}`. The real computed
`revenueFlows`/settlement numbers only ever appear in the *forwarded*
message to the next hop, never echoed back to whoever triggered the call.
This is why `seller-app/server.js` has its own `computeSettlement()` that
duplicates the rego math in JS — it has no other way to show the real
number immediately in its own UI. Keep the two in sync if the rego
changes.

---

## 5. Incident (2026-10-14): "the app is broken, discover doesn't work, it's slow" — root causes and fixes

Two independent, unrelated bugs had stacked on top of each other after
restarting Docker Desktop + the apps from a cold state:

### Bug A — seller-app pointed at the wrong onix port
`seller-app/server.js` and `beckn.js` hardcode
`ONIX_SELLER_URL` default to `http://localhost:8082`. An earlier session
had remapped `onix-sellerapp`'s **host-side** port to `18082` in
`docker-compose.yml` (an unrelated Windows process — Edge WebView2 — had
grabbed 8082), but nothing in the app itself was updated to match.
Every "Publish offer" click failed with
`network error reaching http://localhost:8082/bpp/caller/catalog/publish: fetch failed`.
**Fix**: start seller-app with `ONIX_SELLER_URL=http://localhost:18082`
(or revert the compose remap if port 8082 is free again — check with
`Get-NetTCPConnection -LocalPort 8082`).

### Bug B — the real root cause of "discover doesn't work"
Per §3 step 2/3, `discover`'s `bapUri` must be a **real, currently-live,
publicly reachable URL** for the Gateway to deliver `on_discover` back.
`buyer-app/beckn.js` reads this from `public-bap-uri.txt` (gitignored,
read once at process start — see `readPublicBapUriFile()`). That file
held a **dead Cloudflare quick-tunnel URL from a previous session** —
quick tunnels (`cloudflared tunnel --url ...`) are fully ephemeral and get
a brand new random `*.trycloudflare.com` subdomain every single run;
nothing persists across a restart. Every discover request went out, the
Gateway tried to call back a URL that no longer existed, and
`on_discover` simply never arrived — no error anywhere, just permanently
empty results.
**Fix**: start a fresh tunnel (`cloudflared tunnel --url http://localhost:8081`
— port 8081 is `onix-buyerapp` itself, not the buyer-app dashboard),
write the new URL into `buyer-app/public-bap-uri.txt`, restart
`buyer-app`. Verified live: `on_discover` webhook arrived within seconds,
97 real offers came back from the shared sandbox catalog (see §6),
including our own just-published one.

### "Slow" — partly real, partly by design, not a bug to fix
- The dashboard UI polls `/api/offers`, `/api/trades`, `/api/earnings`
  every **5 seconds** by explicit design
  (`setInterval(refreshAll, 5000)` in `seller-app/public/index.html`) —
  comment explains this avoids a naive re-render wiping in-flight edits.
  Expect up to a 5s lag between an action and it appearing on screen.
- Beckn JSON-LD schema validation fetches
  (`https://schema.nfh.global/.../context.jsonld` +
  `.../attributes.yaml`) happen **live, over the real network, serially,
  per `@type`**, the first time each type is seen after a container
  restart (several seconds each — e.g. `EnergyResource`, `EnergyTradeOffer`,
  `DEGContract`, `EnergyCustomer`, `DiscomLedgerProvider`,
  `BecknTimeSeries` are all separate fetches on a fresh `publish`). This
  is in-memory LRU-cached after first use, but the cache doesn't survive a
  container restart. Expect the *first* publish/discover after any
  restart to be noticeably slower than subsequent ones.
- None of this is a regression from our fixes — it's inherent to the
  devkit's real-network, real-schema-validation design.

### Confirmed NOT broken
- `init`/`confirm`/`on_status` never needed a public tunnel at all (§3
  step 4/5) — they were unaffected by Bug B and kept working once Bug A
  was fixed, routed entirely via the Caddy-alias mechanism in §2.
- The Network Dashboard (`buyer-app`'s `/network.html`) was never itself
  broken — it only looked empty because `discover` (Bug B) fed it nothing
  to show. Once fixed, it correctly rendered the full shared offer pool
  and 9 real ledger-verified historical trades, independently queried
  from `https://ies-p2p-energy-ledger.beckn.io`.

### Operational checklist after any Docker Desktop / machine restart
None of the following survive a restart and must be redone manually —
docker-compose only manages the 12 containers, not these host-side
companions:
1. Start Docker Desktop, wait for `docker info` to succeed.
2. `docker compose up -d` in
   `p2p-trading/DEG-repo/devkits/p2p-trading-ies-wave2/install/`.
3. Restart the local policy file server:
   `python -m http.server 8099` from `.../policies/`.
4. Restart `seller-app` (`node server.js`, with `ONIX_SELLER_URL` set to
   whatever `onix-sellerapp`'s current host port actually is — check
   `docker-compose.yml` first, don't assume 8082).
5. Start a **fresh** `cloudflared tunnel --url http://localhost:8081`,
   write the URL into `buyer-app/public-bap-uri.txt`, *then* start
   `buyer-app` (order matters — it reads the file once at startup).
6. Restart `aggregator-app` (`node server.js`, port 4003) and `grid-app`
   (`node server.js`, port 4004) — since aggregation-v2, `onix-
   aggregatorapp` and (since Phase 2) `onix-gridapp` are real `docker
   compose up -d` containers like the others (`docker compose up -d
   onix-aggregatorapp onix-gridapp beckn-router` — the router needs
   recreating too, since the Caddy hostname aliases live on it) and do
   **not** need their own `ONIX_*_URL` override (their host ports, 18084
   and 18085, are already free by default).
7. Optionally, fresh tunnels for the dashboards themselves
   (`localhost:4002`, `localhost:4001`, `localhost:4003`, `localhost:4004`)
   if sharing links externally.
8. Do one real `publish` → `discover` → `init` → `confirm` →
   `report delivery & settle` round-trip and check the live numbers
   reconcile (§4 math) before calling it "working." For the aggregation-v2
   path specifically, also confirm the published block is **absent** from
   seller-app's own `/api/offers` and present only in aggregator-app's own
   — that's the one regression worth actually checking for, since it's the
   whole point of the separation. For Phase 2, also confirm a `grid-app`
   purchase's `init`/`confirm` land on `onix-gridapp` (check its container
   logs), not `onix-buyerapp`.

---

## 6. Things that look like bugs but aren't

- **Discover returns 90+ offers.** The shared sandbox catalog
  (`networkId: indiaenergystack.in/test-ies-p2p-trading-network`) is
  global and cumulative across every session anyone has ever run against
  it — there's no reset. Use the exact Offer ID copy-paste workflow (or
  the "Only buyable (ours)" filter) to find your own offer rather than
  scrolling.
- **Seller's `bppUri` (`SELF_URI` in `seller-app/beckn.js`) is a hardcoded
  fake hostname with no env/file override**, unlike the buyer's
  `PUBLIC_BAP_URI` mechanism. This is fine and intentional — per §3,
  `init`/`confirm` only ever need Docker-internal reachability via the
  Caddy-alias trick, never the public internet, so the seller side never
  needed a tunnel-based override in the first place.
- **Buyer's dashboard shows a cost increase after delivery, seller's
  shows a decrease.** Both are correct — see the settlement math in §4.
  They are not supposed to match; the gap is the discom wheeling charges
  plus any penalty.
- **The seller's own `/api/deliver` response doesn't match the "real"
  settlement at first glance** if you only read the synchronous onix
  response — see the "Design quirk" callout at the end of §4. Always read
  `server.js`'s own `computeSettlement()` output or the final dashboard
  state, not the raw ACK.

---

## 7. Key file locations

| What | Path |
|---|---|
| Devkit (sparse clone, gitignored) | `p2p-trading/DEG-repo/devkits/p2p-trading-ies-wave2/` |
| Docker compose | `.../install/docker-compose.yml` |
| Beckn router config | `.../install/Caddyfile` |
| Onix app configs (allowlists, routes) | `.../config/local-p2p-trading-{sellerapp,buyerapp,aggregatorapp,gridapp}.yaml` |
| Aggregator's own routing file (new, aggregation-v2) | `.../config/local-p2p-trading-routing-AggregatorApp-BppReceiver.yaml` |
| Grid-app's own routing files (new, Phase 2) | `.../config/local-p2p-trading-routing-GridApp-{BapReceiver,BapCaller,BppReceiver,BppCaller}.yaml` |
| Local-amended policy | `.../policies/p2p-trading-ies-wave2-contractpolicy-local-amended.rego` |
| Example payloads (ground truth for schemas) | `.../uc1/examples/*.json` |
| Seller demo app | `p2p-trading-app/seller-app/` (`server.js`, `beckn.js`, `public/index.html`) — port 4002 |
| Buyer demo app | `p2p-trading-app/buyer-app/` (`server.js`, `beckn.js`, `public/index.html`, `public/network.html`) — port 4001 |
| Aggregator demo app | `p2p-trading-app/aggregator-app/` (`server.js`, `beckn.js`, `peers.js`, `public/index.html`) — port 4003, own onix instance + full lifecycle since aggregation-v2, see §9 |
| Grid/DISCOM demo app | `p2p-trading-app/grid-app/` (`server.js`, `beckn.js`, `db.js`, `public/index.html`) — port 4004, own onix instance + executes the real buy itself since Phase 2, see §9 |
| Public BAP URI override | `p2p-trading-app/buyer-app/public-bap-uri.txt` (gitignored, regenerate every restart) |
| Pushed/public version of this fix | `GITHUB REPO/p2p-trading-live-demo/patches/` + its `README.md` |

---

## 8. How the physical layer actually works — faults, capacity limits, telemetry, aggregation, hardware control

This devkit is a **commercial/settlement layer only**. It has no channel to
any physical hardware today, and by design, it shouldn't. Everything in
this section explains the real-world systems that sit *underneath* and
*around* it — the ones that actually measure, detect, and (where relevant)
control electricity — so a gap write-up (§4, and Gaps 9/13/14/15/16 in
`presentation/P2P-Gaps-Defense-Prep.md`) can cite the real mechanism instead
of a guess.

### 8.1 How a fault or "electricity didn't really flow" is detected

Two independent signals, neither invented by this devkit:

- **Did the energy actually move?** The smart meter's own measured kWh for
  the interval — that's the ground truth. `FINAL_ALLOC` < `REQUESTED_QTY`
  is just arithmetic once the real reading exists.
- **Why didn't it move?** Needs a second, independent source:
  - **Grid-side outage** (feeder tripped, DISCOM maintenance): real smart
    meters already send a **"last-gasp"** event — using the meter's own
    backup capacitor, it fires one final "power loss" message the instant
    line voltage drops, and a "power restored" message when it returns
    (a standard DLMS/COSEM event, already deployed, not new). Separately,
    the DISCOM's own **Outage Management System (OMS)** / SCADA logs every
    known outage per feeder/transformer (they need this for their own
    SAIDI/SAIFI reliability reporting to the regulator). A `GRID_OUTAGE`
    exemption (Gap 9) should be verified against **both** — the meter's
    last-gasp (proves this premises lost power) and the OMS record (proves
    it was a recognized grid event, not an isolated fault or theft).
  - **The prosumer's own equipment fault** (their inverter/battery died):
    the DISCOM's OMS has no visibility into this at all — it's behind the
    meter, on the customer's own gear. There is no independent system of
    record for it, which is exactly why Gap 9 only *caps* `EQUIPMENT_FAULT`
    claims per quarter instead of trusting them outright.

### 8.2 The "watcher" — what AMI/telemetry actually is, concretely

The real pipeline: **meter** → a comms module (cellular/RF mesh) → the
DISCOM's **Head-End System (HES)**, which collects readings from every
meter → a **Meter Data Management system (MDM)**, which cleans the raw
readings (the industry term is **VEE** — Validate, Estimate, Edit) → any
downstream system (billing, or this trading platform) queries the MDM.

"Constantly watching the meters" doesn't mean continuous video-style
streaming — it means reading this feed at the cadence it's already produced
(today, ~15-minute blocks under India's smart-meter rollout) instead of
only asking once at the very end of a multi-hour delivery window. Gap 15
isn't asking for new hardware or new monitoring capability — both already
exist — it's asking for this trading software to actually subscribe to a
feed it currently ignores until settlement time.

### 8.3 Verifying a seller's export-capacity / "I can give more, faster" claim

The number isn't something a prosumer or this app gets to declare freely.
Every grid-tied rooftop installation in India needs DISCOM approval before
it can export at all, and that approval specifies a **sanctioned
capacity** (e.g. "this connection may export up to 5 kW") — calculated by
the DISCOM from what the local transformer/feeder can safely absorb given
everyone else sharing that line. That number lives in the DISCOM's own
interconnection records (their Customer Information System) — today
completely invisible to this devkit; nothing in a trade message checks a
declared quantity against it.

A stronger, hardware-level version of the same ceiling often also exists:
many real inverters are configured (via SunSpec Modbus, or IEEE 2030.5 in
more advanced markets) to physically refuse to export above the sanctioned
value, independent of what the panels could produce — a ceiling that
doesn't depend on anyone being honest, because the device itself won't do
it.

So the real check (Gap 14) is: at publish/offer time, validate the declared
export quantity against the DISCOM's own sanctioned-capacity record for
that specific meter — reject any offer claiming more instantaneous kW than
that connection is actually approved for. "Faster" hits the same ceiling —
kW is kW regardless of how quickly it's delivered, and a battery/inverter
physically cannot exceed its rated/sanctioned output. (A separate, smaller
detail — maximum *rate of change* of output, to avoid inrush stress — only
really matters for frequency-regulation-grade fast response, not ordinary
P2P trades; not worth over-engineering for this use case.)

### 8.4 Does the aggregator idea actually have value?

Two distinct reasons, and the second is the more important one:

1. **Minimum lot size.** A single rooftop might produce 3–5 kWh a day — far
   below what a large industrial buyer or a power exchange (India's IEX
   trades in much larger blocks) will bother contracting for directly.
2. **Risk pooling (the real reason VPPs work).** One rooftop's output is
   unpredictable — clouds, a voluntary shutdown, an equipment fault. The
   *sum* of a thousand independent rooftops is statistically far more
   predictable, because individual randomness mostly cancels out (a basic
   law-of-large-numbers effect). This is why aggregators can sell something
   close to a **firm** commitment to a grid operator even though no single
   constituent rooftop is individually firm — aggregation is solving a
   "too unreliable to promise anything" problem, not just a "too small"
   one, the same way insurance pools individual risk.

Concretely, in this architecture an aggregator would be its own
participant: it looks like a **buyer** to many small prosumers (enrolling
and collecting their individual offers) and a **seller** to the one large
buyer (offering one pooled, larger, statistically-reliable block) — a
pass-through role, the same shape as a produce distributor buying from many
small farms and selling one reliable truckload to a supermarket chain.

### 8.5 Can — or should — this software ever control physical hardware?

**No, and it shouldn't.** This stack exchanges messages about commitments
and reads meter data after the fact; it has no channel to an inverter or
battery today, and building one directly into a commercial/settlement layer
would be a design mistake, not a feature to aspire to.

Real physical control of DER hardware already exists as a separate,
purpose-built system: a **DERMS (Distributed Energy Resource Management
System)**, operated by the DISCOM, which talks to enrolled devices using
real protocols — **IEEE 2030.5** (used in California's Rule 21),
**SunSpec Modbus** for inverters, **OpenADR** for demand-response signals,
or a vendor's own API (Tesla, Enphase, SolarEdge). Underneath even that,
every real inverter has **local safety logic that runs with zero network
connection** — anti-islanding, over/under-voltage trip, frequency trip —
mandated by grid codes (India's CEA technical standards, IEEE 1547
elsewhere), because the device must protect the grid even if every
software layer above it is unreachable.

The realistic integration path, if a commitment like Gap 13's curtailment
instruction ever needed to affect real hardware: this trading platform
calls the DISCOM's own DERMS API to say "this commercial commitment now
requires curtailment" — and DERMS, which already owns the device
relationship and the safety certification, is what actually issues the
device-level command. This software's job stops at that commercial
boundary; it never reaches into the device itself.

**If asked in review "does your software turn off my solar panel":** the
correct, confident answer is no — hardware control is a separate,
safety-certified system (DERMS) that already exists at each DISCOM; this
platform integrates with it via a clearly-scoped API boundary, it doesn't
replace it.

---

## 9. The aggregator-app demo — pooling small offers into one block

A third demo app, `p2p-trading-app/aggregator-app/` (port 4003), alongside
seller-app and buyer-app. Grounded directly in the real IES P2P trading
implementation guide
(`ies-devkit/docs/implementation-guides/v2/P2P_Trading/
P2P_Trading_implementation_guide_DRAFT.md`), which names this exact
mechanism: *"Virtual meters enable aggregators to balance supply and
demand across multiple participants."*

### Why it talks to seller-app/buyer-app's REST APIs, not onix directly

Both onix-buyerapp's and onix-sellerapp's webhook targets are fixed, once,
in their own config — `onix-buyerapp` always delivers callbacks to
buyer-app (port 4001), `onix-sellerapp` always delivers to seller-app
(port 4002), regardless of who actually sent the original request. If
aggregator-app called `/bap/caller/discover` on `onix-buyerapp` directly,
the real `on_discover` callback would still land at buyer-app, not here —
this app would never see its own answer. Same story for publish: any
offer published through `onix-sellerapp` becomes seller-app's own incoming
request the instant a buyer inits against it, no matter who published it.

So `aggregator-app/peers.js` treats seller-app and buyer-app as what
`ARCHITECTURE.md` §2 already says every real participant is: an
independent platform with its own real REST API — the same pattern
buyer-app's own `resolveOffer()` already uses against seller-app.
Discovering means asking buyer-app what it has already discovered
(`POST /api/discover` then `GET /api/offers`). Publishing the pooled block
means asking seller-app to publish it through its own, already-working
`POST /api/publish` — the pooled block becomes one of seller-app's real
catalog offers, tradeable and settled through its existing, already-
verified lifecycle, completely untouched.

### The flow

1. Pool ≥2 real discovered offers (`POST /api/pool/enroll`).
2. Publish the block (`POST /api/pool/publish`) — computes
   `blendedPrice = quantity-weighted average of enrolled prices`, adds a
   declared margin (default ₹0.30/kWh), and calls seller-app's own
   `/api/publish` with the pooled total quantity and that price. The real
   offerId seller-app assigns becomes this block's own id.
3. A bulk buyer (unmodified buyer-app) discovers and buys it like any
   other offer — the whole real lifecycle (init → on_init → confirm →
   on_confirm → report delivery → on_status) runs through seller-app's
   existing dashboard, operated exactly as already verified earlier in
   this project.
4. Once seller-app's own `/api/trades` shows that trade `SETTLED`,
   `aggregator-app` disaggregates the one real settlement amount back to
   each pooled seller, at **their own original price** (not the marked-up
   blended one), proportional to their enrolled share of the block's
   actual delivered quantity — the difference between what the bulk buyer
   paid and the sum paid out to members is the aggregator's own captured
   margin, shown explicitly, never hidden in a single opaque number.

### Known, disclosed simplifications (see also `GET /api/about`)

- Reuses seller-app's/buyer-app's real onix identities rather than
  registering as its own distinct network participant (the real
  production design needs its own onix instance + registry entry).
- Pools once, at publish time — no re-aggregation as individual sellers'
  availability changes mid-window.
- A simple sum of enrolled quantity, not a confidence-adjusted ("firm
  capacity") lower bound.
- Disaggregates the block's one real delivered-quantity reading
  proportionally across members — there's no per-member smart meter in
  this demo; a real deployment would use each member's own real reading,
  per the "virtual meter" reconciliation approach the real IES
  implementation guide describes.

### Status as of this write-up

**Fully verified live, end to end, 2026-10-14.** Full stack brought back
up (14 containers + policy server + a fresh buyer-app tunnel), three real
small offers published (10 kWh@₹12, 8 kWh@₹13, 6 kWh@₹11.50), pooled
(24 kWh, blended ₹12.21), published as one block at ₹12.51 (margin
₹0.30), discovered and bought by the real bulk buyer, accepted, confirmed
(real async on_confirm round-trip), delivered (22.8 kWh — a genuine 1.2
kWh shortfall), and settled. Every number hand-verified against the real
running system, not asserted:

| Quantity | Value | Checked against |
|---|---|---|
| Blended pool price | ₹12.21 | (10×12 + 8×13 + 6×11.5) / 24 |
| Block price | ₹12.51 | blended + ₹0.30 margin |
| Seller-side settlement | ₹270.83 | seller-app's real computeSettlement: 285.23 − 11.40 (wheeling) − 3.00 (penalty) |
| Buyer-side settlement | ₹296.63 | buyer-app's own recorded amount: 285.23 + 11.40 (buyer-side wheeling) |
| Disaggregation to 3 pooled sellers | ₹109.25 + ₹95.00 + ₹62.70 = ₹266.95 | each member's own price × their proportional delivered share, minus their own wheeling |
| Aggregator's realized margin | ₹3.88 | ₹270.83 − ₹266.95 (not the intended ₹7.20 — the shortfall penalty ate into it) |

One real bug found and fixed during this pass: the `blocks` table's
`bulk_transaction_id`/`bulk_settlement_amount`/`settled_at` columns were
defined but nothing ever wrote to them (the UI worked anyway because it
recomputed live every call) — fixed with `persistSettlementIfNew()`,
re-verified after restart.

### New risks the aggregator role introduces — found during this live pass

These are new failure modes specific to adding an aggregating intermediary
— not re-statements of the original 24 gaps, though #1 is structurally the
same shape as Gap 7.

1. **PROVEN LIVE, not theorized: pooling an offer never reserves its
   capacity.** After the block above was fully sold and settled, all three
   original offers (`offer-demo-e348977f`, `-351b3524`, `-a7e4ccc8`) still
   showed their full original `remaining_qty` (10, 8, 6 kWh), completely
   untouched. Right now, any other real buyer on the shared network could
   independently discover and buy one of those same offers in full — the
   same capacity promised twice, the same shape as Gap 7, reintroduced by
   the aggregator layer itself. Fix mirrors Gap 7's own fallback: mark an
   offer's capacity reserved/excluded the moment it's pooled, not only
   when a real Beckn trade lands against it.
2. **Who bears the shortfall penalty, confirmed precisely:** the real
   settlement math only ever deducts the penalty from the "seller" role's
   receivable; the buyer's payable never includes it. Because the
   aggregator publishes under seller-app's own borrowed identity, the
   network-level "seller" bearing that penalty **is the aggregator**, not
   any individual pooled member — confirmed by this run: each pooled
   seller was paid for their own proportional share at their own price,
   with no penalty passed down to them at all; the aggregator's margin
   absorbed the entire shortfall cost. Real-world-consistent (this is
   literally the risk a VPP/aggregator is paid a margin to take on) — but
   a **flat per-kWh margin has no relationship to the real risk being
   absorbed**. Proven in this run: a 5% shortfall cut the intended ₹7.20
   margin to ₹3.88 realized. A larger shortfall could push the margin
   negative — the aggregator losing money on a trade it was supposed to
   profit from — and nothing in v1 protects against that.
3. **Shortfall blame is smeared equally across every pooled member,
   regardless of who actually under-delivered.** Only one aggregate
   `finalAlloc` exists for the whole block (no per-member telemetry in
   this demo), so the 5% shortfall above was applied identically to all
   three sellers' shares — even though it's entirely possible only one of
   them actually underperformed while the other two delivered in full. A
   seller who delivered 100% of their own commitment is currently paid as
   if they, too, fell short, purely because someone else in the pool did.
   The real fix is exactly what the real IES guide's own "virtual meter"
   concept implies: a genuine per-member reading feeding the
   reconciliation, not one blended number.
4. **No real, durable, protocol-level record ties the settled trade back
   to which real sellers were actually pooled.** That mapping exists only
   in `aggregator-app`'s own private SQLite file. If that file were lost,
   or the aggregator operator dishonest, nothing in the real signed Beckn
   messages or the real external ledger records the pooling relationship
   at all — no independent way for a pooled seller or a regulator to
   verify or enforce what was actually owed.
5. **Directly following from #4: nothing actually compels the aggregator
   to pay the pooled sellers at all.** The disaggregation table is a
   correct, honestly-computed number — but it is purely informational.
   Nothing in this demo (or, as far as the schema evidence shows, in the
   real devkit either) obligates the aggregator to transfer that money to
   the real underlying sellers once the bulk settlement lands in its own
   account. This is the single biggest new trust/accountability gap the
   aggregator role introduces: a brand-new intermediary the protocol has
   no enforcement mechanism for at all.

### Two more real bugs, found by actually using the dashboards, now fixed

6. **PROVEN LIVE: `available-offers` showed every real offer on the shared
   sandbox, not just our own — and let them be pooled and "sold."** The
   discover response's `seller_id` field is the devkit's own generic
   tutorial identity (`sellerapp.example.com`), not a unique one — real,
   unrelated testers on the shared network never renamed it either.
   Before this fix, the aggregator trusted that string alone, so all ~100+
   accumulated offers from every other tester who ever used this devkit
   looked identical to "ours." A block was actually published and sold
   this way during testing, built almost entirely from offers that were
   never really the operator's to repackage. Fixed with the exact check
   `buyer-app`'s own `resolveOffer()` already uses for the same reason:
   cross-check the offer_id against seller-app's own live `/api/offers`
   catalog, not the seller_id string. Applied at three points, not one —
   `available-offers` (excludes foreign offers before they can even be
   selected), `pool/enroll` (re-verifies server-side, never trusts the
   client alone), and `pool/publish` (re-verifies again right before
   publishing, since time passes and someone else could buy part of a
   pooled offer directly in the meantime — see risk #1 above).
7. **Generic "onix rejected the X" errors hid the real, useful reason.**
   A ₹2/kWh publish attempt returned only `"onix rejected the publish"`,
   while the real NACK — `"PRICE_PER_KWH 2 is outside the published band
   6-15 INR/kWh (below minimum)"` — was sitting unread in the response
   body the whole time. `buyer-app`'s own `/api/buy` handler already had
   the right extraction (`result.json.message.error.message`, falling back
   to raw text, falling back to the HTTP status); every other onix-facing
   route in all three apps now uses the same `extractOnixError()` pattern.
   No frontend changes were needed — all three dashboards already read
   `body.error` correctly; they were just never given the real message to
   show.

### Aggregation v2 (2026-10-15): real separation + demand-driven matching + Grid/DISCOM

Built after actually using the v1 aggregator-app dashboard surfaced three
real architectural problems, not just UI polish: the pooled block showed up
**inside seller-app's own dashboard** (because v1 published it through
seller-app's own `/api/publish`, which also wrote it into seller-app's own
catalog DB); it was unclear who should own the block's lifecycle afterwards
(v1 routed accept/deliver back through seller-app); and pooling was
**supply-first and arbitrary** — pool whatever small offers exist, publish,
hope a buyer appears, with nothing representing the large-buyer/grid side
distinctly from an ordinary P2P buyer.

Verified via web research before redesigning, not guessed: **FERC Order
2222** (US DER aggregation into wholesale markets) and **Piclo Flex** (UK
flexibility market) both confirm real aggregation is **demand-first** (a
grid/large-buyer posts a requirement; the aggregator matches pooled
resources against it) and that individual small resources never transact
directly in the market — only the aggregator's bundled offer does, under
the aggregator's own distinct identity.

**The separation mechanism — no new DeDi registration needed.** Beckn
separates `bpp_id` (the signing/registry identity) from `bppUri` (just a
routing address). `onix-aggregatorapp` is a brand-new, independent onix
adapter container (`install/docker-compose.yml`,
`config/local-p2p-trading-aggregatorapp.yaml`) that **reuses
`sellerapp.example.com`'s already-registered signing keys verbatim** — the
same `keyId`/`signingPrivateKey` as `onix-sellerapp` — so no new DeDi
subscriber record or namespace-owner approval was needed (confirmed
required only for a genuinely new identity, per
`ies-devkit/devkits/README.md`'s "Create DeDi registry records... Ask the
network namespace owner"). Only the *routing* is new: a new Caddy hostname
`aggregatorapp.example.com` (`install/Caddyfile`) pointing at
`onix-aggregatorapp`, and a new routing file
(`config/local-p2p-trading-routing-AggregatorApp-BppReceiver.yaml`)
forwarding incoming select/init/confirm/status to aggregator-app's own
process (`host.docker.internal:4003/api/webhook`) instead of seller-app's.
`aggregator-app/beckn.js` is a new file (adapted from seller-app's) that
publishes and signs through this instance directly — the block is
genuinely aggregator-app's own catalog entry from the moment it's
published; seller-app never sees it again.

**One load-bearing fix this required in `buyer-app`, found while wiring it
up:** `buyer-app/beckn.js`'s `buildInit()` **hardcoded** the seller's
`bppId`/`bppUri` for every purchase — harmless while there was only ever
one real seller identity, but it would have silently routed every `init`
to `onix-sellerapp` regardless of which onix instance actually published
the offer, meaning the whole separation would have been invisible to the
buy-side. Fixed by making `bppUri` an override parameter (`bppId` itself
stays `sellerapp.example.com` either way — that's the shared signing
identity, not the routing target), and having `resolveOffer()` in
`buyer-app/server.js` check **both** seller-app's and aggregator-app's own
live catalogs (`/api/offers`) before falling back to the stale
`discovered_offers` cache, returning the right `bppUri` for whichever one
actually has the offer.

**aggregator-app now owns the block's entire real lifecycle itself** —
its own `/api/webhook/:action` (init auto-accepted, since the block's
price was already fixed at publish time — no counter-offer feature here,
a disclosed simplification), its own `computeSettlement` (identical
formula to seller-app's, duplicated for the same reason: no way to read
the real policy result back synchronously), its own `/api/deliver`, and
its own `remaining_qty` on the `blocks` table (decremented when a bulk
buyer's init is accepted) — so the block itself can't be double-sold. This
does **not** fix the one-level-down gap: the original pooled small offers
on seller-app's own catalog still aren't reserved the moment they're
pooled (see risk #1 above — confirmed still present, unchanged, by design
for this phase).

**Demand-driven matching (Grid/DISCOM → aggregator-app → buyer-app):** a
new `requirements` table + `POST /api/requirements` (posted by the new
`grid-app`, port 4004 — REST-only, no onix identity of its own in this
phase) and `POST /api/requirements/:id/recommend`, which runs a
cheapest-first greedy fill against currently-discoverable real offers, up
to the requirement's quantity, never above its price ceiling, and clearly
flags a shortfall rather than silently proposing a partial match as
complete. The operator still reviews and applies the recommendation
manually (enrolling each picked offer through the existing, already-
verified `/api/pool/enroll`) before publishing — human-in-the-loop
preserved, same as v1's manual pooling. `grid-app` only posts the
requirement; `buyer-app` still executes the real discover/buy/confirm for
the resulting block, unchanged. Giving Grid/DISCOM its own onix identity
to buy directly (mirroring FERC-2222's RTO/ISO-as-buyer more literally) is
a clean, separately-schedulable later phase — nothing built here needs to
be undone to get there.

**Verified live, full round trip (2026-10-15):** seller-app published 3
fresh offers; `grid-app` posted a requirement (20 kWh, ≤₹13/kWh);
`recommend` greedily matched 2 leftover ₹10/kWh offers + the ₹11.50 offer
+ 3 kWh of the ₹12 offer = exactly 20 kWh, blended ₹10.75, all within
ceiling; published as `offer-agg-ecebfa3e` at ₹11.05/kWh (blended + ₹0.30
margin) — confirmed **absent** from seller-app's own `/api/offers` and
present only in aggregator-app's own; buyer-app discovered it with the
correct captured `bpp_uri` (`http://aggregatorapp.example.com:9000/bpp/
receiver`); `init`/`confirm` both landed on aggregator-app's own webhook
(confirmed in its logs), never seller-app's; delivery reported at 19.2 of
20 kWh requested, settled at ₹200.56 (hand-verified exact: tradeValue
212.16 − wheelingSeller 9.6 − penalty 2.0); disaggregated to the 4 pooled
sellers at ₹54.72 / ₹45.60 / ₹63.36 / ₹33.12 (sum ₹196.80, hand-verified
exact against each member's own original price × 0.96 delivery ratio),
aggregator margin realized ₹3.76; `grid-app`'s requirement correctly shows
`PUBLISHED`, linked to the real block id.

### Aggregation v2 Phase 2 (2026-10-15): Grid/DISCOM becomes a real, independent buyer

The user flagged the deferred gap directly: `grid-app` posted the
requirement, but **buyer-app** was the one that actually bought the
resulting block — the party that said "I need this energy" wasn't the
party that transacted for it. This phase closes that gap.

**Investigated first, not guessed:** the devkit already has a
`buyerdiscom.example.com` identity (`config/local-p2p-trading-
buyerdiscom.yaml`) that sounds like the right fit, but it can't be
reused — per its own config comment, its subscriber id is **not
registered** in the testnet DeDi registry, signing is **intentionally
disabled**, and it only has meter-reading modules (`bppTxnCaller`/
`bppTxnReceiver` for `status`/`on_status`), no BAP discover/select/init/
confirm modules at all. Not usable. The real path is the same trick
already proven for `onix-aggregatorapp`: clone **buyer-app's**
already-registered identity (`buyerapp.example.com`) into a second onix
instance (`onix-gridapp`, `config/local-p2p-trading-gridapp.yaml`, host
port 18085) with its own routing hostname (`gridapp.example.com`,
`install/Caddyfile`) — no new DeDi registration.

**Confirmed zero changes needed to `seller-app` or `aggregator-app`.**
Read `aggregator-app/server.js`'s webhook (`init`/`confirm` handling)
and `aggregator-app/beckn.js`: the BPP side never hardcodes buyer-app's
address anywhere — it echoes the incoming `context` straight back into
`buildOnInit`/`buildOnConfirm` and posts to its own `/bpp/caller/
on_init`, which onix's `addRoute` step delivers using the `bapUri`
embedded in that same context. Live-verified: with `grid-app` sending
`init`/`confirm` signed as `buyerapp.example.com` but with `bapUri:
http://gridapp.example.com:9000/bap/receiver`, `onix-aggregatorapp`
correctly routed `on_init`/`on_confirm` back to `onix-gridapp`, not
`onix-buyerapp` — confirmed in `onix-gridapp`'s own container logs
(`Forwarding request to URL: http://host.docker.internal:4004/api/
bap-webhook/on_confirm`). The real IES ledger cascade
(`degledgerrecorder`, role `BUYER`) also kept working unchanged — it's
keyed off the config's own `networkParticipant`/`signingPrivateKey`
fields, not the hostname, so cloning the identity into a second
container cloned the cascade for free.

**`grid-app` gained:** `beckn.js` (adapted from buyer-app's — `SELF_ID`
stays `buyerapp.example.com`, `SELF_URI` is the new
`gridapp.example.com` address; `buildDiscover` and the
`PUBLIC_BAP_URI` tunnel-file plumbing were dropped since grid-app never
runs generic discover — its one job is buying the specific block that
fulfills its own requirement, not browsing a market); `db.js` (`trades`
+ `events`, no `discovered_offers`); and in `server.js`, `POST
/api/requirements/:id/buy` (resolves the linked block via
aggregator-app's own `/api/offers`, sends a real signed `init`) plus
`POST /api/bap-webhook/:action` (`on_init` → auto-confirms immediately,
a disclosed simplification matching aggregator-app's own no-counter-
offer behavior, since grid-app's counterparty never negotiates; `on_confirm`
→ `ACTIVE`; `on_status` → `SETTLED` with the real settlement amount).

**One small, honest addition to `aggregator-app/server.js`:** when a
block's `remaining_qty` reaches 0 in the `init` handler, if a
`requirements` row links to that block, its status flips to
`FULFILLED` — regardless of *which* real buyer (`grid-app` or
`buyer-app`) ends up winning it. This matters because of the disclosed
race condition below; without it, a `PUBLISHED` requirement would sit
there forever even after the capacity it asked for was genuinely sold.

**Disclosed, not engineered around:** `grid-app` and `buyer-app` are
now both real, independent signed buyers that can see the same
publicly-published aggregator block. `aggregator-app`'s existing
`remaining_qty` guard (already built in Phase 1, prevents double-
selling) means whichever confirms first gets it; if `buyer-app` wins,
grid's requirement simply isn't fulfilled by that block, and a fresh
pool can be recommended for it. This matches real flexibility-market
contention (Piclo Flex-style) rather than something to hide. `buyer-app`
itself needed **zero** code changes — it's unaffected, exactly the
point of the fix.

**Verified live, full round trip (2026-10-15), via UI (Playwright) and
API:** seller-app published 3 fresh offers; `grid-app` posted a
requirement (20 kWh, ≤₹13/kWh); aggregator-app recommended/published a
matching block (`offer-agg-...`, tagged to the requirement); `grid-app`'s
dashboard showed a "Buy this block" button, which sent a real signed
`init` through `onix-gridapp` — confirmed (via container logs) the
round trip landed on `onix-gridapp`'s own webhook, not `onix-buyerapp`'s
— auto-confirmed to `ACTIVE`; delivery reported (full qty: settled
₹238.60 buyer-paid / ₹218.60 aggregator-received, hand-verified exact;
shortfall case also tested: 19.6 of 20 kWh delivered → settled ₹233.83
buyer-paid, requirement correctly flipped to `FULFILLED` in both
aggregator-app's and grid-app's own dashboards). `buyer-app` confirmed
completely unaffected throughout (its own `/api/my-offers` endpoint
unchanged, no code touched).

### Aggregation v2 Phase 2 follow-up (2026-10-15): the shortfall/top-up bug, and three more found while fixing it

The user asked directly: "an aggregator can publish less than the grid
requirement only based on available pool, but the grid dashboard can't
accept that — so if hours later a new seller offer comes in, the
aggregator can't republish to match the requirement, and it feels like
a stale blocked pooled offer." Verified live before touching any code
(not taken on faith) — reproduced exactly:

1. **Reproduced:** seller published only 10 kWh; grid posted a 20 kWh
   requirement; `recommend` honestly flagged `fulfilled: false,
   shortfallQty: 10`; nothing stopped `/api/pool/publish` from
   publishing the undersized 10 kWh block anyway, tagging the
   requirement `PUBLISHED`. From there: `grid-app`'s buy flow correctly
   *refused* to buy it (`"Only 10 kWh remains... requirement needs 20
   kWh"` — a real, hard-earned safety check from Phase 2), but the
   aggregator dashboard's "Recommend pool" button was only ever shown
   for `PENDING`/`RECOMMENDED` status, so once `PUBLISHED` there was no
   way back in, ever — exactly the stuck/dead requirement the user
   described.

2. **Root cause:** the whole design assumed one requirement ↔ exactly
   one block. Real flexibility markets (Piclo Flex included) support
   incremental/partial dispatch over time — a requirement should be
   fulfillable by *however many* blocks it takes, not exactly one.

3. **While reproducing it, found three more real bugs by testing
   adjacent paths, not just the one reported:**
   - **Double-countable pooled capacity:** `listAvailableOffers()` only
     excluded an offer while its pool was still pending (`block_id IS
     NULL`) — once published, it dropped out of that exclusion and
     could be recommended into a **second, different** block, since
     seller-app's own `remaining_qty` for that offer was never
     decremented in the first place (the already-disclosed "pooling
     never reserves capacity" gap). This would have let the aggregator
     double-sell the same physical seller capacity across two blocks —
     confirmed live by re-running `recommend` and seeing the identical,
     already-published offers come back as candidates again.
   - **Price ceiling not enforced against the real, margin-inclusive
     block price:** `recommend` only checked underlying small-offer
     prices against the requirement's ceiling, not the final published
     price (blended + margin). Reproduced live: two offers at ₹12.9/kWh
     against a ₹13/kWh ceiling, default ₹0.3/kWh margin → published at
     ₹13.2/kWh, and `grid-app` paid it without complaint — a buyer
     silently paying above its own stated max price.
   - **The ≥2-offer minimum re-created the exact same deadlock one
     layer deeper:** after fixing the first three, topping up a
     partially-fulfilled requirement with the realistic "one new seller
     shows up later" case still failed — `/api/pool/publish` requires
     at least 2 pending pool members, and a single new offer alone
     can't satisfy that, even though the requirement as a whole is
     already a genuine multi-seller aggregation from its first block.

**Fixes, all in `aggregator-app` (`db.js`, `server.js`,
`public/index.html`) and `grid-app` (`server.js`, `public/index.html`):**
- `requirements` gets `fulfilled_qty` (cumulative kWh actually bought,
  across however many blocks); `blocks` gets `requirement_id` (a
  requirement can now have more than one block over time, found via
  `GET /api/requirements/:id/blocks`, new). `FULFILLED` is now driven
  by `fulfilled_qty >= quantity_kwh` on the *requirement*, set in the
  `init` handler, not by one block's `remaining_qty` reaching 0.
- `recommend` matches against `quantity_kwh - fulfilled_qty` (what's
  still needed), not the original full amount, refuses to run on an
  already-`FULFILLED` requirement, and warns (using the default margin
  as a heuristic) when the likely published price would already exceed
  the ceiling.
- `/api/pool/publish` now **hard-rejects** a block whose final price
  (blended + chosen margin) exceeds a linked requirement's ceiling, and
  refuses to publish another block against an already-`FULFILLED`
  requirement. The ≥2-offer minimum is relaxed to ≥1 specifically when
  `requirement.fulfilled_qty > 0` (a genuine top-up of an
  already-multi-seller aggregation, not a fresh "one seller relabeled
  as a block").
- `listAvailableOffers()` now excludes an offer the moment it's **ever**
  been enrolled (any row in `pool_members`, not just pending ones) —
  closing the double-sell path. Unenrolling (pre-publish only) still
  correctly frees it back up.
- The aggregator dashboard's "Recommend pool" button now shows for
  anything short of `FULFILLED` (was: only `PENDING`/`RECOMMENDED`) —
  this is the actual, direct fix for the user's "stale blocked pooled
  offer" complaint. Both dashboards show "`X` of `Y` kWh bought so far."
- `grid-app`'s `/api/requirements/:id/buy` no longer assumes one block:
  it fetches every live block tied to the requirement, re-checks each
  one's price against the ceiling (defense in depth, not just trusting
  aggregator-app's publish-time check), buys cheapest-first across
  however many it takes to cover what's still needed, and honestly
  reports a remaining shortfall instead of erroring outright if only
  partial capacity is available. No longer blocked by an earlier trade
  already existing for the same requirement.

**Verified live (2026-10-15), the user's exact scenario end to end:**
10 kWh published (of a 20 kWh ask) → bought in full, honest shortfall
reported, requirement stayed `PUBLISHED` with `fulfilled_qty: 10` (not
stuck, not falsely `FULFILLED`) → a new 10 kWh seller offer appeared
("hours later") → `recommend` correctly matched only the *remaining*
10 kWh → published as a **second** block tied to the same requirement
from a single new offer (confirming the ≥2-minimum relaxation) → bought
→ requirement correctly flipped `FULFILLED` at `fulfilled_qty: 20`.
Separately verified: an oversized 20 kWh block against a 15 kWh
requirement had only the needed 15 kWh bought, leaving 5 kWh surplus on
the block (still generally buyable by `buyer-app`), no over-purchase.
Separately verified: a block priced above its requirement's ceiling is
now rejected at publish (`409`), and publishes successfully once a
lower margin is chosen. Full delivery → settlement re-verified with no
regression (hand-verified exact, same as every prior pass).

---

## 10. Glossary (Beckn/onix terms used throughout)

- **Beckn** — the open protocol spec (publish/discover/select/init/confirm/
  status/...) this whole network speaks; network-agnostic by design
  (originally ONDC commerce, here adapted for energy via **DEG** schemas).
- **onix** — the open-source reference implementation of a Beckn network
  participant adapter (signing, schema validation, routing, plugins). Each
  of `onix-buyerapp`/`onix-sellerapp`/`onix-buyerdiscom`/`onix-sellerdiscom`
  /`onix-ledger-*` is one onix instance configured for a different role.
- **BAP** (Beckn Application Platform) — the "buyer" side adapter; issues
  `discover`/`init`/`confirm`, receives `on_*` callbacks. Here:
  `onix-buyerapp`.
- **BPP** (Beckn Provider Platform) — the "seller" side adapter; receives
  `init`/`confirm`, issues `on_*` responses and the initial
  `catalog/publish`. Here: `onix-sellerapp`.
- **Gateway (BG)** — the network-wide broadcast/discovery relay; here the
  real shared sandbox instance at `34.93.165.42.sslip.io`.
- **Registry** — the subscriber directory (who's on the network, their
  public keys, their callback URLs); here `subscribers.beckn.one`.
- **DeDi** — Decentralized Digital Infrastructure registry
  (`api.dedi.global`) — where the real production contract policy is
  resolved from, among other things.
- **contractpolicyenforcer** — the onix plugin that fetches a contract's
  `.rego` policy and injects/enforces computed values (settlement,
  penalties, allowlist checks).
- **degledgerrecorder** — the onix plugin that writes confirmed trade
  records to the real external IES ledger
  (`ies-p2p-energy-ledger.beckn.io`), independent of each app's own local
  database.
- **DISCOM** — Distribution Company (the real-world electricity utility);
  here simulated per-side as `onix-sellerdiscom`/`onix-buyerdiscom` plus
  their own ledger sandboxes, representing the regulatory/wheeling layer
  between two different utilities' customers trading directly.

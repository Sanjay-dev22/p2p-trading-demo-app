# `network/` — the Beckn/onix devkit this demo runs on

The network itself is the public **[beckn/DEG](https://github.com/beckn/DEG)**
`p2p-trading-ies-wave2` devkit. We do not fork or vendor it. `npm run setup`:

1. does a sparse clone of that one directory at a **pinned commit**
   (`54a5c7b2a97bd1122022dc0f0c9986ea225942b7`, see `scripts/setup.js`) into
   `network/DEG-repo/` (gitignored);
2. copies **`network/overlay/`** over it — this directory is the complete list of
   our changes, so a reader can see exactly how we differ from upstream;
3. creates two empty directories Docker bind-mounts (`schemas/`, `specification/policies/`).

## What the overlay changes (all paths under `overlay/devkits/p2p-trading-ies-wave2/`)

| File | Status | Why |
|---|---|---|
| `install/docker-compose.yml` | modified | Removes the two fixture-replay stubs (`sandbox-buyerapp`, `sandbox-sellerapp`, left commented) because the real Buyer/Seller apps replace them. **Adds `onix-aggregatorapp` and `onix-gridapp`** (two more onix adapter containers). Remaps the seller adapter's host port to **18082**. Adds `NO_PROXY` for the local test hostnames (corporate laptops) and `extra_hosts: host.docker.internal:host-gateway` so Linux Docker Engine can reach the host-side apps. |
| `install/Caddyfile` | modified | Routes `aggregatorapp.example.com` and `gridapp.example.com` (the local router that stands in for DNS). |
| `config/local-p2p-trading-aggregatorapp.yaml` | **new** | The Aggregator's own onix adapter (BPP side). Clone of the seller adapter's config. |
| `config/local-p2p-trading-gridapp.yaml` | **new** | The Grid/DISCOM's own onix adapter (BAP side). Clone of the buyer adapter's config. |
| `config/local-p2p-trading-routing-AggregatorApp-BppReceiver.yaml` | **new** | Delivers requests for the aggregator's blocks to `aggregator-app` (`host.docker.internal:4003`). |
| `config/local-p2p-trading-routing-GridApp-{BapReceiver,BapCaller,BppReceiver,BppCaller}.yaml` | **new** | Same four routing files the buyer uses; `BapReceiver` delivers `on_*` replies to `grid-app` (`:4004`). |
| `config/local-p2p-trading-routing-BuyerApp-BapReceiver.yaml` | modified | Points at the real `buyer-app` (`:4001`) instead of the stub; adds `on_discover`. |
| `config/local-p2p-trading-routing-SellerApp-BppReceiver.yaml` | modified | Points at the real `seller-app` (`:4002`) instead of the stub. |
| `config/local-p2p-trading-buyerapp.yaml` | modified | Skips *extended* schema validation on `on_discover` only (one malformed entry from any other tester in the shared public catalog otherwise blocks discovery of everything); allows the local policy server prefix. |
| `config/local-p2p-trading-sellerapp.yaml` | modified | Allows the local policy server prefix. |
| `policies/p2p-trading-ies-wave2-contractpolicy-local-amended.rego` | **new** | The amended contract policy: a real shortfall penalty (₹2.5/kWh, was hard-coded 0), a price-sanity band (₹6–15/kWh), FIRM vs BEST_EFFORT commitments, and sample wheeling charges (₹0.5/kWh each side). Served to the adapters by `scripts/policy-server.js` on `:8099`. |

## Identities and ports

| Platform | onix adapter | Host port | Hostname on the local router | Signing identity |
|---|---|---|---|---|
| Seller | `onix-sellerapp` | 18082 | `sellerapp.example.com` | `sellerapp.example.com` (registered upstream sandbox key) |
| Buyer | `onix-buyerapp` | 8081 | `buyerapp.example.com` | `buyerapp.example.com` |
| Aggregator | `onix-aggregatorapp` | 18084 | `aggregatorapp.example.com` | **reuses** `sellerapp.example.com`'s keys |
| Grid/DISCOM | `onix-gridapp` | 18085 | `gridapp.example.com` | **reuses** `buyerapp.example.com`'s keys |

The Aggregator and DISCOM reuse an already-registered identity because
registering a brand-new network participant needs real DeDi registration and
namespace-owner approval, which is out of scope for a demo. Routing is still
genuinely separate (own container, own catalog entries, own lifecycle) — only the
signing keys are shared. Details: `../KNOWLEDGE-BASE.md` §9.

The apps default to exactly these ports, so no environment variables are needed.
Override only if you remapped something: `ONIX_SELLER_URL`, `ONIX_BUYER_URL`,
`ONIX_AGGREGATOR_URL`, `ONIX_GRID_URL`.

## The contract policy is served locally — why

The adapters fetch the policy named in each contract and evaluate it with OPA.
The upstream policy (on DeDi) has a zero shortfall penalty and no price sanity
check, so the demo's penalty and rejection paths would never fire. We serve the
amended copy from `http://host.docker.internal:8099/…` and add that prefix to
`allowedPolicyUrlPrefixes` (additive — the production DeDi prefix stays allowed).
The apps reference it in each `beckn.js` (`POLICY_URL`).

## Maintaining the overlay

- **Bumping upstream:** change `PINNED_SHA` in `scripts/setup.js`, delete `network/DEG-repo`, run `npm run setup`, test, and re-diff.
- **Editing a devkit file:** edit it in `network/DEG-repo/…`, then copy it back into `network/overlay/…` (the overlay is the source of truth; `DEG-repo` is disposable). `git -C network/DEG-repo status` lists exactly what differs from upstream.
- Keep LF line endings in overlay files (`.gitattributes` enforces this) — they are mounted into Linux containers.

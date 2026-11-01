// Aggregator Platform — pools several small real seller offers into one
// larger block, matches pooling against a posted bulk-buyer requirement
// (demand-first, see /api/requirements), publishes the resulting block
// through its OWN onix adapter instance (onix-aggregatorapp — see
// install/docker-compose.yml and beckn.js), and owns that block's entire
// real lifecycle (accept/confirm/deliver/settle) itself. Once settled, it
// disaggregates the one real settlement amount back down to each pooled
// seller. See peers.js's header comment for why discovery still proxies
// through buyer-app/seller-app's own REST APIs, and
// p2p-trading-app/KNOWLEDGE-BASE.md for the full write-up.
//
// Grounded in the real IES P2P trading implementation guide
// (ies-devkit/docs/implementation-guides/v2/P2P_Trading/
// P2P_Trading_implementation_guide_DRAFT.md), which names this exact
// mechanism: "Virtual meters enable aggregators to balance supply and
// demand across multiple participants." Also grounded in how real
// demand-response/VPP aggregation and flexibility markets (FERC Order
// 2222; UK's Piclo Flex) work: demand-first (a grid/large-buyer posts a
// requirement; the aggregator matches its pooled resources against it),
// and the aggregator transacts under its own distinct identity rather than
// its underlying small resources ever appearing in the market directly —
// see the "known simplifications" block below for what's still simplified
// relative to that real picture.
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const db = require("./db");
const peers = require("./peers");
const { inr, L, finish } = require("./walletlib");
const beckn = require("./beckn");

const PORT = process.env.PORT || 4003;
const BUYER_APP_URL = peers.BUYER_APP_URL;
const SELLER_APP_URL = peers.SELLER_APP_URL;
const GRID_APP_URL = process.env.GRID_APP_URL || "http://localhost:4004";
const SELLER_PLATFORM_ID = "sellerapp.example.com";

// Direct app-to-app notice (NOT a Beckn message) to whichever bulk buyer made
// a request we decline. A BPP that simply never answers an init is valid
// Beckn, but then the buyer's dashboard would show "Pending" forever -- the
// same coordination channel seller-app already uses for its own declines.
// The buyer is told apart by the bapUri it signed the init with: grid-app has
// its own onix address (gridapp.example.com), buyer-app has buyerapp.example.com.
function notifyBuyerOfDecline(context, transactionId, reason) {
  const target = String(context?.bapUri || "").includes("gridapp") ? GRID_APP_URL : BUYER_APP_URL;
  fetch(`${target}/api/notify/${transactionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "declined", reason }),
  }).catch((e) => console.error("notify buyer of decline failed (non-fatal):", e.message || e));
}

// Capacity reservation on the pooled sellers' own platform (direct REST, see
// seller-app's /api/reserve) -- pooling used to leave the underlying offers
// fully sellable, so the same kWh could be sold twice.
async function sellerCall(pathSuffix, body) {
  try {
    const r = await fetch(`${SELLER_APP_URL}${pathSuffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, error: j?.error };
  } catch (e) { return { ok: false, error: `seller-app unreachable: ${e.message || e}` }; }
}

// Mirrors the real enforced policy's rates — same three constants as
// seller-app/server.js, kept in sync by hand for the same reason (this app
// has no way to read the real .rego file directly either). Needed in full
// now (not just the seller-side wheeling rate) because this app computes
// its own real settlement directly, the same way seller-app does for its
// own trades — it no longer reads seller-app's settlement result back.
const PENALTY_RATE_PER_KWH = 2.5;
const WHEELING_CHARGE_SELLER_PER_KWH = 0.5;
const WHEELING_CHARGE_BUYER_PER_KWH = 0.5;
const DEFAULT_MARGIN_PER_KWH = 0.3;
const round2 = (x) => Math.round(x * 100) / 100;

function extractOnixError(result) {
  return (
    result.json?.message?.error?.message ||
    (result.text && result.text.trim()) ||
    `onix returned HTTP ${result.status || "(no response)"} with no readable body`
  );
}

// Same formula as seller-app/server.js's own computeSettlement — FIRM
// commitments only, same default the policy itself falls back to.
function computeSettlement({ requestedQty, finalAlloc, pricePerKwh }) {
  const shortfallKwh = round2(Math.max(0, requestedQty - finalAlloc));
  const tradeValue = round2(finalAlloc * pricePerKwh);
  const wheelingSeller = round2(WHEELING_CHARGE_SELLER_PER_KWH * finalAlloc);
  const wheelingBuyer = round2(WHEELING_CHARGE_BUYER_PER_KWH * finalAlloc);
  const penalty = round2(PENALTY_RATE_PER_KWH * shortfallKwh);
  const sellerReceivable = round2(tradeValue - wheelingSeller - penalty);
  const buyerPayable = round2(tradeValue + wheelingBuyer);
  return { shortfallKwh, tradeValue, wheelingSeller, wheelingBuyer, penalty, sellerReceivable, buyerPayable };
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

function logEvent(blockId, summary) {
  db.prepare("INSERT INTO events (block_id, summary, at) VALUES (?,?,?)").run(blockId, summary, beckn.nowIso());
}

function tradeRow(row) {
  return {
    transactionId: row.transaction_id,
    blockId: row.block_id,
    bapId: row.bap_id,
    buyerDiscom: row.buyer_discom,
    requestedQty: row.requested_qty,
    pricePerKwh: row.price_per_kwh,
    status: row.status,
    finalAlloc: row.final_alloc,
    settlementAmount: row.settlement_amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get("/api/health", (req, res) => res.status(200).send("ok"));

// ---------- Known simplifications, surfaced to the UI, not hidden ----------
app.get("/api/about", (req, res) => {
  res.json({
    simplifications: [
      "Reuses sellerapp.example.com's already-registered signing identity (same keys as onix-sellerapp) for onix-aggregatorapp rather than registering a brand-new, distinct network participant — that step needs real DeDi registration + namespace-owner approval, out of scope for this demo. Routing is genuinely separate (own container, own catalog, own lifecycle); only the underlying signing identity is shared.",
      "Incoming requirements are matched with a simple cheapest-first greedy fill up to the requested quantity (capped by the price ceiling), not a true constrained optimization.",
      "Each individual block's own membership is fixed at its own publish time — no re-aggregation of an already-published block as sellers' availability changes mid-window. A requirement as a whole CAN be topped up with additional, separate blocks over time as new sellers appear (see below), but that's a new block, not a reopened old one.",
      "Per-seller meter readings are ENTERED by the aggregator operator in this demo (there is no real smart-meter feed). Settlement itself is real and per seller: each seller is paid for what their own reading says they delivered, capped at their allocated share, and a seller who comes up short bears their own shortfall penalty. A real deployment would ingest each member's actual meter data (the 'virtual meter' reconciliation the IES implementation guide describes).",
      "Grid/DISCOM (grid-app) has its own onix identity and executes the real buy/confirm itself — reusing buyer-app's already-registered keys (buyerapp.example.com), the same no-new-DeDi-registration trick used for this app's own identity above. A block published for a DISCOM's requirement is VISIBLE on the public catalog but reserved: the aggregator declines any other buyer. Only blocks published to the open market can be bought by anyone.",
      "Cash balances (the 'wallet' in each header) are a settled-cash ledger computed from real settled trades, not a payment rail — nothing here moves actual money. Only one aggregator exists in this demo; the DISCOM cannot yet shop a requirement across several aggregators.",
    ],
  });
});

// ---------- Discover: proxy through buyer-app's own real discover ----------
// Kept for the dashboard button / older callers: the list is read live from the
// Seller Platform now, so "discover" is simply a refresh (no buyer involved).
app.post("/api/discover", (req, res) => res.json({ ok: true }));

// Real offers buyer-app has actually discovered, minus whatever is already
// enrolled in the current pending pool (no double-pooling the same offer).
// See resolveOffer()-style cross-check comment in peers.js for why this
// checks seller-app's own live catalog rather than trusting seller_id.
async function listAvailableOffers() {
  // What an aggregator can pool is each seller offer's CURRENT unreserved
  // capacity, read live from the Seller Platform, minus whatever is already
  // sitting in the pending (unpublished) pool. Publishing a block reserves its
  // kWh on the seller, and withdrawing releases them again -- so an offer
  // whose capacity was handed back by a withdraw (or never fully pooled)
  // reappears here automatically. The seller's offer itself is never touched.
  const ownOffers = await peers.fetchSellerOffers();
  const pending = new Map();
  for (const m of db.prepare("SELECT offer_id, SUM(enrolled_qty) AS q FROM pool_members WHERE block_id IS NULL GROUP BY offer_id").all()) pending.set(m.offer_id, m.q);
  return ownOffers
    .map((o) => ({
      offer_id: o.id,
      seller_id: SELLER_PLATFORM_ID,
      name: "Demo Solar Offer",
      price_per_kwh: o.price_per_kwh,
      available_qty: round2((o.remaining_qty ?? o.quantity_kwh) - (pending.get(o.id) || 0)),
      published_at: o.published_at,
    }))
    .filter((o) => o.price_per_kwh && o.available_qty > 0);
}

app.get("/api/available-offers", async (req, res) => {
  try {
    res.json(await listAvailableOffers());
  } catch (err) {
    console.error("available-offers failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- The pending pool (not yet published) ----------
app.get("/api/pool", (req, res) => {
  const rows = db.prepare("SELECT * FROM pool_members WHERE block_id IS NULL ORDER BY enrolled_at ASC").all();
  const totalQty = rows.reduce((s, r) => s + r.enrolled_qty, 0);
  const blendedPrice = totalQty > 0 ? round2(rows.reduce((s, r) => s + r.enrolled_qty * r.price_per_kwh, 0) / totalQty) : 0;
  res.json({ members: rows, totalQty: round2(totalQty), blendedPrice });
});

app.post("/api/pool/enroll", async (req, res) => {
  const { offerId, sellerId, pricePerKwh, qty } = req.body || {};
  const quantity = Number(qty);
  const price = Number(pricePerKwh);
  if (!offerId || !quantity || quantity <= 0 || !price || price <= 0) {
    return res.status(400).json({ error: "offerId, a positive qty, and a positive pricePerKwh are required" });
  }
  try {
    const ownOffers = await peers.fetchSellerOffers();
    const own = ownOffers.find((o) => o.id === offerId);
    if (!own) {
      return res.status(409).json({ error: `${offerId} is not currently on our own seller-app's live catalog -- it may belong to a different real participant on the shared network (seller_id alone can't tell them apart), or it may have already been sold.` });
    }
    const alreadyPending = db.prepare("SELECT COALESCE(SUM(enrolled_qty),0) AS q FROM pool_members WHERE block_id IS NULL AND offer_id=?").get(offerId).q;
    const free = round2(own.remaining_qty - alreadyPending);
    if (quantity > free + 1e-9) {
      return res.status(409).json({ error: `Only ${free} kWh is free to pool on ${offerId} right now (${own.remaining_qty} kWh remaining${alreadyPending ? `, ${alreadyPending} kWh already in the pending pool` : ""}) -- ${quantity} kWh was requested.` });
    }
    const now = peers.nowIso();
    // The price comes from the seller's own live offer, never from the caller.
    db.prepare("INSERT INTO pool_members (block_id, offer_id, seller_id, price_per_kwh, enrolled_qty, enrolled_at) VALUES (NULL,?,?,?,?,?)").run(
      offerId, SELLER_PLATFORM_ID, own.price_per_kwh, quantity, now
    );
    broadcast("pool_updated", {});
    res.json({ ok: true });
  } catch (err) {
    console.error("pool/enroll failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/pool/unenroll/:id", (req, res) => {
  db.prepare("DELETE FROM pool_members WHERE id=? AND block_id IS NULL").run(req.params.id);
  broadcast("pool_updated", {});
  res.json({ ok: true });
});

// ---------- Demand-driven matching (Grid/DISCOM requirements) ----------
app.post("/api/requirements", (req, res) => {
  const quantityKwh = Number(req.body?.quantityKwh);
  const maxPricePerKwh = Number(req.body?.maxPricePerKwh);
  if (!quantityKwh || quantityKwh <= 0 || !maxPricePerKwh || maxPricePerKwh <= 0) {
    return res.status(400).json({ error: "quantityKwh and maxPricePerKwh must be positive numbers" });
  }
  const id = `req-${beckn.uuid().slice(0, 8)}`;
  const now = beckn.nowIso();
  db.prepare("INSERT INTO requirements (id, quantity_kwh, max_price_per_kwh, status, created_at) VALUES (?,?,?,?,?)").run(id, quantityKwh, maxPricePerKwh, "PENDING", now);
  logEvent(null, `Requirement ${id} posted: ${quantityKwh} kWh at or below ₹${maxPricePerKwh}/kWh`);
  broadcast("requirement_posted", {});
  res.json({ ok: true, id, requirement: db.prepare("SELECT * FROM requirements WHERE id=?").get(id) });
});

// kWh already published for a requirement and still unsold: it counts as
// covered, so recommending/publishing again must not offer it a second time.
const openQtyFor = (requirementId) => round2(db.prepare("SELECT COALESCE(SUM(remaining_qty),0) AS v FROM blocks WHERE requirement_id=?").get(requirementId).v);

app.get("/api/requirements", (req, res) => {
  // Each requirement carries the blocks published against it, so the Grid can
  // show what has actually been offered (and how much of the ask is still
  // uncovered) instead of only a bare status word.
  const rows = db.prepare("SELECT * FROM requirements ORDER BY created_at DESC").all();
  const blockStmt = db.prepare("SELECT id, total_quantity_kwh AS quantity_kwh, remaining_qty, COALESCE(withdrawn_qty,0) AS withdrawn_qty, blended_price_per_kwh AS price_per_kwh, member_count, published_at FROM blocks WHERE requirement_id=? ORDER BY published_at ASC");
  res.json(rows.map((r) => {
    const blocks = blockStmt.all(r.id);
    // "On offer" = what was published minus whatever the aggregator pulled back.
    return { ...r, blocks, published_qty: round2(blocks.reduce((s, b) => s + b.quantity_kwh - b.withdrawn_qty, 0)) };
  }));
});

// Cheapest-first greedy fill — a disclosed simplification (see /api/about),
// not a constrained optimizer. Never recommends anything above the
// requirement's own price ceiling, and clearly flags a shortfall instead of
// silently proposing a partial match as if it were complete.
app.post("/api/requirements/:id/recommend", async (req, res) => {
  try {
    const requirement = db.prepare("SELECT * FROM requirements WHERE id=?").get(req.params.id);
    if (!requirement) return res.status(404).json({ error: "requirement not found" });
    if (requirement.status === "FULFILLED") {
      return res.status(409).json({ error: `Requirement ${requirement.id} is already fully bought (${requirement.fulfilled_qty} of ${requirement.quantity_kwh} kWh) — nothing left to recommend.` });
    }

    const candidates = (await listAvailableOffers())
      .map((o) => ({ offerId: o.offer_id, sellerId: o.seller_id, pricePerKwh: o.price_per_kwh, availableQty: o.available_qty }))
      .filter((o) => o.pricePerKwh <= requirement.max_price_per_kwh)
      .sort((a, b) => a.pricePerKwh - b.pricePerKwh);

    // Matches against what's STILL needed, not the original full amount —
    // a requirement can already be partly bought from an earlier, smaller
    // published block (this is what lets a late-arriving seller's offer,
    // discovered hours later, top up a requirement instead of the operator
    // having no way back in once something was already published for it).
    const alreadyBought = requirement.fulfilled_qty || 0;
    const onOffer = openQtyFor(requirement.id);
    const neededQty = round2(Math.max(0, requirement.quantity_kwh - alreadyBought - onOffer));
    if (neededQty <= 0.001) {
      return res.status(409).json({ error: `Nothing left to recommend for ${requirement.id}: ${alreadyBought} kWh already bought and ${onOffer} kWh already on offer in published blocks — the rest is waiting for the DISCOM to buy it.` });
    }

    const picked = [];
    let qtyRemaining = neededQty;
    for (const c of candidates) {
      if (qtyRemaining <= 0) break;
      const take = round2(Math.min(c.availableQty, qtyRemaining));
      picked.push({ ...c, takeQty: take });
      qtyRemaining = round2(qtyRemaining - take);
    }

    const totalQty = round2(picked.reduce((s, p) => s + p.takeQty, 0));
    const blendedBasePrice = totalQty > 0 ? round2(picked.reduce((s, p) => s + p.takeQty * p.pricePerKwh, 0) / totalQty) : 0;
    const fulfilled = qtyRemaining <= 0.001;
    // Heuristic warning only (the operator picks the real margin at publish
    // time, which is enforced for real there and again at grid-app's buy
    // boundary) — found live: the underlying small-offer prices were each
    // individually under the ceiling, but the published block's actual
    // price (blended + margin) still exceeded it, and nothing caught that
    // until a buyer had already paid above their own stated ceiling.
    const estimatedBlockPrice = totalQty > 0 ? round2(blendedBasePrice + DEFAULT_MARGIN_PER_KWH) : 0;
    const marginWarning = totalQty > 0 && estimatedBlockPrice > requirement.max_price_per_kwh
      ? ` Warning: with the default ₹${DEFAULT_MARGIN_PER_KWH}/kWh margin, the published price would be ₹${estimatedBlockPrice}/kWh — already above this requirement's ₹${requirement.max_price_per_kwh}/kWh ceiling. Publish at a lower margin or it will be rejected.`
      : "";

    if (requirement.status === "PENDING") {
      db.prepare("UPDATE requirements SET status=? WHERE id=?").run("RECOMMENDED", requirement.id);
    }

    res.json({
      requirement,
      picked,
      totalQty,
      blendedBasePrice,
      fulfilled,
      neededQty,
      alreadyBought,
      shortfallQty: fulfilled ? 0 : round2(qtyRemaining),
      note: (fulfilled
        ? (alreadyBought > 0
            ? `This combination covers the remaining ${neededQty} kWh still needed (${alreadyBought} of ${requirement.quantity_kwh} kWh already bought).`
            : "This combination fully meets the requirement within its price ceiling.")
        : `Only ${totalQty} of the ${neededQty} kWh still needed could be matched within the ₹${requirement.max_price_per_kwh}/kWh ceiling from currently available real offers.`) + marginWarning,
    });
  } catch (err) {
    console.error("recommend failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- Publish the pooled block ----------
// Mints its own offer identity and publishes it through this app's OWN
// onix adapter (onix-aggregatorapp), not seller-app's — aggregation-v2:
// the block is genuinely this app's own catalog entry and lifecycle from
// here on. requirementId is optional — when the pool was built from a
// posted requirement's recommendation, this marks it fulfilled.
app.post("/api/pool/publish", async (req, res) => {
  try {
    const marginPerKwh = Number(req.body?.marginPerKwh);
    const margin = marginPerKwh > 0 ? marginPerKwh : DEFAULT_MARGIN_PER_KWH;
    const requirementId = req.body?.requirementId || null;

    let requirement = null;
    if (requirementId) {
      requirement = db.prepare("SELECT * FROM requirements WHERE id=?").get(requirementId);
      if (!requirement) return res.status(404).json({ error: `requirement ${requirementId} not found` });
      if (requirement.status === "FULFILLED") {
        return res.status(409).json({ error: `Requirement ${requirementId} is already fully bought — publishing another block against it would overshoot what was asked for.` });
      }
    }

    const members = db.prepare("SELECT * FROM pool_members WHERE block_id IS NULL").all();
    // The >=2 minimum exists so a "pooled block" is genuine aggregation,
    // not just relabeling one seller's own offer. That reasoning doesn't
    // apply to a top-up block for a requirement that's already partly
    // bought from an earlier, real multi-seller block -- found live: a
    // single new seller's offer showing up later (the realistic case) was
    // getting blocked from ever topping up the requirement, even though
    // the requirement's aggregation was already genuinely multi-seller
    // overall, just not from this one later top-up alone.
    // One offer is enough: a single large prosumer can still use an aggregator
    // as the intermediary that packages, prices and sells their energy.
    if (members.length < 1) {
      return res.status(400).json({ error: "Pool at least one seller offer before publishing a block" });
    }

    // Re-verify every member right before publishing — see
    // KNOWLEDGE-BASE.md §9's documented gap on why this can still go stale
    // between enroll and publish (pooling never reserves capacity on
    // seller-app's own catalog).
    const ownOffers = await peers.fetchSellerOffers();
    const ownById = new Map(ownOffers.map((o) => [o.id, o]));
    for (const m of members) {
      const own = ownById.get(m.offer_id);
      if (!own) {
        return res.status(409).json({ error: `${m.offer_id} is no longer on our own seller-app's live catalog -- remove it from the pool before publishing.` });
      }
      if (m.enrolled_qty > own.remaining_qty) {
        return res.status(409).json({ error: `${m.offer_id} now has only ${own.remaining_qty} kWh remaining (someone else may have bought part of it directly) -- re-enroll it at a lower quantity before publishing.` });
      }
    }

    const totalQty = round2(members.reduce((s, m) => s + m.enrolled_qty, 0));
    if (requirement) {
      const stillUncovered = round2(requirement.quantity_kwh - (requirement.fulfilled_qty || 0) - openQtyFor(requirement.id));
      if (totalQty > stillUncovered + 0.011) {
        return res.status(409).json({ error: `This pool is ${totalQty} kWh but only ${Math.max(0, stillUncovered)} kWh of ${requirement.id} is still uncovered (the rest is bought or already on offer) — reduce the pool so you don't oversell the requirement.` });
      }
    }
    const blendedBase = members.reduce((s, m) => s + m.enrolled_qty * m.price_per_kwh, 0) / totalQty;
    const blockPrice = round2(blendedBase + margin);

    // Found live: the underlying small-offer prices can each individually
    // sit under a linked requirement's ceiling, but the published block's
    // real price (blended + margin) can still end up above it — and
    // nothing caught that before a buyer had already paid over their own
    // stated max. Enforced here, not just at grid-app's buy boundary, so
    // an invalid block is never created in the first place.
    if (requirement && blockPrice > requirement.max_price_per_kwh) {
      return res.status(409).json({
        error: `Publishing at ₹${blockPrice}/kWh (blended ₹${round2(blendedBase)} + ₹${margin} margin) would exceed requirement ${requirementId}'s own ₹${requirement.max_price_per_kwh}/kWh ceiling -- lower the margin or re-pool cheaper offers.`,
      });
    }

    const offerId = `offer-agg-${beckn.uuid().slice(0, 8)}`;

    // Reserve every member's pooled quantity on its seller BEFORE publishing,
    // so those kWh can no longer be sold directly while they sit inside this
    // block. All-or-nothing: any failure gives back what was already taken.
    const reserved = [];
    const releaseReserved = async () => { for (const r of reserved) await sellerCall("/api/release", { offerId: r.offer_id, qty: r.enrolled_qty }); };
    for (const m of members) {
      const r = await sellerCall("/api/reserve", { offerId: m.offer_id, qty: m.enrolled_qty });
      if (!r.ok) {
        await releaseReserved();
        return res.status(409).json({ error: `Could not reserve ${m.enrolled_qty} kWh on ${m.offer_id}: ${r.error || "seller-app refused"}. Nothing was published.` });
      }
      reserved.push(m);
    }

    const { context, message } = beckn.buildPublishCatalog({ offerId, quantityKwh: totalQty, pricePerKwh: blockPrice, memberCount: members.length });
    const result = await beckn.postToOnix("/bpp/caller/catalog/publish", { context, message });
    if (!result.ok) {
      console.error("publish rejected by onix-aggregatorapp:", result.status, result.text);
      await releaseReserved();
      return res.status(result.status || 502).json({ error: extractOnixError(result), detail: result.json, raw: result.text });
    }

    const now = beckn.nowIso();
    db.prepare(
      "INSERT INTO blocks (id, total_quantity_kwh, remaining_qty, blended_price_per_kwh, margin_per_kwh, member_count, published_at, requirement_id) VALUES (?,?,?,?,?,?,?,?)"
    ).run(offerId, totalQty, totalQty, blockPrice, margin, members.length, now, requirementId);

    db.prepare("UPDATE pool_members SET block_id=? WHERE block_id IS NULL").run(offerId);
    if (requirementId) {
      // block_id here is just "most recently published block" for simple
      // display — the authoritative link for "every block that's ever
      // served this requirement" is blocks.requirement_id (a requirement
      // can span more than one block over time; see the init handler's
      // fulfilled_qty bookkeeping below). Status guarded against FULFILLED
      // (checked above too, but this stays consistent even under a race).
      db.prepare("UPDATE requirements SET status=?, block_id=? WHERE id=? AND status != ?").run("PUBLISHED", offerId, requirementId, "FULFILLED");
    }

    logEvent(offerId, `Published block ${offerId}: ${totalQty} kWh @ ₹${blockPrice}/kWh (blended ₹${round2(blendedBase)} + ₹${margin} margin) from ${members.length} pooled sellers — own catalog entry, own lifecycle`);
    broadcast("block_published", { id: offerId });
    res.json({ ok: true, block: db.prepare("SELECT * FROM blocks WHERE id=?").get(offerId) });
  } catch (err) {
    console.error("pool/publish failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- Real offers this app has published — same shape as
// seller-app's own /api/offers, so buyer-app's resolveOffer() can check
// this catalog exactly the same way it already checks seller-app's. ----------
app.get("/api/offers", (req, res) => {
  const rows = db
    .prepare("SELECT id, total_quantity_kwh AS quantity_kwh, remaining_qty, blended_price_per_kwh AS price_per_kwh, published_at, requirement_id AS reserved_for FROM blocks ORDER BY published_at DESC")
    .all();
  res.json(rows);
});

// ---------- Every block ever published to serve a given requirement ----------
// A requirement can now span more than one block over time (partial publish
// now, topped up later once new sellers show up) — grid-app's own buy flow
// uses this (cheapest-first, same spirit as recommend) instead of assuming
// a requirement's `block_id` is the only block that was ever published for
// it.
app.get("/api/requirements/:id/blocks", (req, res) => {
  const rows = db
    .prepare("SELECT id, total_quantity_kwh AS quantity_kwh, remaining_qty, blended_price_per_kwh AS price_per_kwh, published_at FROM blocks WHERE requirement_id=? ORDER BY blended_price_per_kwh ASC")
    .all(req.params.id);
  res.json(rows);
});

// ---------- inbound webhook: real requests from onix-aggregatorapp's
// bppTxnReceiver ----------
// select | init | confirm | status | update | cancel all land here (see
// config/local-p2p-trading-routing-AggregatorApp-BppReceiver.yaml). Unlike
// seller-app, init is auto-accepted here (no manual review step) — the
// block's price was already fixed and reviewed at pooling/publish time, so
// there's no further negotiation to model (see /api/about).
app.post("/api/webhook/:action", async (req, res) => {
  const action = req.params.action;
  const { context, message } = req.body || {};
  console.log(`[agg-webhook] ${action} — txn=${context?.transactionId}`);

  try {
    if (action === "init") {
      const contract = message?.contract;
      const { price, requestedQty } = beckn.extractInterval0(contract);
      const buyerDiscom = beckn.extractBuyerDiscom(contract);
      const blockId = contract?.commitments?.[0]?.offer?.id || "unknown-block";
      const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(blockId);

      if (db.prepare("SELECT 1 FROM trades WHERE transaction_id=?").get(context.transactionId)) {
        // Replayed init for a trade we already hold -- must not decrement the
        // block (or the requirement) a second time.
        return res.status(200).json(beckn.buildAck(context));
      }

      if (block && block.requirement_id && !String(context?.bapUri || "").includes("gridapp")) {
        // A block published to serve a DISCOM's requirement is reserved for
        // that DISCOM. The Beckn catalog is public so other platforms can SEE it,
        // but only the requirement's own buyer may transact on it.
        const why = `Block ${blockId} is reserved for DISCOM requirement ${block.requirement_id} — only that buyer can purchase it`;
        logEvent(blockId, `Declined — ${why}`);
        notifyBuyerOfDecline(context, context.transactionId, why);
        return res.status(200).json(beckn.buildAck(context));
      }

      if (block && requestedQty && requestedQty <= block.remaining_qty && price != null && price < block.blended_price_per_kwh - 0.001) {
        // The block's price already includes the margin that pays the pooled
        // sellers; unlike a seller-app offer there is no negotiation here
        // (see /api/about). Auto-accepting a lower bid used to sell the block
        // below what the sellers are owed, i.e. at a loss to the aggregator.
        const why = `Bid ₹${price}/kWh is below this block's fixed price of ₹${block.blended_price_per_kwh}/kWh — pooled blocks are not negotiable`;
        logEvent(blockId, `Declined — ${why}`);
        notifyBuyerOfDecline(context, context.transactionId, why);
        return res.status(200).json(beckn.buildAck(context));
      }

      if (!block || !requestedQty || requestedQty > block.remaining_qty) {
        // Same category as seller-app's own "decline" path: no response
        // sent back is valid Beckn behavior. Likely only reachable via a
        // race (two inits for the same block in quick succession) since
        // buyer-app's own pre-flight already checks remaining_qty first.
        logEvent(blockId, `Declined (no response sent) — requested ${requestedQty ?? "?"} kWh exceeds ${block ? block.remaining_qty : "(block not found)"} kWh remaining`);
        notifyBuyerOfDecline(context, context.transactionId, `Requested ${requestedQty ?? "?"} kWh exceeds the ${block ? block.remaining_qty : 0} kWh remaining on this block`);
        return res.status(200).json(beckn.buildAck(context));
      }

      db.prepare("UPDATE blocks SET remaining_qty = remaining_qty - ? WHERE id=?").run(requestedQty, blockId);
      // Close the demand-side loop regardless of *which* real buyer (grid-app
      // or buyer-app) won this purchase — a requirement is fulfilled once
      // the physical quantity it asked for is actually bought, not only
      // when grid-app itself happens to be the buyer (see the disclosed
      // race condition in KNOWLEDGE-BASE.md §9's Phase 2). Tracked against
      // the REQUIREMENT's own cumulative fulfilled_qty, not this one
      // block's remaining_qty reaching zero -- a requirement can now be
      // served by more than one block over time (a block smaller than the
      // requirement no longer deadlocks it; see §9's Phase 2 follow-up),
      // so "this block sold out" is no longer the same thing as "this
      // requirement is fulfilled."
      if (block.requirement_id) {
        db.prepare("UPDATE requirements SET fulfilled_qty = fulfilled_qty + ? WHERE id=?").run(requestedQty, block.requirement_id);
        const linkedReq = db.prepare("SELECT * FROM requirements WHERE id=?").get(block.requirement_id);
        if (linkedReq && linkedReq.fulfilled_qty >= linkedReq.quantity_kwh - 0.001 && linkedReq.status !== "FULFILLED") {
          db.prepare("UPDATE requirements SET status=? WHERE id=?").run("FULFILLED", block.requirement_id);
        }
      }
      const now = beckn.nowIso();
      db.prepare(
        `INSERT INTO trades (transaction_id, block_id, bap_id, buyer_discom, requested_qty, price_per_kwh, status, raw_context, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(transaction_id) DO UPDATE SET raw_context=excluded.raw_context, updated_at=excluded.updated_at`
      ).run(context.transactionId, blockId, context.bapId, buyerDiscom, requestedQty, price || 0, "AWAITING_CONFIRM", JSON.stringify({ context, message }), now, now);
      logEvent(blockId, `Buyer bid ₹${price}/kWh for ${requestedQty} kWh — auto-accepted`);
      broadcast("incoming_request", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));

      const onInit = beckn.buildOnInit(context, contract);
      beckn
        .postToOnix("/bpp/caller/on_init", onInit)
        .then((result) => {
          db.prepare("UPDATE trades SET raw_context=?, updated_at=? WHERE transaction_id=?").run(JSON.stringify(onInit), beckn.nowIso(), context.transactionId);
          logEvent(blockId, "on_init sent — accepted as bid");
          if (!result.ok) console.error("on_init send failed:", result.status, result.json);
        })
        .catch((e) => console.error("on_init send error:", e));
    } else if (action === "confirm") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (row && row.status !== "AWAITING_CONFIRM") {
        logEvent(row.block_id, `Ignored a confirm -- trade is ${row.status}, not awaiting one`);
      } else if (row) {
        logEvent(row.block_id, "Buyer confirmed");
        const onConfirm = beckn.buildOnConfirm(context, message.contract);
        beckn
          .postToOnix("/bpp/caller/on_confirm", onConfirm)
          .then((result) => {
            if (!result.ok) {
              console.error("on_confirm send failed:", result.status, result.json);
              logEvent(row.block_id, `on_confirm NOT sent -- network rejected it: ${extractOnixError(result)}`);
              return;
            }
            const now = beckn.nowIso();
            db.prepare("UPDATE trades SET status=?, raw_context=?, updated_at=? WHERE transaction_id=?").run("ACTIVE", JSON.stringify(onConfirm), now, context.transactionId);
            logEvent(row.block_id, "Trade is now ACTIVE");
            broadcast("active", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
          })
          .catch((e) => console.error("on_confirm send error:", e));
      }
    }
    res.status(200).json(beckn.buildAck(context));
  } catch (err) {
    console.error(`agg-webhook ${action} failed:`, err);
    res.status(200).json(beckn.buildAck(context || {}));
  }
});

// Direct app-to-app notice from a bulk buyer (NOT a Beckn message): its confirm
// failed on the network, so the block capacity and requirement quantity this
// app already counted at init must be handed back.
app.post("/api/notify/:transactionId", (req, res) => {
  const { event, reason } = req.body || {};
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(req.params.transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if ((event === "confirm_failed" || event === "counter_declined") && row.status === "AWAITING_CONFIRM") {
    const blockBefore = db.prepare("SELECT * FROM blocks WHERE id=?").get(row.block_id);
    if (blockBefore && (blockBefore.withdrawn_qty || 0) > 0) {
      // The block was already withdrawn from the market: the kWh go back to the
      // sellers, not onto a block nobody can buy any more.
      releaseToSellers(blockBefore, row.requested_qty).catch(() => {});
      db.prepare("UPDATE blocks SET withdrawn_qty = withdrawn_qty + ? WHERE id=?").run(row.requested_qty, row.block_id);
    } else {
      db.prepare("UPDATE blocks SET remaining_qty = MIN(total_quantity_kwh, remaining_qty + ?) WHERE id=?").run(row.requested_qty, row.block_id);
    }
    const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(row.block_id);
    if (block?.requirement_id) {
      db.prepare("UPDATE requirements SET fulfilled_qty = MAX(0, fulfilled_qty - ?), status = CASE WHEN status='FULFILLED' THEN 'PUBLISHED' ELSE status END WHERE id=?").run(row.requested_qty, block.requirement_id);
    }
    db.prepare("UPDATE trades SET status=?, updated_at=? WHERE transaction_id=?").run("DECLINED", beckn.nowIso(), row.transaction_id);
    logEvent(row.block_id, `Buyer's confirm failed${reason ? ` (${reason})` : ""} — ${row.requested_qty} kWh returned to the block`);
    broadcast("block_published", { id: row.block_id });
  }
  res.json({ ok: true });
});

// How a trade's quantity is shared between the pooled sellers: pro-rata to what
// each enrolled, rounded to 2 dp, the last seller absorbing the rounding so the
// shares add up to exactly the traded quantity.
function tradeAllocations(members, requestedQty) {
  const total = members.reduce((s, m) => s + m.enrolled_qty, 0);
  let left = round2(requestedQty);
  return members.map((m, i) => {
    const alloc = i === members.length - 1 ? left : round2((m.enrolled_qty * requestedQty) / total);
    left = round2(left - alloc);
    return { m, alloc: Math.max(0, alloc) };
  });
}

// Hand kWh of a block back to the pooled sellers it was reserved from.
async function releaseToSellers(block, qty) {
  const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(block.id);
  const allocs = tradeAllocations(members, qty);
  for (const { m, alloc } of allocs) if (alloc > 0) await sellerCall("/api/release", { offerId: m.offer_id, qty: alloc });
}

app.get("/api/deliver/:transactionId/suggest", (req, res) => {
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(req.params.transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(row.block_id);
  const allocs = tradeAllocations(members, row.requested_qty);
  // Demo data: most sellers meter exactly their share and ONE comes up short --
  // which is what real under-delivery looks like (one inverter/meter, not all).
  const weak = allocs.length > 1 ? Math.floor(Math.random() * allocs.length) : 0;
  const readings = allocs.map(({ m, alloc }, i) => ({
    offerId: m.offer_id, sellerId: m.seller_id, pricePerKwh: m.price_per_kwh, allocatedKwh: alloc,
    suggestedKwh: i === weak ? round2(alloc * (0.7 + Math.random() * 0.2)) : alloc,
  }));
  res.json({ requestedQty: row.requested_qty, readings, suggestedFinalAlloc: round2(readings.reduce((s, r) => s + r.suggestedKwh, 0)) });
});

app.get("/api/deliver/:transactionId/allocations", (req, res) => {
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(req.params.transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(row.block_id);
  res.json({ requestedQty: row.requested_qty, allocations: tradeAllocations(members, row.requested_qty).map(({ m, alloc }) => ({ offerId: m.offer_id, sellerId: m.seller_id, pricePerKwh: m.price_per_kwh, allocatedKwh: alloc })) });
});

// ---------- Report delivery: real on_status (settled) ----------
// Delivery is reported PER SELLER, from each pooled seller's own meter. The
// total that goes to the network (and the bulk buyer) is the sum of those
// readings, each capped at that seller's allocated share -- energy beyond the
// contracted share is not paid for. A single-total report (finalAlloc) is still
// accepted for simple use; it is spread pro-rata and said so in the log.
const delivering = new Set();
app.post("/api/deliver/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "ACTIVE") return res.status(409).json({ error: `trade is ${row.status}, not ACTIVE` });
  // A double-click on "Report delivery" must not send a second on_status.
  if (delivering.has(transactionId)) return res.status(409).json({ error: "delivery for this trade is already being reported" });

  const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(row.block_id);
  const allocs = tradeAllocations(members, row.requested_qty);
  const readings = {};
  let finalAlloc;
  if (Array.isArray(req.body?.readings)) {
    for (const { m, alloc } of allocs) {
      const r = req.body.readings.find((x) => x.offerId === m.offer_id);
      const kwh = Number(r?.kwh);
      if (!r || !Number.isFinite(kwh) || kwh < 0) return res.status(400).json({ error: `A valid meter reading (kWh, 0 or more) is required for ${m.offer_id}` });
      readings[m.offer_id] = round2(Math.min(kwh, alloc));
    }
    finalAlloc = round2(Object.values(readings).reduce((s, v) => s + v, 0));
  } else {
    const total = Number(req.body?.finalAlloc);
    if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: "Provide a meter reading for every pooled seller (readings), or a positive total (finalAlloc)" });
    finalAlloc = round2(Math.min(total, row.requested_qty));
    for (const { m, alloc } of allocs) readings[m.offer_id] = round2((alloc * finalAlloc) / row.requested_qty);
    finalAlloc = round2(Object.values(readings).reduce((s, v) => s + v, 0));
  }
  if (finalAlloc <= 0) return res.status(400).json({ error: "Total delivered is 0 kWh — nothing to settle. Enter at least one seller's reading." });

  delivering.add(transactionId);
  try {
    const stored = JSON.parse(row.raw_context);
    const { shortfallKwh, wheelingSeller, penalty, sellerReceivable } = computeSettlement({ requestedQty: row.requested_qty, finalAlloc, pricePerKwh: row.price_per_kwh });
    const settlementAmount = sellerReceivable;
    const txnRef = `TXN-${transactionId.slice(0, 8).toUpperCase()}-AGG-SETTLED`;

    const onStatus = beckn.buildOnStatusSettled(stored.context, stored.message.contract, {
      finalAlloc, pricePerKwh: row.price_per_kwh, requestedQty: row.requested_qty, settlementAmount, shortfallKwh, wheelingSeller, penalty, txnRef,
    });
    const result = await beckn.postToOnix("/bpp/caller/on_status", onStatus);
    if (!result.ok) { console.error("on_status rejected by onix-aggregatorapp:", result.status, result.text); return res.status(result.status || 502).json({ error: extractOnixError(result), detail: result.json, raw: result.text }); }

    const now = beckn.nowIso();
    db.prepare("UPDATE trades SET status=?, final_alloc=?, settlement_amount=?, readings=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
      "SETTLED", finalAlloc, settlementAmount, JSON.stringify(readings), JSON.stringify(onStatus), now, transactionId
    );
    logEvent(row.block_id, `Reported ${finalAlloc} kWh delivered (from ${allocs.length} seller meter readings) — settled ₹${settlementAmount.toFixed(2)} — disaggregation now available`);
    const updated = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId));
    broadcast("settled", updated);
    res.json({ ok: true, trade: updated });
    creditSellers(transactionId).catch((e) => console.error("credit sellers failed:", e));
  } catch (err) {
    console.error("deliver failed:", err);
    res.status(500).json({ error: String(err) });
  } finally {
    delivering.delete(transactionId);
  }
});

// Pay every pooled seller their own share into THEIR wallet on the Seller
// Platform (idempotent there, so a retry can never double-pay).
async function creditSellers(transactionId) {
  const trade = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(trade.block_id);
  const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(block.id);
  const d = disaggregate(block, members, trade);
  for (const m of d.memberPayouts || []) {
    const body = { transactionId, blockId: block.id, offerId: m.offerId, allocatedKwh: m.allocatedQty, deliveredKwh: m.deliveredShare, gross: m.gross, wheeling: m.wheeling, penalty: m.penalty, net: m.net };
    let r = await sellerCall("/api/credit", body);
    if (!r.ok) { await new Promise((ok) => setTimeout(ok, 3000)); r = await sellerCall("/api/credit", body); }
    if (!r.ok) logEvent(block.id, `Could not credit ₹${m.net.toFixed(2)} to ${m.offerId}: ${r.error || "seller platform unreachable"}`);
  }
}

// Pull the unsold part of a block off the market and hand that capacity back to
// the pooled sellers, so it can be sold directly or pooled again.
app.post("/api/blocks/:id/withdraw", async (req, res) => {
  const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(req.params.id);
  if (!block) return res.status(404).json({ error: "block not found" });
  const unsold = round2(block.remaining_qty);
  if (unsold <= 0.001) return res.status(409).json({ error: "Nothing unsold on this block — nothing to withdraw." });
  // Claim it first so a second click / a racing buyer can't also take it.
  db.prepare("UPDATE blocks SET remaining_qty = 0, withdrawn_qty = COALESCE(withdrawn_qty,0) + ? WHERE id=?").run(unsold, block.id);
  await releaseToSellers(block, unsold);
  logEvent(block.id, `Withdrew ${unsold} kWh unsold from the market — capacity handed back to the pooled sellers`);
  broadcast("block_published", { id: block.id });
  res.json({ ok: true, withdrawnKwh: unsold });
});

// Reserve an open-market block for a DISCOM requirement after the fact (e.g. it
// was published with "None" by mistake), so the DISCOM's own dashboard can buy it.
app.post("/api/blocks/:id/assign", (req, res) => {
  const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(req.params.id);
  if (!block) return res.status(404).json({ error: "block not found" });
  const requirementId = req.body?.requirementId;
  const requirement = db.prepare("SELECT * FROM requirements WHERE id=?").get(requirementId);
  if (!requirement) return res.status(404).json({ error: "requirement not found" });
  if (block.requirement_id) return res.status(409).json({ error: `Block is already reserved for ${block.requirement_id}` });
  if (requirement.status === "FULFILLED") return res.status(409).json({ error: `${requirement.id} is already fully bought` });
  if (block.blended_price_per_kwh > requirement.max_price_per_kwh) return res.status(409).json({ error: `Block price ₹${block.blended_price_per_kwh}/kWh is above ${requirement.id}'s ₹${requirement.max_price_per_kwh}/kWh ceiling` });
  if (block.remaining_qty <= 0.001) return res.status(409).json({ error: "This block has nothing left to sell" });
  const uncovered = round2(requirement.quantity_kwh - (requirement.fulfilled_qty || 0) - openQtyFor(requirement.id));
  if (block.remaining_qty > uncovered + 0.011) return res.status(409).json({ error: `Only ${Math.max(0, uncovered)} kWh of ${requirement.id} is still uncovered, but this block has ${block.remaining_qty} kWh unsold — withdraw part of it first or pick another requirement.` });
  db.prepare("UPDATE blocks SET requirement_id=? WHERE id=?").run(requirement.id, block.id);
  db.prepare("UPDATE requirements SET status=?, block_id=? WHERE id=? AND status != ?").run("PUBLISHED", block.id, requirement.id, "FULFILLED");
  logEvent(block.id, `Reserved for DISCOM requirement ${requirement.id}`);
  broadcast("block_published", { id: block.id });
  res.json({ ok: true });
});

// The aggregator's wallet history: one entry per settled trade, showing the
// whole chain -- what the bulk buyer paid, what the aggregator received, what
// went to each pooled seller, and what was left.
app.get("/api/wallet/history", (req, res) => {
  const entries = [];
  for (const t of db.prepare("SELECT * FROM trades WHERE status IN ('SETTLED','ACTIVE')").all()) {
    const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(t.block_id);
    if (!block) continue;
    const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(block.id);
    const buyer = t.bap_id === "buyerapp.example.com" ? "bulk buyer" : t.bap_id;
    if (t.status === "ACTIVE") {
      entries.push({ id: t.transaction_id, at: t.updated_at, kind: "pending", amount: null, title: `Block ${block.id}`, subtitle: `${t.requested_qty} kWh @ ₹${t.price_per_kwh}/kWh to ${buyer} — waiting for delivery`, transactionId: t.transaction_id,
        lines: [L("Sold", `${t.requested_qty} kWh @ ₹${t.price_per_kwh}/kWh`), L("Planned margin if delivered in full", `₹${block.margin_per_kwh}/kWh × ${t.requested_qty} kWh = ${inr(round2(block.margin_per_kwh * t.requested_qty))}`), L("Status", "Nothing is credited or paid out until you report each seller's meter reading")] });
      continue;
    }
    const d = disaggregate(block, members, t);
    const lines = [
      L("Bulk buyer paid", inr(d.buyerPayable), { strong: true }),
      L(`energy ${d.finalAlloc} kWh × ₹${d.pricePerKwh}/kWh = ${inr(d.tradeValue)}, plus buyer-side wheeling ${inr(d.wheelingBuyerTotal)} (wheeling goes to the network)`, "", { note: true }),
      L("Aggregator received (as the publishing seller)", inr(d.settlementAmount), { strong: true }),
      L(`energy ${inr(d.tradeValue)} − seller-side wheeling ${inr(d.wheelingSellerTotal)}${d.penalty > 0 ? ` − shortfall penalty ${inr(d.penalty)}` : ""}`, "", { note: true }),
    ];
    for (const m of d.memberPayouts) {
      lines.push(L(`− Paid to ${m.offerId}: ${m.deliveredShare} of ${m.allocatedQty} kWh delivered`, inr(-m.net)));
      lines.push(L(`gross ${m.deliveredShare} kWh × ₹${m.originalPricePerKwh} = ${inr(m.gross)} − wheeling ${inr(m.wheeling)}${m.penalty > 0 ? ` − their shortfall penalty ${inr(m.penalty)}` : ""}`, "", { note: true }));
    }
    lines.push(L("= Margin kept (received − paid to sellers)", inr(d.aggregatorMargin), { strong: true }));
    const planned = round2(block.margin_per_kwh * d.finalAlloc);
    const mix = round2(d.aggregatorMargin - planned);
    lines.push(L(`Planned margin: ₹${block.margin_per_kwh}/kWh × ${d.finalAlloc} kWh delivered`, inr(planned)));
    if (Math.abs(mix) > 0.005) {
      lines.push(L(`Difference vs plan`, inr(mix)));
      lines.push(L("Why it differs", "The block price was set from the average of the sellers' prices if everyone delivered their share. Here the sellers delivered different amounts, so the delivered energy cost the aggregator a different average price than planned — the gap is exactly that mix effect (and cents of rounding). Each seller's penalty is charged to that seller, not to the aggregator.", { note: true }));
    }
    entries.push({ id: t.transaction_id, at: t.updated_at, kind: "settled", amount: d.aggregatorMargin, title: `Block ${block.id}`, subtitle: `${d.finalAlloc} of ${t.requested_qty} kWh delivered to ${buyer} · paid ${d.memberPayouts.length} seller${d.memberPayouts.length === 1 ? "" : "s"}`, transactionId: t.transaction_id, lines });
  }
  res.json(finish(entries));
});

// The aggregator's wallet: cash received from bulk buyers, cash paid out to
// pooled sellers, and what it kept.
app.get("/api/wallet", (req, res) => {
  let received = 0, paidOut = 0;
  for (const t of db.prepare("SELECT * FROM trades WHERE status='SETTLED'").all()) {
    const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(t.block_id);
    if (!block) continue;
    const d = disaggregate(block, db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(block.id), t);
    received += t.settlement_amount || 0;
    paidOut += d.sumMemberNet || 0;
  }
  const inEscrow = db.prepare("SELECT COALESCE(SUM(requested_qty * price_per_kwh),0) AS v FROM trades WHERE status='ACTIVE'").get().v;
  res.json({ total: round2(received - paidOut), received: round2(received), paidOut: round2(paidOut), inEscrow: round2(inEscrow) });
});

// ---------- Blocks list + disaggregation ----------
// Full breakdown, not just the final numbers — every figure a reader would
// need to verify "where did the aggregator's margin actually come from"
// by hand, same transparency standard as seller-app's own settlement math.
function disaggregate(block, members, trade) {
  const finalAlloc = trade?.final_alloc ?? null;
  const settlementAmount = trade?.settlement_amount ?? null;
  const status = trade?.status || "AWAITING_BUYER";
  if (finalAlloc == null || settlementAmount == null || status !== "SETTLED") {
    return { status, finalAlloc, settlementAmount, memberPayouts: null, aggregatorMargin: null };
  }
  const requestedQty = trade.requested_qty;
  const pricePerKwh = trade.price_per_kwh;
  const bulk = computeSettlement({ requestedQty, finalAlloc, pricePerKwh });
  const deliveryRatio = requestedQty > 0 ? finalAlloc / requestedQty : 0;
  const readings = (() => { try { return trade.readings ? JSON.parse(trade.readings) : null; } catch (_) { return null; } })();
  const memberPayouts = tradeAllocations(members, requestedQty).map(({ m, alloc }) => {
    // Each seller is settled on THEIR OWN metered delivery. (Rows from before
    // per-seller readings existed fall back to an even pro-rata split.)
    const delivered = round2(Math.min(alloc, readings && readings[m.offer_id] != null ? readings[m.offer_id] : alloc * deliveryRatio));
    const shortfall = round2(alloc - delivered);
    const gross = round2(delivered * m.price_per_kwh);
    const wheeling = round2(delivered * WHEELING_CHARGE_SELLER_PER_KWH);
    // The shortfall penalty falls on the seller who caused it, not on the
    // aggregator or on the sellers who delivered in full.
    const penalty = round2(shortfall * PENALTY_RATE_PER_KWH);
    const net = round2(gross - wheeling - penalty);
    return { offerId: m.offer_id, sellerId: m.seller_id, originalPricePerKwh: m.price_per_kwh, enrolledQty: m.enrolled_qty, allocatedQty: alloc, deliveredShare: delivered, shortfall, gross, wheeling, penalty, net };
  });
  const sumMemberNet = round2(memberPayouts.reduce((s, m) => s + m.net, 0));
  const aggregatorMargin = round2(settlementAmount - sumMemberNet);
  // What the margin was *supposed* to be (quantity published × the margin
  // rate set at publish time) vs what it actually came out to — they
  // diverge whenever there's a delivery shortfall, because the penalty and
  // the buyer/seller wheeling asymmetry eat into the realized margin in a
  // way the flat per-kWh rate never accounted for (see KNOWLEDGE-BASE.md
  // §9 risk #2 — this is that gap, shown numerically rather than just
  // asserted).
  // Per trade: a block can be sold in several separate trades, and the margin
  // intended on THIS trade is the rate times the quantity THIS trade bought.
  const intendedMargin = round2(block.margin_per_kwh * requestedQty);
  return {
    status, finalAlloc, settlementAmount, deliveryRatio: round2(deliveryRatio), memberPayouts, sumMemberNet, aggregatorMargin,
    requestedQty, pricePerKwh, shortfallKwh: bulk.shortfallKwh, tradeValue: bulk.tradeValue,
    wheelingSellerTotal: bulk.wheelingSeller, wheelingBuyerTotal: bulk.wheelingBuyer, penalty: bulk.penalty,
    buyerPayable: bulk.buyerPayable, intendedMargin,
  };
}

function latestTradeForBlock(blockId) {
  return db.prepare("SELECT * FROM trades WHERE block_id=? ORDER BY created_at DESC LIMIT 1").get(blockId);
}

// Every trade against a block, each with its own settlement breakdown. A
// block can be sold in more than one trade (e.g. part to grid-app, the rest
// to buyer-app); showing only the latest one hid earlier ACTIVE trades, which
// then could never have their delivery reported.
function tradesForBlock(block, members) {
  return db.prepare("SELECT * FROM trades WHERE block_id=? AND status != 'DECLINED' ORDER BY created_at ASC").all(block.id).map((t) => ({
    transactionId: t.transaction_id,
    bapId: t.bap_id,
    requestedQty: t.requested_qty,
    pricePerKwh: t.price_per_kwh,
    status: t.status,
    allocations: t.status === "ACTIVE" ? tradeAllocations(members, t.requested_qty).map(({ m, alloc }) => ({ offerId: m.offer_id, sellerId: m.seller_id, pricePerKwh: m.price_per_kwh, allocatedKwh: alloc })) : [],
    disaggregation: disaggregate(block, members, t),
  }));
}

app.get("/api/blocks", (req, res) => {
  try {
    const blocks = db.prepare("SELECT * FROM blocks ORDER BY published_at DESC").all();
    const out = blocks.map((b) => {
      const trade = latestTradeForBlock(b.id);
      const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(b.id);
      return {
        ...b,
        reserved_for_requirement: b.requirement_id || null,
        activeTransactionId: trade && trade.status === "ACTIVE" ? trade.transaction_id : null,
        tradeStatus: trade ? trade.status : null,
        disaggregation: disaggregate(b, members, trade),
        trades: tradesForBlock(b, members),
      };
    });
    res.json(out);
  } catch (err) {
    console.error("blocks list failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/blocks/:id", (req, res) => {
  const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(req.params.id);
  if (!block) return res.status(404).json({ error: "block not found" });
  const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(block.id);
  const trade = latestTradeForBlock(block.id);
  res.json({ ...block, members, disaggregation: disaggregate(block, members, trade) });
});

app.get("/api/blocks/:id/events", (req, res) => {
  const rows = db.prepare("SELECT * FROM events WHERE block_id=? ORDER BY id ASC").all(req.params.id);
  res.json(rows);
});

// ---------- Reset: wipe this platform's own data for a fresh demo run ----------
app.post("/api/reset", (req, res) => {
  try {
    db.exec("DELETE FROM trades");
    db.exec("DELETE FROM pool_members");
    db.exec("DELETE FROM blocks");
    db.exec("DELETE FROM requirements");
    db.exec("DELETE FROM events");
    broadcast("reset", {});
    res.json({ ok: true });
  } catch (err) {
    console.error("reset failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- Reset the WHOLE demo: this platform, then every other one ----------
// See seller-app/server.js's /api/reset-all for why a half-reset is illogical.
app.post("/api/reset-all", async (req, res) => {
  const results = { aggregator: "ok" };
  try {
    db.exec("DELETE FROM trades"); db.exec("DELETE FROM pool_members"); db.exec("DELETE FROM blocks");
    db.exec("DELETE FROM requirements"); db.exec("DELETE FROM events");
    broadcast("reset", {});
  } catch (err) { results.aggregator = String(err); }
  await Promise.all(Object.entries({ seller: SELLER_APP_URL, buyer: BUYER_APP_URL, grid: GRID_APP_URL }).map(async ([name, url]) => {
    try {
      const r = await fetch(`${url}/api/reset`, { method: "POST" });
      results[name] = r.ok ? "ok" : `HTTP ${r.status}`;
    } catch (e) { results[name] = `unreachable (${e.message || e})`; }
  }));
  res.json({ ok: Object.values(results).every((v) => v === "ok"), results });
});

server.listen(PORT, () => {
  console.log(`Aggregator Platform listening on http://localhost:${PORT}`);
  console.log(`  → discovering via buyer-app at ${peers.BUYER_APP_URL}`);
  console.log(`  → cross-checking seller-app's live catalog at ${peers.SELLER_APP_URL}`);
  console.log(`  → publishing + own lifecycle via onix-aggregatorapp`);
  console.log(`  → webhook target for onix: http://host.docker.internal:${PORT}/api/webhook`);
});

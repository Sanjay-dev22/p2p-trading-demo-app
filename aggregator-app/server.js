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
const beckn = require("./beckn");

const PORT = process.env.PORT || 4003;

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
  const shortfallKwh = Math.max(0, requestedQty - finalAlloc);
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
      "Disaggregates the block's one real delivered-quantity reading proportionally across members (no per-member smart meter in this demo) — a real deployment would use each member's own real meter reading, per the 'virtual meter' reconciliation approach the real IES implementation guide describes.",
      "Grid/DISCOM (grid-app) now has its own onix identity and executes the real discover/buy/confirm itself (Phase 2) — reusing buyer-app's already-registered keys (buyerapp.example.com) rather than a newly-registered identity, the same no-new-DeDi-registration trick used for this app's own identity above. buyer-app remains a fully independent bulk buyer that can see and buy the same public block too — whoever confirms first gets it; the loser's requirement just stays unfulfilled until a fresh pool is recommended.",
    ],
  });
});

// ---------- Discover: proxy through buyer-app's own real discover ----------
app.post("/api/discover", async (req, res) => {
  try {
    const result = await peers.triggerDiscover();
    if (!result.ok) return res.status(result.status || 502).json({ error: "buyer-app rejected the discover trigger", detail: result.json, raw: result.text });
    res.json({ ok: true });
  } catch (err) {
    console.error("discover failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Real offers buyer-app has actually discovered, minus whatever is already
// enrolled in the current pending pool (no double-pooling the same offer).
// See resolveOffer()-style cross-check comment in peers.js for why this
// checks seller-app's own live catalog rather than trusting seller_id.
async function listAvailableOffers() {
  const discovered = await peers.fetchDiscoveredOffers();
  const ownOffers = await peers.fetchSellerOffers();
  const ownById = new Map(ownOffers.map((o) => [o.id, o]));
  // Excludes an offer the moment it's EVER been enrolled, not only while its
  // pool is still pending (block_id IS NULL) — found live: because pooling
  // never reserves capacity on seller-app's own catalog (the disclosed gap
  // in listAvailableOffers below this fix used to only guard against), an
  // offer already locked into a published block would still show up as
  // "available" and could be pooled into a SECOND, different block, double-
  // selling the same physical seller capacity. Once an offer is unenrolled
  // (DELETE /api/pool/unenroll, only possible pre-publish) its row is gone
  // from pool_members entirely, so it correctly becomes available again.
  const everPooled = db.prepare("SELECT DISTINCT offer_id FROM pool_members").all().map((r) => r.offer_id);
  return discovered
    .filter((o) => ownById.has(o.offer_id) && !everPooled.includes(o.offer_id))
    .map((o) => {
      const own = ownById.get(o.offer_id);
      return { ...o, price_per_kwh: own.price_per_kwh, available_qty: own.remaining_qty };
    })
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
    if (quantity > own.remaining_qty) {
      return res.status(409).json({ error: `Only ${own.remaining_qty} kWh remains available on ${offerId} right now -- ${quantity} kWh was requested.` });
    }
    const now = peers.nowIso();
    db.prepare("INSERT INTO pool_members (block_id, offer_id, seller_id, price_per_kwh, enrolled_qty, enrolled_at) VALUES (NULL,?,?,?,?,?)").run(
      offerId, sellerId || "unknown", price, quantity, now
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

app.get("/api/requirements", (req, res) => {
  res.json(db.prepare("SELECT * FROM requirements ORDER BY created_at DESC").all());
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
    const neededQty = round2(Math.max(0, requirement.quantity_kwh - alreadyBought));

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
    const isTopUp = requirement && (requirement.fulfilled_qty || 0) > 0;
    if (members.length < 2 && !isTopUp) {
      return res.status(400).json({ error: "pool a least 2 small offers before publishing a block" });
    }
    if (members.length < 1) {
      return res.status(400).json({ error: "pool at least 1 small offer before publishing a block" });
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

    const { context, message } = beckn.buildPublishCatalog({ offerId, quantityKwh: totalQty, pricePerKwh: blockPrice, memberCount: members.length });
    const result = await beckn.postToOnix("/bpp/caller/catalog/publish", { context, message });
    if (!result.ok) {
      console.error("publish rejected by onix-aggregatorapp:", result.status, result.text);
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
    .prepare("SELECT id, total_quantity_kwh AS quantity_kwh, remaining_qty, blended_price_per_kwh AS price_per_kwh, published_at FROM blocks ORDER BY published_at DESC")
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

      if (!block || !requestedQty || requestedQty > block.remaining_qty) {
        // Same category as seller-app's own "decline" path: no response
        // sent back is valid Beckn behavior. Likely only reachable via a
        // race (two inits for the same block in quick succession) since
        // buyer-app's own pre-flight already checks remaining_qty first.
        logEvent(blockId, `Declined (no response sent) — requested ${requestedQty ?? "?"} kWh exceeds ${block ? block.remaining_qty : "(block not found)"} kWh remaining`);
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
      if (row) {
        logEvent(row.block_id, "Buyer confirmed");
        const onConfirm = beckn.buildOnConfirm(context, message.contract);
        beckn
          .postToOnix("/bpp/caller/on_confirm", onConfirm)
          .then((result) => {
            const now = beckn.nowIso();
            db.prepare("UPDATE trades SET status=?, raw_context=?, updated_at=? WHERE transaction_id=?").run("ACTIVE", JSON.stringify(onConfirm), now, context.transactionId);
            logEvent(row.block_id, "Trade is now ACTIVE");
            broadcast("active", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
            if (!result.ok) console.error("on_confirm send failed:", result.status, result.json);
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

app.get("/api/deliver/:transactionId/suggest", (req, res) => {
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(req.params.transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  const suggested = Math.round(row.requested_qty * (0.85 + Math.random() * 0.2) * 10) / 10;
  res.json({ requestedQty: row.requested_qty, suggestedFinalAlloc: suggested });
});

// ---------- Report delivery: real on_status (settled) ----------
app.post("/api/deliver/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "ACTIVE") return res.status(409).json({ error: `trade is ${row.status}, not ACTIVE` });

  const finalAlloc = Number(req.body.finalAlloc);
  if (!finalAlloc || finalAlloc <= 0) return res.status(400).json({ error: "finalAlloc (the delivered kWh reading) must be a positive number" });

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
    db.prepare("UPDATE trades SET status=?, final_alloc=?, settlement_amount=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
      "SETTLED", finalAlloc, settlementAmount, JSON.stringify(onStatus), now, transactionId
    );
    logEvent(row.block_id, `Reported ${finalAlloc} kWh delivered — settled ₹${settlementAmount.toFixed(2)} — disaggregation now available`);
    const updated = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId));
    broadcast("settled", updated);
    res.json({ ok: true, trade: updated });
  } catch (err) {
    console.error("deliver failed:", err);
    res.status(500).json({ error: String(err) });
  }
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
  const deliveryRatio = block.total_quantity_kwh > 0 ? finalAlloc / block.total_quantity_kwh : 0;
  const memberPayouts = members.map((m) => {
    const delivered = round2(m.enrolled_qty * deliveryRatio);
    const gross = round2(delivered * m.price_per_kwh);
    const wheeling = round2(delivered * WHEELING_CHARGE_SELLER_PER_KWH);
    const net = round2(gross - wheeling);
    return { offerId: m.offer_id, sellerId: m.seller_id, originalPricePerKwh: m.price_per_kwh, enrolledQty: m.enrolled_qty, deliveredShare: delivered, gross, wheeling, net };
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
  const intendedMargin = round2(block.margin_per_kwh * block.total_quantity_kwh);
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

app.get("/api/blocks", (req, res) => {
  try {
    const blocks = db.prepare("SELECT * FROM blocks ORDER BY published_at DESC").all();
    const out = blocks.map((b) => {
      const trade = latestTradeForBlock(b.id);
      const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(b.id);
      return {
        ...b,
        activeTransactionId: trade && trade.status === "ACTIVE" ? trade.transaction_id : null,
        tradeStatus: trade ? trade.status : null,
        disaggregation: disaggregate(b, members, trade),
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

server.listen(PORT, () => {
  console.log(`Aggregator Platform listening on http://localhost:${PORT}`);
  console.log(`  → discovering via buyer-app at ${peers.BUYER_APP_URL}`);
  console.log(`  → cross-checking seller-app's live catalog at ${peers.SELLER_APP_URL}`);
  console.log(`  → publishing + own lifecycle via onix-aggregatorapp`);
  console.log(`  → webhook target for onix: http://host.docker.internal:${PORT}/api/webhook`);
});

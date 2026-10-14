// Aggregator Platform — pools several small real seller offers into one
// larger block, publishes that block through seller-app's own existing
// pipeline, and once the real bulk trade settles, disaggregates the one
// real settlement amount back down to each pooled seller. See peers.js's
// header comment for why this talks to seller-app/buyer-app's own REST
// APIs rather than to onix directly, and p2p-trading-app/KNOWLEDGE-BASE.md
// for the full write-up.
//
// Grounded in the real IES P2P trading implementation guide
// (ies-devkit/docs/implementation-guides/v2/P2P_Trading/
// P2P_Trading_implementation_guide_DRAFT.md), which names this exact
// mechanism: "Virtual meters enable aggregators to balance supply and
// demand across multiple participants." This app is a first, deliberately
// simplified demo of that mechanism, not the full production design — see
// the "known simplifications" block below.
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const db = require("./db");
const peers = require("./peers");

const PORT = process.env.PORT || 4003;

// Mirrors the real enforced policy's wheeling rate (see seller-app/
// server.js's own identical constant and its comment on why this has to
// be kept in sync by hand — this app has no way to read the real .rego
// file directly either). Used only to disaggregate a known total back to
// each member at THEIR OWN original price — never to recompute the real
// settlement itself, which seller-app's own linked policy already did.
const WHEELING_CHARGE_SELLER_PER_KWH = 0.5;
const DEFAULT_MARGIN_PER_KWH = 0.3;
const round2 = (x) => Math.round(x * 100) / 100;

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
  db.prepare("INSERT INTO events (block_id, summary, at) VALUES (?,?,?)").run(blockId, summary, peers.nowIso());
}

app.get("/api/health", (req, res) => res.status(200).send("ok"));

// ---------- Known simplifications, surfaced to the UI, not hidden ----------
app.get("/api/about", (req, res) => {
  res.json({
    simplifications: [
      "Publishes through seller-app's own real onix identity rather than registering as a distinct network participant — the production design needs its own onix instance + registry entry.",
      "Pools once, at publish time — no re-aggregation as individual sellers' availability changes mid-window.",
      "Uses a simple sum of enrolled quantity, not a confidence-adjusted ('firm capacity') lower bound.",
      "Disaggregates the block's one real delivered-quantity reading proportionally across members (no per-member smart meter in this demo) — a real deployment would use each member's own real meter reading, per the 'virtual meter' reconciliation approach the real IES implementation guide describes.",
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
//
// FOUND DURING LIVE USE, FIXED HERE: this used to trust discover's own
// seller_id field to decide what's "ours" to pool. That field is the
// devkit's own generic tutorial identity ("sellerapp.example.com"), not a
// unique one -- real, unrelated testers on the shared sandbox never
// renamed it either, so every one of their real offers looked identical to
// ours. The only real check is the same one buyer-app's resolveOffer()
// already uses: is this exact offer_id actually sitting in seller-app's own
// live catalog, right now. Anything that isn't is excluded here, before it
// can ever be enrolled -- not just warned about after the fact.
app.get("/api/available-offers", async (req, res) => {
  try {
    const discovered = await peers.fetchDiscoveredOffers();
    const ownOffers = await peers.fetchSellerOffers();
    const ownById = new Map(ownOffers.map((o) => [o.id, o]));
    const pending = db.prepare("SELECT offer_id FROM pool_members WHERE block_id IS NULL").all().map((r) => r.offer_id);
    const available = discovered
      .filter((o) => ownById.has(o.offer_id) && !pending.includes(o.offer_id))
      .map((o) => {
        // seller-app's own remaining_qty is the real, current, authoritative
        // number -- the discovered_offers row can be stale (sold since, or
        // simply an older snapshot from the last discover).
        const own = ownById.get(o.offer_id);
        return { ...o, price_per_kwh: own.price_per_kwh, available_qty: own.remaining_qty };
      })
      .filter((o) => o.price_per_kwh && o.available_qty > 0);
    res.json(available);
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

// Never trusts the client alone (same philosophy as seller-app's own
// /api/respond capacity check) -- re-verifies server-side that this exact
// offer is still genuinely ours and still has enough real remaining
// capacity, right before accepting the enrollment. The UI's own
// /api/available-offers list is already filtered, but that's a courtesy;
// this is what actually stops a stale or manipulated request.
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

// ---------- Publish the pooled block ----------
// Computes the blended price + margin, then publishes through seller-app's
// own real /api/publish — the pooled block becomes one of seller-app's
// real, live, tradeable catalog offers from that point on.
app.post("/api/pool/publish", async (req, res) => {
  try {
    const marginPerKwh = Number(req.body?.marginPerKwh);
    const margin = marginPerKwh > 0 ? marginPerKwh : DEFAULT_MARGIN_PER_KWH;

    const members = db.prepare("SELECT * FROM pool_members WHERE block_id IS NULL").all();
    if (members.length < 2) {
      return res.status(400).json({ error: "pool a least 2 small offers before publishing a block" });
    }

    // Re-verify every member right before publishing, not just at enroll
    // time -- real time passes between the two (someone else could have
    // bought part of a pooled offer directly in the meantime, since
    // enrolling never reserves it -- see KNOWLEDGE-BASE.md §9's documented
    // gap on this). Refuses to publish a block built on stale numbers
    // rather than silently overstating what's actually still available.
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

    const result = await peers.publishBlock({ quantityKwh: totalQty, pricePerKwh: blockPrice });
    if (!result.ok || !result.json?.ok) {
      console.error("publishBlock rejected:", result.status, result.text);
      const reason = result.json?.error || result.json?.message?.error?.message || (result.text && result.text.trim()) || `seller-app returned HTTP ${result.status || "(no response)"}`;
      return res.status(result.status || 502).json({ error: reason, detail: result.json, raw: result.text });
    }
    const offerId = result.json.offer.id;
    const now = peers.nowIso();

    db.prepare(
      "INSERT INTO blocks (id, total_quantity_kwh, blended_price_per_kwh, margin_per_kwh, member_count, published_at) VALUES (?,?,?,?,?,?)"
    ).run(offerId, totalQty, blockPrice, margin, members.length, now);

    db.prepare("UPDATE pool_members SET block_id=? WHERE block_id IS NULL").run(offerId);

    logEvent(offerId, `Published block ${offerId}: ${totalQty} kWh @ ₹${blockPrice}/kWh (blended ₹${round2(blendedBase)} + ₹${margin} margin) from ${members.length} pooled sellers`);
    broadcast("block_published", { id: offerId });
    res.json({ ok: true, block: db.prepare("SELECT * FROM blocks WHERE id=?").get(offerId) });
  } catch (err) {
    console.error("pool/publish failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Persists the real settlement onto the block's own row the first time it's
// seen SETTLED — found missing during the live verification pass: without
// this, the blocks table's bulk_transaction_id/bulk_settlement_amount/
// settled_at columns stayed permanently NULL forever, even after a real
// settlement, because the UI only ever read the live-recomputed
// disaggregation object and nothing ever wrote the result back. A durable
// record of a real settled outcome shouldn't depend on an in-memory
// computation happening to run again later.
function persistSettlementIfNew(block, sellerTrade) {
  if (block.bulk_transaction_id || !sellerTrade || sellerTrade.status !== "SETTLED") return;
  db.prepare("UPDATE blocks SET bulk_transaction_id=?, bulk_settlement_amount=?, settled_at=? WHERE id=?").run(
    sellerTrade.transactionId, sellerTrade.settlementAmount, peers.nowIso(), block.id
  );
  logEvent(block.id, `Bulk trade ${sellerTrade.transactionId} settled at ₹${sellerTrade.settlementAmount} — disaggregation now available`);
}

// ---------- Blocks list + disaggregation ----------
function disaggregate(block, members, sellerTrade) {
  const finalAlloc = sellerTrade?.finalAlloc ?? null;
  const settlementAmount = sellerTrade?.settlementAmount ?? null;
  const status = sellerTrade?.status || "AWAITING_BUYER";
  if (finalAlloc == null || settlementAmount == null || status !== "SETTLED") {
    return { status, finalAlloc, settlementAmount, memberPayouts: null, aggregatorMargin: null };
  }
  const deliveryRatio = block.total_quantity_kwh > 0 ? finalAlloc / block.total_quantity_kwh : 0;
  const memberPayouts = members.map((m) => {
    const delivered = round2(m.enrolled_qty * deliveryRatio);
    const gross = round2(delivered * m.price_per_kwh);
    const wheeling = round2(delivered * WHEELING_CHARGE_SELLER_PER_KWH);
    const net = round2(gross - wheeling);
    return { offerId: m.offer_id, sellerId: m.seller_id, originalPricePerKwh: m.price_per_kwh, enrolledQty: m.enrolled_qty, deliveredShare: delivered, net };
  });
  const sumMemberNet = round2(memberPayouts.reduce((s, m) => s + m.net, 0));
  const aggregatorMargin = round2(settlementAmount - sumMemberNet);
  return { status, finalAlloc, settlementAmount, deliveryRatio: round2(deliveryRatio), memberPayouts, sumMemberNet, aggregatorMargin };
}

app.get("/api/blocks", async (req, res) => {
  try {
    const blocks = db.prepare("SELECT * FROM blocks ORDER BY published_at DESC").all();
    const sellerTrades = await peers.fetchSellerTrades();
    const out = blocks.map((b) => {
      const trade = sellerTrades.find((t) => t.offerId === b.id);
      persistSettlementIfNew(b, trade);
      const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(b.id);
      return { ...b, disaggregation: disaggregate(b, members, trade) };
    });
    res.json(out);
  } catch (err) {
    console.error("blocks list failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/blocks/:id", async (req, res) => {
  const block = db.prepare("SELECT * FROM blocks WHERE id=?").get(req.params.id);
  if (!block) return res.status(404).json({ error: "block not found" });
  const members = db.prepare("SELECT * FROM pool_members WHERE block_id=?").all(block.id);
  const sellerTrades = await peers.fetchSellerTrades();
  const trade = sellerTrades.find((t) => t.offerId === block.id);
  persistSettlementIfNew(block, trade);
  res.json({ ...db.prepare("SELECT * FROM blocks WHERE id=?").get(block.id), members, disaggregation: disaggregate(block, members, trade) });
});

app.get("/api/blocks/:id/events", (req, res) => {
  const rows = db.prepare("SELECT * FROM events WHERE block_id=? ORDER BY id ASC").all(req.params.id);
  res.json(rows);
});

// ---------- Reset: wipe this platform's own data for a fresh demo run ----------
app.post("/api/reset", (req, res) => {
  try {
    db.exec("DELETE FROM pool_members");
    db.exec("DELETE FROM blocks");
    db.exec("DELETE FROM events");
    broadcast("reset", {});
    res.json({ ok: true });
  } catch (err) {
    console.error("reset failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Aggregator Platform listening on http://localhost:${PORT}`);
  console.log(`  → discovering via buyer-app at ${peers.BUYER_APP_URL}`);
  console.log(`  → publishing via seller-app at ${peers.SELLER_APP_URL}`);
});

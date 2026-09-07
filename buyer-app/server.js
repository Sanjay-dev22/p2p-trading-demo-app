// Buyer Platform — the real business-logic app behind onix-buyerapp,
// replacing the fidedocker/sandbox-2.0 fixture-replay stub. See
// p2p-trading-app/DEMO-APP-PLAN.md for the design this implements.
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const db = require("./db");
const beckn = require("./beckn");

const PORT = process.env.PORT || 4001;
// The one real seller we can actually transact with — its own REST API is
// the authoritative source of truth for what's really published right now
// (a discovered_offers row can be stale: reset, sold, or long expired).
const SELLER_APP_URL = process.env.SELLER_APP_URL || "http://localhost:4002";

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

function tradeRow(row) {
  return {
    transactionId: row.transaction_id,
    offerId: row.offer_id,
    bppId: row.bpp_id,
    buyerDiscom: row.buyer_discom,
    requestedQty: row.requested_qty,
    pricePerKwh: row.price_per_kwh,
    status: row.status,
    settlementAmount: row.settlement_amount,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get("/api/health", (req, res) => res.status(200).send("ok"));

app.get("/api/offers", (req, res) => {
  res.json(db.prepare("SELECT * FROM discovered_offers ORDER BY discovered_at DESC").all());
});

app.get("/api/trades", (req, res) => {
  res.json(db.prepare("SELECT * FROM trades ORDER BY created_at DESC").all().map(tradeRow));
});

app.get("/api/personas", (req, res) => {
  res.json({ allowed: beckn.DISCOM_ALLOWED, blocked: beckn.DISCOM_BLOCKED });
});

// ---------- Resolve a single offer ID down to trustworthy real values ----------
// Never let the price, quantity, or "is this real" question be answered by
// user input or a possibly-stale discovered_offers cache row alone. Three
// possible outcomes:
//   1. buyable — it's on our own real trading partner's live catalog right
//      now (checked directly against the Seller Platform's own REST API,
//      not our own copy of a past discover response).
//   2. found but not buyable — either a genuinely different real network
//      participant's offer (seen via a real discover; this demo has no
//      live routing endpoint for their platform, since resolving a real
//      bppUri for a foreign participant needs a DeDi registry lookup this
//      app doesn't do), or one of our own seller's offers that used to be
//      live but no longer is (reset/removed since it was discovered).
//   3. not found at all — never seen anywhere.
async function resolveOffer(offerId) {
  try {
    const sellerOffers = await fetch(`${SELLER_APP_URL}/api/offers`).then((r) => (r.ok ? r.json() : []));
    const own = sellerOffers.find((o) => o.id === offerId);
    if (own) {
      return { found: true, buyable: true, sellerId: beckn.SELLER_ID, offerId, pricePerKwh: own.price_per_kwh, availableQty: own.quantity_kwh };
    }
  } catch (err) {
    console.error("resolveOffer: could not reach Seller Platform at", SELLER_APP_URL, "—", err.message || err);
  }

  const discovered = db.prepare("SELECT * FROM discovered_offers WHERE offer_id=?").get(offerId);
  if (discovered) {
    const isOwn = discovered.seller_id === beckn.SELLER_ID;
    return {
      found: true,
      buyable: false,
      sellerId: discovered.seller_id,
      offerId,
      pricePerKwh: discovered.price_per_kwh,
      availableQty: discovered.available_qty,
      reason: isOwn
        ? "This offer was published by our own Seller Platform but isn't live there any more (reset or removed since it was discovered) — publish it again to buy it."
        : `This offer belongs to ${discovered.seller_id}, a different real network participant discovered on the shared network. This demo instance has no live routing endpoint for their platform, so it can be viewed but not bought here.`,
    };
  }

  return { found: false, buyable: false, offerId, reason: "Unknown offer ID — never seen via discover, and not published on our own Seller Platform." };
}

app.get("/api/resolve-offer/:offerId", async (req, res) => {
  res.json(await resolveOffer(req.params.offerId));
});

// ---------- Reset: wipe this platform's own data for a fresh demo run ----------
// Only ever touches this app's own database file — the seller platform
// has to be reset separately from its own dashboard, on purpose (see
// ARCHITECTURE.md §2: no shared state between the two platforms, ever).
app.post("/api/reset", (req, res) => {
  try {
    db.exec("DELETE FROM trades");
    db.exec("DELETE FROM discovered_offers");
    broadcast("reset", {});
    res.json({ ok: true });
  } catch (err) {
    console.error("reset failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- fire a real discover ----------
app.post("/api/discover", async (req, res) => {
  try {
    const { context, message } = beckn.buildDiscover();
    const result = await beckn.postToOnix("/bap/caller/discover", { context, message });
    if (!result.ok) {
      console.error("discover rejected by onix:", result.status, result.text);
      return res.status(result.status || 502).json({ error: "onix rejected discover", detail: result.json, raw: result.text });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("discover failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- Buy: real init, works for a discovered offer OR a manually-entered one ----------
app.post("/api/buy", async (req, res) => {
  try {
    const offerId = String(req.body.offerId || "").trim();
    const requestedQty = Number(req.body.quantityKwh);
    const buyerDiscomId = req.body.buyerDiscomId === "blocked" ? beckn.DISCOM_BLOCKED : beckn.DISCOM_ALLOWED;
    if (!offerId || !requestedQty || requestedQty <= 0) {
      return res.status(400).json({ error: "offerId and a positive quantityKwh are required" });
    }

    // Re-resolve server-side right before acting — the UI already runs the
    // same check to show a live status while typing, but that's only a
    // courtesy; this is what actually stops it (the UI check is trivially
    // bypassed by anyone calling this API directly). Price is never taken
    // from the client: it's always the seller's real, currently-published
    // figure, so it can never be haggled down (or up) by editing a form
    // field or a raw request body.
    const resolution = await resolveOffer(offerId);
    if (!resolution.found) return res.status(404).json({ error: resolution.reason });
    if (!resolution.buyable) return res.status(409).json({ error: resolution.reason });
    if (requestedQty > resolution.availableQty) {
      return res.status(400).json({ error: `Only ${resolution.availableQty} kWh is available on this offer — ${requestedQty} kWh was requested.` });
    }
    const pricePerKwh = resolution.pricePerKwh;
    const quantityKwh = requestedQty;

    const { context, message } = beckn.buildInit({ offerId, quantityKwh, pricePerKwh, buyerDiscomId });
    const now = beckn.nowIso();
    const result = await beckn.postToOnix("/bap/caller/init", { context, message });

    if (!result.ok) {
      console.error("init rejected by onix:", result.status, result.text);
      // Real, live policy rejection (e.g. buyerDiscomId = TEST_OUTSIDE_DISCOM) —
      // the contractpolicyenforcer step on onix-sellerapp NACKs synchronously.
      // Fall back through: the real NACK's human-readable message, then the
      // raw response body (covers non-JSON errors — proxies, timeouts,
      // onix-internal errors), then finally the HTTP status itself — never
      // silently store nothing (that produced a bare "null" toast before).
      const errorMessage =
        result.json?.message?.error?.message ||
        (result.text && result.text.trim()) ||
        `onix returned HTTP ${result.status || "(no response)"} with no readable body`;
      db.prepare(
        `INSERT INTO trades (transaction_id, offer_id, bpp_id, buyer_discom, requested_qty, price_per_kwh, status, error_message, raw_context, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(context.transactionId, offerId, beckn.SELLER_ID, buyerDiscomId, quantityKwh, pricePerKwh, "REJECTED", errorMessage, JSON.stringify({ context, message }), now, now);
      const rejected = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId));
      broadcast("rejected", rejected);
      return res.status(200).json({ ok: false, rejected: true, trade: rejected });
    }

    db.prepare(
      `INSERT INTO trades (transaction_id, offer_id, bpp_id, buyer_discom, requested_qty, price_per_kwh, status, raw_context, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(context.transactionId, offerId, beckn.SELLER_ID, buyerDiscomId, quantityKwh, pricePerKwh, "PENDING", JSON.stringify({ context, message }), now, now);

    const trade = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId));
    broadcast("buy_sent", trade);
    res.json({ ok: true, trade });
  } catch (err) {
    console.error("buy failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- inbound webhook: real callbacks from onix-buyerapp's bapTxnReceiver ----------
// on_select | on_init | on_confirm | on_status | on_update | on_cancel |
// on_subscribe | catalog all land here (see
// config/local-p2p-trading-routing-BuyerApp-BapReceiver.yaml).
app.post("/api/bap-webhook/:action", async (req, res) => {
  const action = req.params.action;
  const { context, message } = req.body || {};
  console.log(`[webhook] ${action} — txn=${context?.transactionId || "(none)"}`);

  try {
    if (action === "catalog" || action === "on_discover") {
      // Best-effort parse: the real discover service's exact envelope
      // shape wasn't independently captured ahead of time, so this reads
      // defensively rather than assuming one fixed structure.
      const catalogs = message?.catalogs || message?.catalog?.catalogs || [];
      const now = beckn.nowIso();
      let count = 0;
      for (const cat of catalogs) {
        for (const offer of cat.offers || []) {
          const interval0 = offer?.offerAttributes?.commitmentAttributes?.intervals?.[0];
          const payloads = interval0?.payloads || [];
          const price = payloads.find((p) => p.type === "PRICE_PER_KWH")?.values?.[0];
          const qty = payloads.find((p) => p.type === "AVAILABLE_QTY")?.values?.[0];
          db.prepare(
            `INSERT INTO discovered_offers (offer_id, seller_id, name, price_per_kwh, available_qty, discovered_at, raw_json)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(offer_id) DO UPDATE SET price_per_kwh=excluded.price_per_kwh, available_qty=excluded.available_qty, discovered_at=excluded.discovered_at, raw_json=excluded.raw_json`
          ).run(offer.id, cat.provider?.id || cat.bppId || "unknown", offer.descriptor?.name || offer.id, price ?? null, qty ?? null, now, JSON.stringify(offer));
          count++;
        }
      }
      if (count > 0) broadcast("offers_updated", { count });
    } else if (action === "on_init") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (row) {
        const onConfirm = beckn.buildConfirm(context, message.contract);
        beckn
          .postToOnix("/bap/caller/confirm", onConfirm)
          .then((result) => {
            const now = beckn.nowIso();
            db.prepare("UPDATE trades SET status=?, raw_context=?, updated_at=? WHERE transaction_id=?").run("CONFIRMING", JSON.stringify(onConfirm), now, context.transactionId);
            broadcast("confirming", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
            if (!result.ok) console.error("confirm send failed:", result.status, result.json);
          })
          .catch((e) => console.error("confirm send error:", e));
      }
    } else if (action === "on_confirm") {
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, updated_at=? WHERE transaction_id=?").run("ACTIVE", now, context.transactionId);
      broadcast("active", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
    } else if (action === "on_status") {
      const buyerCost = beckn.extractRevenueFlow(message.contract, "buyerPlatform");
      const settlementAmount = buyerCost != null ? Math.abs(buyerCost) : null;
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, settlement_amount=?, updated_at=? WHERE transaction_id=?").run("SETTLED", settlementAmount, now, context.transactionId);
      broadcast("settled", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
    }
    res.status(200).json(beckn.buildAck(context || {}));
  } catch (err) {
    console.error(`webhook ${action} failed:`, err);
    res.status(200).json(beckn.buildAck(context || {}));
  }
});

server.listen(PORT, () => {
  console.log(`Buyer Platform listening on http://localhost:${PORT}`);
  console.log(`  → talking to onix-buyerapp at ${process.env.ONIX_BUYER_URL || "http://localhost:8081"}`);
  console.log(`  → webhook target for onix: http://host.docker.internal:${PORT}/api/bap-webhook`);
});

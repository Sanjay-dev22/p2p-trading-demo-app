// Seller Platform — the real business-logic app behind onix-sellerapp,
// replacing the fidedocker/sandbox-2.0 fixture-replay stub. See
// p2p-trading-app/DEMO-APP-PLAN.md for the design this implements.
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const db = require("./db");
const beckn = require("./beckn");

const PORT = process.env.PORT || 4002;
// The Buyer Platform's own base URL — used only for a direct, app-to-app
// demo-coordination notification (never a real Beckn message) when this
// seller declines a request or a counter-offer outright. Mirrors the
// existing SELLER_APP_URL pattern already used by buyer-app/server.js's
// resolveOffer()/my-offers — this app already trusts direct REST calls to
// its trading partner for non-protocol bookkeeping, so this is consistent
// with, not a departure from, the existing architecture.
const BUYER_APP_URL = process.env.BUYER_APP_URL || "http://localhost:4001";

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
    bapId: row.bap_id,
    buyerDiscom: row.buyer_discom,
    requestedQty: row.requested_qty,
    pricePerKwh: row.price_per_kwh,
    askingPricePerKwh: row.asking_price_per_kwh,
    counterPricePerKwh: row.counter_price_per_kwh,
    counterQty: row.counter_qty,
    declineReason: row.decline_reason,
    status: row.status,
    finalAlloc: row.final_alloc,
    settlementAmount: row.settlement_amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Protocol/decision timeline — every real Beckn hop plus every
// human decision (accept/counter/decline), in order, per trade. This is
// what answers "where are the internal steps happening": nothing here is
// simulated — each row is logged at the exact moment the real send/receive
// or local decision happened. ----------
function logEvent(transactionId, action, direction, summary, payload) {
  db.prepare("INSERT INTO events (transaction_id, action, direction, summary, payload, at) VALUES (?,?,?,?,?,?)").run(
    transactionId,
    action,
    direction,
    summary || null,
    payload ? JSON.stringify(payload) : null,
    beckn.nowIso()
  );
}

app.get("/api/trade/:transactionId/timeline", (req, res) => {
  const rows = db.prepare("SELECT * FROM events WHERE transaction_id=? ORDER BY id ASC").all(req.params.transactionId);
  res.json(rows.map((r) => ({ action: r.action, direction: r.direction, summary: r.summary, payload: r.payload ? JSON.parse(r.payload) : null, at: r.at })));
});

// ---------- Direct app-to-app notification receiver (NOT a Beckn message) ----------
// The buyer platform posts here only when it declines a counter-offer —
// there is no real Beckn action for "the BAP rejects the BPP's on_init", so
// this is our own demo-coordination channel, same category as the buyer's
// existing resolveOffer()/my-offers calls into this app's /api/offers.
app.post("/api/notify/:transactionId", (req, res) => {
  const { transactionId } = req.params;
  const { event, reason } = req.body || {};
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (event === "counter_declined") {
    // The counter-offer already reserved real capacity against this offer
    // (see /api/respond) — since the trade is dead now, that reservation
    // must be given back, or it's lost forever and the offer quietly
    // shrinks every time a counter gets turned down.
    const releasedQty = row.counter_qty || row.requested_qty;
    if (releasedQty) {
      db.prepare("UPDATE offers SET remaining_qty = remaining_qty + ? WHERE id=?").run(releasedQty, row.offer_id);
    }
    const now = beckn.nowIso();
    db.prepare("UPDATE trades SET status=?, decline_reason=?, updated_at=? WHERE transaction_id=?").run("DECLINED", reason || "Buyer declined the counter-offer", now, transactionId);
    logEvent(transactionId, "decline", "received", `Buyer declined our counter-offer${reason ? `: ${reason}` : ""}`);
    broadcast("declined", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId)));
  }
  res.json({ ok: true });
});

// ---------- health ----------
app.get("/api/health", (req, res) => res.status(200).send("ok"));

// ---------- read-only views for the dashboard ----------
app.get("/api/offers", (req, res) => {
  const rows = db.prepare("SELECT * FROM offers ORDER BY published_at DESC").all();
  res.json(rows);
});

app.get("/api/trades", (req, res) => {
  const rows = db.prepare("SELECT * FROM trades ORDER BY created_at DESC").all();
  res.json(rows.map(tradeRow));
});

app.get("/api/earnings", (req, res) => {
  const row = db.prepare("SELECT COALESCE(SUM(settlement_amount),0) AS total FROM trades WHERE status='SETTLED'").get();
  res.json({ total: row.total });
});

// ---------- Reset: wipe this platform's own data for a fresh demo run ----------
// Only ever touches this app's own database file — the buyer platform
// has to be reset separately from its own dashboard, on purpose (see
// ARCHITECTURE.md §2: no shared state between the two platforms, ever).
app.post("/api/reset", (req, res) => {
  try {
    db.exec("DELETE FROM trades");
    db.exec("DELETE FROM offers");
    db.exec("DELETE FROM events");
    broadcast("reset", {});
    res.json({ ok: true });
  } catch (err) {
    console.error("reset failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- publish a new offer (real catalog/publish) ----------
app.post("/api/publish", async (req, res) => {
  try {
    const quantityKwh = Number(req.body.quantityKwh);
    const pricePerKwh = Number(req.body.pricePerKwh);
    if (!quantityKwh || !pricePerKwh || quantityKwh <= 0 || pricePerKwh <= 0) {
      return res.status(400).json({ error: "quantityKwh and pricePerKwh must be positive numbers" });
    }
    const offerId = `offer-demo-${beckn.uuid().slice(0, 8)}`;
    const { context, message } = beckn.buildPublishCatalog({ offerId, quantityKwh, pricePerKwh });

    const result = await beckn.postToOnix("/bpp/caller/catalog/publish", { context, message });
    if (!result.ok) {
      console.error("publish rejected by onix:", result.status, result.text);
      return res.status(result.status || 502).json({ error: "onix rejected the publish", detail: result.json, raw: result.text });
    }

    const publishedAt = beckn.nowIso();
    db.prepare("INSERT INTO offers (id, quantity_kwh, remaining_qty, price_per_kwh, published_at) VALUES (?,?,?,?,?)").run(offerId, quantityKwh, quantityKwh, pricePerKwh, publishedAt);

    const offer = { id: offerId, quantity_kwh: quantityKwh, remaining_qty: quantityKwh, price_per_kwh: pricePerKwh, published_at: publishedAt };
    broadcast("offer_published", offer);
    res.json({ ok: true, offer });
  } catch (err) {
    console.error("publish failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- inbound webhook: real requests from onix-sellerapp's bppTxnReceiver ----------
// select | init | confirm | status | update | cancel all land here
// (see config/local-p2p-trading-routing-SellerApp-BppReceiver.yaml).
app.post("/api/webhook/:action", async (req, res) => {
  const action = req.params.action;
  const { context, message } = req.body || {};
  console.log(`[webhook] ${action} — txn=${context?.transactionId}`);

  try {
    if (action === "init") {
      const contract = message?.contract;
      const { price, requestedQty } = beckn.extractInterval0(contract);
      const buyerDiscom = beckn.extractBuyerDiscom(contract);
      const offerId = contract?.commitments?.[0]?.offer?.id || "unknown-offer";
      // The buyer's PRICE_PER_KWH at init is their *bid* — may or may not
      // match what we actually published. Look up our own current ask for
      // this exact offer so the UI can show "buyer bid ₹X vs our ask ₹Y"
      // instead of only ever showing one number.
      const ownOffer = db.prepare("SELECT price_per_kwh FROM offers WHERE id=?").get(offerId);
      const now = beckn.nowIso();
      db.prepare(
        `INSERT INTO trades (transaction_id, offer_id, bap_id, buyer_discom, requested_qty, price_per_kwh, asking_price_per_kwh, status, raw_context, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(transaction_id) DO UPDATE SET raw_context=excluded.raw_context, updated_at=excluded.updated_at`
      ).run(
        context.transactionId,
        offerId,
        context.bapId,
        buyerDiscom,
        requestedQty || 0,
        price || 0,
        ownOffer ? ownOffer.price_per_kwh : null,
        "PENDING_ACCEPT",
        JSON.stringify({ context, message }),
        now,
        now
      );
      logEvent(context.transactionId, "init", "received", `Buyer bid ₹${price}/kWh for ${requestedQty} kWh${ownOffer ? ` (our ask: ₹${ownOffer.price_per_kwh}/kWh)` : ""}`, { context, message });
      broadcast("incoming_request", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
    } else if (action === "confirm") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (row) {
        logEvent(context.transactionId, "confirm", "received", "Buyer confirmed", { context, message });
        const onConfirm = beckn.buildOnConfirm(context, message.contract);
        // Fire the real on_confirm automatically — the human decision
        // (accept / counter / decline) already happened one step earlier,
        // at on_init; confirm→on_confirm is a pure mechanical handshake
        // with no real choice left to make, so it stays automatic.
        beckn
          .postToOnix("/bpp/caller/on_confirm", onConfirm)
          .then((result) => {
            const now = beckn.nowIso();
            db.prepare("UPDATE trades SET status=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
              "ACTIVE",
              JSON.stringify(onConfirm),
              now,
              context.transactionId
            );
            logEvent(context.transactionId, "on_confirm", "sent", "Trade is now ACTIVE", onConfirm);
            broadcast("active", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
            if (!result.ok) console.error("on_confirm send failed:", result.status, result.json);
          })
          .catch((e) => console.error("on_confirm send error:", e));
      }
    }
    // select / status / update / cancel: not used by this demo's core flow — ACK and log only.
    res.status(200).json(beckn.buildAck(context));
  } catch (err) {
    console.error(`webhook ${action} failed:`, err);
    res.status(200).json(beckn.buildAck(context || {}));
  }
});

// ---------- Seller's real decision on an incoming request ----------
// Three genuine outcomes, not just one blind "Accept":
//   - accept:  on_init echoes the buyer's own bid terms verbatim (old behavior)
//   - counter: on_init carries the seller's own price/qty instead — a real
//              counter-offer, same message shape, different numbers (see
//              beckn.buildOnInit's `counter` param)
//   - decline: no onix call at all — a BPP simply never responding to an
//              init is valid Beckn behavior. The buyer is told directly
//              (see BUYER_APP_URL below) purely as demo UX, not a network
//              message, since no real NACK-shaped on_init exists to send.
app.post("/api/respond/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const { decision, pricePerKwh, quantityKwh, reason } = req.body || {};
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "PENDING_ACCEPT") return res.status(409).json({ error: `trade is ${row.status}, not awaiting a decision` });

  try {
    if (decision === "decline") {
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, decline_reason=?, updated_at=? WHERE transaction_id=?").run("DECLINED", reason || "Declined by seller", now, transactionId);
      logEvent(transactionId, "decline", "local", reason || "Declined by seller");
      const updated = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId));
      broadcast("declined", updated);
      fetch(`${BUYER_APP_URL}/api/notify/${transactionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "declined", reason: reason || "Declined by seller" }),
      }).catch((e) => console.error("notify buyer of decline failed (non-fatal — buyer will just see it stay Pending):", e.message || e));
      return res.json({ ok: true, trade: updated });
    }

    if (decision !== "accept" && decision !== "counter") {
      return res.status(400).json({ error: "decision must be accept, counter, or decline" });
    }
    const counter = decision === "counter" ? { pricePerKwh: Number(pricePerKwh), quantityKwh: Number(quantityKwh) } : null;
    if (counter && (!counter.pricePerKwh || counter.pricePerKwh <= 0 || !counter.quantityKwh || counter.quantityKwh <= 0)) {
      return res.status(400).json({ error: "a counter-offer needs a positive pricePerKwh and quantityKwh" });
    }

    // Real capacity check — accepting or countering commits real kWh
    // against this offer's actual remaining balance. Without this, the
    // same offer could be sold to any number of buyers with no limit at
    // all (the bug this replaces: quantity_kwh was write-once, checked
    // nowhere). Skipped only if the offer itself can't be found (a
    // malformed/legacy trade with no real offer row to check against).
    const agreedQty = counter ? counter.quantityKwh : row.requested_qty;
    const offerRow = db.prepare("SELECT * FROM offers WHERE id=?").get(row.offer_id);
    if (offerRow && agreedQty > offerRow.remaining_qty) {
      return res.status(409).json({ error: `Only ${offerRow.remaining_qty} kWh remains available on this offer — cannot ${decision === "counter" ? "counter for" : "accept"} ${agreedQty} kWh.` });
    }

    const stored = JSON.parse(row.raw_context);
    const onInit = beckn.buildOnInit(stored.context, stored.message.contract, counter);
    const result = await beckn.postToOnix("/bpp/caller/on_init", onInit);
    if (!result.ok) { console.error("on_init rejected by onix:", result.status, result.text); return res.status(result.status || 502).json({ error: "onix rejected on_init", detail: result.json, raw: result.text }); }

    if (offerRow) {
      db.prepare("UPDATE offers SET remaining_qty = remaining_qty - ? WHERE id=?").run(agreedQty, row.offer_id);
    }
    const now = beckn.nowIso();
    db.prepare("UPDATE trades SET status=?, counter_price_per_kwh=?, counter_qty=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
      "AWAITING_CONFIRM",
      counter ? counter.pricePerKwh : null,
      counter ? counter.quantityKwh : null,
      JSON.stringify(onInit),
      now,
      transactionId
    );
    logEvent(transactionId, "on_init", "sent", counter ? `Countered with ₹${counter.pricePerKwh}/kWh for ${counter.quantityKwh} kWh` : "Accepted as bid — on_init sent", onInit);
    const updated = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId));
    broadcast(counter ? "countered" : "accepted", updated);
    res.json({ ok: true, trade: updated });
  } catch (err) {
    console.error("respond failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- Suggest a plausible meter reading, for the delivery form to prefill ----------
// Real physical delivery is never exactly what was requested (line losses,
// timing drift against the settlement interval) — this suggests a number
// in a plausible 85%-105% band, but the seller can edit it before
// submitting; the server no longer silently picks the number itself.
app.get("/api/deliver/:transactionId/suggest", (req, res) => {
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(req.params.transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  // Base the suggestion on whatever quantity was actually agreed — if this
  // trade went through a counter-offer, that's counter_qty, not the
  // buyer's original (superseded) bid quantity.
  const agreedQty = row.counter_qty || row.requested_qty;
  const suggested = Math.round(agreedQty * (0.85 + Math.random() * 0.2) * 10) / 10;
  res.json({ requestedQty: agreedQty, suggestedFinalAlloc: suggested });
});

// ---------- Report delivery button: real on_status (settled) ----------
// This is the seller declaring the actual smart-meter reading after
// physical delivery — the figure real settlement pays on, which is why it
// can (and in the real world, usually does) differ from what was
// originally requested. finalAlloc is supplied by the caller (the form the
// seller just filled in), not silently generated here.
app.post("/api/deliver/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "ACTIVE") return res.status(409).json({ error: `trade is ${row.status}, not ACTIVE` });

  const finalAlloc = Number(req.body.finalAlloc);
  if (!finalAlloc || finalAlloc <= 0) return res.status(400).json({ error: "finalAlloc (the delivered kWh reading) must be a positive number" });

  try {
    const stored = JSON.parse(row.raw_context);
    // The agreed price is the counter-offer's price when this trade went
    // through one (the buyer's original bid was superseded the moment they
    // accepted the counter) — otherwise it's the buyer's bid, unchanged.
    const pricePerKwh = row.counter_price_per_kwh || row.price_per_kwh;
    const settlementAmount = Math.round(finalAlloc * pricePerKwh * 100) / 100;
    const txnRef = `TXN-${transactionId.slice(0, 8).toUpperCase()}-SETTLED`;

    const onStatus = beckn.buildOnStatusSettled(stored.context, stored.message.contract, { finalAlloc, pricePerKwh, settlementAmount, txnRef });
    const result = await beckn.postToOnix("/bpp/caller/on_status", onStatus);
    if (!result.ok) { console.error("on_status rejected by onix:", result.status, result.text); return res.status(result.status || 502).json({ error: "onix rejected on_status", detail: result.json, raw: result.text }); }

    const now = beckn.nowIso();
    db.prepare("UPDATE trades SET status=?, final_alloc=?, settlement_amount=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
      "SETTLED",
      finalAlloc,
      settlementAmount,
      JSON.stringify(onStatus),
      now,
      transactionId
    );
    logEvent(transactionId, "on_status", "sent", `Reported ${finalAlloc} kWh delivered — settled ₹${settlementAmount.toFixed(2)}`, onStatus);
    const updated = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId));
    broadcast("settled", updated);
    res.json({ ok: true, trade: updated });
  } catch (err) {
    console.error("deliver failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Seller Platform listening on http://localhost:${PORT}`);
  console.log(`  → talking to onix-sellerapp at ${process.env.ONIX_SELLER_URL || "http://localhost:8082"}`);
  console.log(`  → webhook target for onix: http://host.docker.internal:${PORT}/api/webhook`);
});

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
    status: row.status,
    finalAlloc: row.final_alloc,
    settlementAmount: row.settlement_amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
    db.prepare("INSERT INTO offers (id, quantity_kwh, price_per_kwh, published_at) VALUES (?,?,?,?)").run(offerId, quantityKwh, pricePerKwh, publishedAt);

    const offer = { id: offerId, quantity_kwh: quantityKwh, price_per_kwh: pricePerKwh, published_at: publishedAt };
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
      const now = beckn.nowIso();
      db.prepare(
        `INSERT INTO trades (transaction_id, offer_id, bap_id, buyer_discom, requested_qty, price_per_kwh, status, raw_context, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(transaction_id) DO UPDATE SET raw_context=excluded.raw_context, updated_at=excluded.updated_at`
      ).run(
        context.transactionId,
        contract?.commitments?.[0]?.offer?.id || "unknown-offer",
        context.bapId,
        buyerDiscom,
        requestedQty || 0,
        price || 0,
        "PENDING_ACCEPT",
        JSON.stringify({ context, message }),
        now,
        now
      );
      broadcast("incoming_request", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
    } else if (action === "confirm") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (row) {
        const stored = JSON.parse(row.raw_context);
        const onConfirm = beckn.buildOnConfirm(context, message.contract);
        // Fire the real on_confirm automatically — the human decision
        // ("Accept") already happened one step earlier, at on_init.
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

// ---------- Accept button: seller decides to proceed → real on_init ----------
app.post("/api/accept/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "PENDING_ACCEPT") return res.status(409).json({ error: `trade is ${row.status}, not awaiting accept` });

  try {
    const stored = JSON.parse(row.raw_context);
    const onInit = beckn.buildOnInit(stored.context, stored.message.contract);
    const result = await beckn.postToOnix("/bpp/caller/on_init", onInit);
    if (!result.ok) { console.error("on_init rejected by onix:", result.status, result.text); return res.status(result.status || 502).json({ error: "onix rejected on_init", detail: result.json, raw: result.text }); }

    const now = beckn.nowIso();
    db.prepare("UPDATE trades SET status=?, raw_context=?, updated_at=? WHERE transaction_id=?").run("AWAITING_CONFIRM", JSON.stringify(onInit), now, transactionId);
    const updated = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId));
    broadcast("accepted", updated);
    res.json({ ok: true, trade: updated });
  } catch (err) {
    console.error("accept failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- Mark as delivered button: real on_status (settled) ----------
app.post("/api/deliver/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "ACTIVE") return res.status(409).json({ error: `trade is ${row.status}, not ACTIVE` });

  try {
    const stored = JSON.parse(row.raw_context);
    const requestedQty = row.requested_qty;
    const pricePerKwh = row.price_per_kwh;
    // Presenter-triggered, not a timer: randomize what actually "got
    // delivered" within a plausible 85%-105% band of what was requested.
    const finalAlloc = Math.round(requestedQty * (0.85 + Math.random() * 0.2) * 10) / 10;
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

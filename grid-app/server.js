// Grid/DISCOM Platform — the demand side of aggregation-v2. Posts a bulk
// energy requirement (quantity + a price ceiling) and, since Aggregation v2
// Phase 2, executes the real purchase itself once aggregator-app publishes
// a block that fulfills it — via its own onix identity (reusing
// buyerapp.example.com's already-registered keys; see beckn.js and
// KNOWLEDGE-BASE.md §9). buyer-app is no longer involved in this flow at
// all — it stays a fully independent bulk buyer.
const express = require("express");
const path = require("path");
const db = require("./db");
const beckn = require("./beckn");

const PORT = process.env.PORT || 4004;
const AGGREGATOR_APP_URL = process.env.AGGREGATOR_APP_URL || "http://localhost:4003";
const AGGREGATOR_BPP_URI = "http://aggregatorapp.example.com:9000/bpp/receiver";

async function getJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    return { ok: false, status: 0, json: null, text: `network error reaching ${url}: ${err.message || err}` };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body, text kept below */ }
  return { ok: res.ok, status: res.status, json, text };
}

function extractError(result) {
  return result.json?.error || (result.text && result.text.trim()) || `aggregator-app returned HTTP ${result.status || "(no response)"} with no readable body`;
}

function extractOnixError(result) {
  return (
    result.json?.message?.error?.message ||
    (result.text && result.text.trim()) ||
    `onix returned HTTP ${result.status || "(no response)"} with no readable body`
  );
}

function tradeRow(row) {
  return {
    transactionId: row.transaction_id,
    requirementId: row.requirement_id,
    offerId: row.offer_id,
    requestedQty: row.requested_qty,
    pricePerKwh: row.price_per_kwh,
    status: row.status,
    settlementAmount: row.settlement_amount,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function logEvent(transactionId, action, direction, summary, payload) {
  db.prepare("INSERT INTO events (transaction_id, action, direction, summary, payload, at) VALUES (?,?,?,?,?,?)").run(
    transactionId, action, direction, summary || null, payload ? JSON.stringify(payload) : null, beckn.nowIso()
  );
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => res.status(200).send("ok"));

app.get("/api/requirements", async (req, res) => {
  const result = await getJson(`${AGGREGATOR_APP_URL}/api/requirements`);
  if (!result.ok) return res.status(result.status || 502).json({ error: extractError(result) });
  res.json(result.json || []);
});

app.post("/api/requirements", async (req, res) => {
  const quantityKwh = Number(req.body?.quantityKwh);
  const maxPricePerKwh = Number(req.body?.maxPricePerKwh);
  if (!quantityKwh || quantityKwh <= 0 || !maxPricePerKwh || maxPricePerKwh <= 0) {
    return res.status(400).json({ error: "quantityKwh and maxPricePerKwh must be positive numbers" });
  }
  const result = await getJson(`${AGGREGATOR_APP_URL}/api/requirements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantityKwh, maxPricePerKwh }),
  });
  if (!result.ok) return res.status(result.status || 502).json({ error: extractError(result) });
  res.json(result.json);
});

app.get("/api/trades", (req, res) => {
  res.json(db.prepare("SELECT * FROM trades ORDER BY created_at DESC").all().map(tradeRow));
});

// ---------- The real purchase: buy the block that fulfills our own requirement ----------
app.post("/api/requirements/:id/buy", async (req, res) => {
  try {
    const requirementId = req.params.id;
    const existing = db.prepare("SELECT * FROM trades WHERE requirement_id=?").get(requirementId);
    if (existing) return res.status(409).json({ error: `Requirement ${requirementId} already has a trade (${existing.status}) — ${existing.transaction_id}` });

    const reqResult = await getJson(`${AGGREGATOR_APP_URL}/api/requirements`);
    if (!reqResult.ok) return res.status(reqResult.status || 502).json({ error: extractError(reqResult) });
    const requirement = (reqResult.json || []).find((r) => r.id === requirementId);
    if (!requirement) return res.status(404).json({ error: `Requirement ${requirementId} not found` });
    if (requirement.status !== "PUBLISHED" || !requirement.block_id) {
      return res.status(409).json({ error: `Requirement ${requirementId} has no published block yet (status: ${requirement.status})` });
    }

    const offersResult = await getJson(`${AGGREGATOR_APP_URL}/api/offers`);
    if (!offersResult.ok) return res.status(offersResult.status || 502).json({ error: extractError(offersResult) });
    const block = (offersResult.json || []).find((o) => o.id === requirement.block_id);
    if (!block) return res.status(409).json({ error: `Block ${requirement.block_id} is no longer live on aggregator-app's catalog` });
    const remaining = block.remaining_qty ?? block.quantity_kwh;
    if (remaining <= 0) return res.status(409).json({ error: `Block ${requirement.block_id} is fully sold — no capacity remains` });
    if (requirement.quantity_kwh > remaining) {
      return res.status(409).json({ error: `Only ${remaining} kWh remains on block ${requirement.block_id} — requirement needs ${requirement.quantity_kwh} kWh` });
    }

    const quantityKwh = Math.min(requirement.quantity_kwh, remaining);
    const pricePerKwh = block.price_per_kwh;
    const init = beckn.buildInit({ offerId: block.id, quantityKwh, pricePerKwh, bppId: beckn.SELLER_ID, bppUri: AGGREGATOR_BPP_URI });
    const result = await beckn.postToOnix("/bap/caller/init", init);
    if (!result.ok) return res.status(result.status || 502).json({ error: extractOnixError(result), detail: result.json });

    const now = beckn.nowIso();
    db.prepare(
      `INSERT INTO trades (transaction_id, requirement_id, offer_id, bpp_id, bpp_uri, requested_qty, price_per_kwh, status, raw_context, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(init.context.transactionId, requirementId, block.id, beckn.SELLER_ID, AGGREGATOR_BPP_URI, quantityKwh, pricePerKwh, "PENDING", JSON.stringify(init), now, now);
    logEvent(init.context.transactionId, "init", "sent", `Buying ${quantityKwh} kWh @ ₹${pricePerKwh}/kWh for requirement ${requirementId}`, init);

    res.json({ ok: true, transactionId: init.context.transactionId, trade: tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(init.context.transactionId)) });
  } catch (err) {
    console.error("requirements/:id/buy failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- inbound webhook: real callbacks from onix-gridapp's bapTxnReceiver ----------
app.post("/api/bap-webhook/:action", async (req, res) => {
  const action = req.params.action;
  const { context, message } = req.body || {};
  console.log(`[grid-webhook] ${action} — txn=${context?.transactionId || "(none)"}`);

  try {
    if (action === "on_init") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (row) {
        logEvent(context.transactionId, "on_init", "received", "Aggregator accepted our bid — auto-confirming", { context, message });
        const onConfirm = beckn.buildConfirm(context, message.contract);
        const result = await beckn.postToOnix("/bap/caller/confirm", onConfirm);
        const now = beckn.nowIso();
        db.prepare("UPDATE trades SET raw_context=?, updated_at=? WHERE transaction_id=?").run(JSON.stringify(onConfirm), now, context.transactionId);
        logEvent(context.transactionId, "confirm", "sent", "Confirmed", onConfirm);
        if (!result.ok) console.error("confirm send failed:", result.status, result.json);
      }
    } else if (action === "on_confirm") {
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, updated_at=? WHERE transaction_id=?").run("ACTIVE", now, context.transactionId);
      logEvent(context.transactionId, "on_confirm", "received", "Trade is now ACTIVE", { context, message });
    } else if (action === "on_status") {
      const buyerCost = beckn.extractRevenueFlow(message.contract, "buyerPlatform");
      const settlementAmount = buyerCost != null ? Math.abs(buyerCost) : null;
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, settlement_amount=?, updated_at=? WHERE transaction_id=?").run("SETTLED", settlementAmount, now, context.transactionId);
      logEvent(context.transactionId, "on_status", "received", `Settled — paid ₹${settlementAmount != null ? settlementAmount.toFixed(2) : "?"}`, { context, message });
    }
    res.status(200).json(beckn.buildAck(context || {}));
  } catch (err) {
    console.error(`grid-webhook ${action} failed:`, err);
    res.status(200).json(beckn.buildAck(context || {}));
  }
});

app.post("/api/reset", (req, res) => {
  try {
    db.exec("DELETE FROM trades");
    db.exec("DELETE FROM events");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Grid/DISCOM Platform listening on http://localhost:${PORT}`);
  console.log(`  → posting requirements to aggregator-app at ${AGGREGATOR_APP_URL}`);
  console.log(`  → own onix identity at ${process.env.ONIX_GRID_URL || "http://localhost:18085"} (reuses buyerapp.example.com's keys)`);
  console.log(`  → webhook target for onix: http://host.docker.internal:${PORT}/api/bap-webhook`);
});

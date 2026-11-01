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
const { round2, inr, L, finish } = require("./walletlib");

const PORT = process.env.PORT || 4004;
const AGGREGATOR_APP_URL = process.env.AGGREGATOR_APP_URL || "http://localhost:4003";
const AGGREGATOR_BPP_URI = "http://aggregatorapp.example.com:9000/bpp/receiver";
const SELLER_APP_URL = process.env.SELLER_APP_URL || "http://localhost:4002";
const BUYER_APP_URL = process.env.BUYER_APP_URL || "http://localhost:4001";

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


// Delivered kWh and the network's own statement of what the buyer pays, read
// back out of the settled on_status contract.
function extractFinalAlloc(contract) {
  const payloads = contract?.commitments?.[0]?.commitmentAttributes?.intervals?.[0]?.payloads || [];
  const v = payloads.find((p) => p.type === "FINAL_ALLOC")?.values?.[0];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}
function extractBuyerNote(contract) {
  const flows = contract?.consideration?.[0]?.considerationAttributes?.revenueFlows || [];
  return flows.find((f) => f.role === "buyerPlatform")?.description || null;
}

app.get("/api/wallet/history", (req, res) => {
  const entries = [];
  for (const t of db.prepare("SELECT * FROM trades WHERE status IN ('SETTLED','ACTIVE')").all()) {
    if (t.status === "ACTIVE") {
      entries.push({ id: t.transaction_id, at: t.updated_at, kind: "pending", amount: null, title: `Block purchase · ${t.offer_id}`, subtitle: `${t.requested_qty} kWh @ ₹${t.price_per_kwh}/kWh for ${t.requirement_id} — waiting for delivery`, transactionId: t.transaction_id,
        lines: [L("Agreed", `${t.requested_qty} kWh @ ₹${t.price_per_kwh}/kWh`), L("Energy if delivered in full", inr(round2(t.requested_qty * t.price_per_kwh))), L("+ Buyer-side wheeling if in full", inr(round2(t.requested_qty * 0.5))), L("= Expected payment", inr(round2(t.requested_qty * (t.price_per_kwh + 0.5))), { strong: true }), L("Status", "Not charged yet — this settles when the aggregator reports delivery")] });
      continue;
    }
    const paid = t.settlement_amount ?? 0;
    const lines = [L("Requirement served", t.requirement_id)];
    if (t.final_alloc != null) {
      const wheel = round2(t.final_alloc * 0.5);
      const energy = round2(paid - wheel);
      lines.push(L("Delivered", `${t.final_alloc} of ${t.requested_qty} kWh${t.final_alloc < t.requested_qty ? ` (${round2(t.requested_qty - t.final_alloc)} kWh short)` : ""}`));
      lines.push(L(`Energy: ${t.final_alloc} kWh × ₹${t.price_per_kwh}/kWh`, inr(energy)));
      lines.push(L(`+ Buyer-side wheeling: ${t.final_alloc} kWh × ₹0.50/kWh`, inr(wheel)));
    }
    lines.push(L("= Paid", inr(paid), { strong: true }));
    if (t.settlement_note) lines.push(L("Network's settlement statement", t.settlement_note, { note: true }));
    entries.push({ id: t.transaction_id, at: t.updated_at, kind: "settled", amount: -paid, title: `Block purchase · ${t.offer_id}`, subtitle: `${t.final_alloc ?? "?"} of ${t.requested_qty} kWh delivered · ${t.requirement_id}`, transactionId: t.transaction_id, lines });
  }
  res.json(finish(entries));
});

app.get("/api/wallet", (req, res) => {
  const spent = db.prepare("SELECT COALESCE(SUM(settlement_amount),0) AS v FROM trades WHERE status='SETTLED'").get().v;
  const inEscrow = db.prepare("SELECT COALESCE(SUM(requested_qty * price_per_kwh),0) AS v FROM trades WHERE status='ACTIVE'").get().v;
  res.json({ total: Math.round(spent * 100) / 100, inEscrow: Math.round(inEscrow * 100) / 100 });
});

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

// ---------- The real purchase: buy whatever's currently published that
// fulfills our own requirement ----------
// Found live, fixed here: a single requirement can now be served by more
// than one block over time (aggregator-app may publish less than the full
// ask if that's all that's currently pooled, then top up later once a new
// seller's offer shows up) -- so this buys cheapest-first across EVERY
// live block tied to the requirement, up to however much is still needed,
// rather than assuming exactly one block exists and rejecting outright if
// it's undersized. A second (or third) call after more is published simply
// tops up the remainder; it is not blocked by an earlier trade existing.
// A second click while the first purchase is still in flight would read the
// same "still needed" figure and buy the requirement twice over.
const buying = new Set();
app.post("/api/requirements/:id/buy", async (req, res) => {
  const requirementId = req.params.id;
  if (buying.has(requirementId)) return res.status(409).json({ error: `A purchase for ${requirementId} is already in progress — wait for it to finish.` });
  buying.add(requirementId);
  try {

    const reqResult = await getJson(`${AGGREGATOR_APP_URL}/api/requirements`);
    if (!reqResult.ok) return res.status(reqResult.status || 502).json({ error: extractError(reqResult) });
    const requirement = (reqResult.json || []).find((r) => r.id === requirementId);
    if (!requirement) return res.status(404).json({ error: `Requirement ${requirementId} not found` });

    const alreadyBought = requirement.fulfilled_qty || 0;
    const needed = Math.round((requirement.quantity_kwh - alreadyBought) * 100) / 100;
    if (needed <= 0) {
      return res.status(409).json({ error: `Requirement ${requirementId} is already fully bought (${alreadyBought} of ${requirement.quantity_kwh} kWh) — nothing left to buy.` });
    }

    const blocksResult = await getJson(`${AGGREGATOR_APP_URL}/api/requirements/${requirementId}/blocks`);
    if (!blocksResult.ok) return res.status(blocksResult.status || 502).json({ error: extractError(blocksResult) });
    const allBlocks = blocksResult.json || [];
    if (!allBlocks.length) {
      return res.status(409).json({ error: `Requirement ${requirementId} has no published block yet (status: ${requirement.status})` });
    }

    // Belt-and-suspenders on the price ceiling: aggregator-app already
    // refuses to publish a block whose price exceeds a linked requirement's
    // ceiling (found live: the margin added on top of otherwise-compliant
    // small-offer prices had been pushing it over, silently), but this
    // re-checks right before spending real money anyway, same as every
    // other buy-time re-validation in this demo.
    const withinCeiling = allBlocks.filter((b) => (b.price_per_kwh ?? Infinity) <= requirement.max_price_per_kwh);
    const overCeiling = allBlocks.filter((b) => (b.price_per_kwh ?? Infinity) > requirement.max_price_per_kwh);
    const buyable = withinCeiling.filter((b) => (b.remaining_qty ?? b.quantity_kwh) > 0);
    if (!buyable.length) {
      const reason = overCeiling.length
        ? `every published block for this requirement is priced above its own ₹${requirement.max_price_per_kwh}/kWh ceiling (cheapest is ₹${Math.min(...overCeiling.map((b) => b.price_per_kwh))}/kWh)`
        : `no published block for this requirement currently has remaining capacity`;
      return res.status(409).json({ error: `Nothing to buy for requirement ${requirementId} right now — ${reason}.` });
    }

    // Cheapest-first, same greedy-fill spirit as aggregator-app's own
    // recommend -- buys across as many blocks as it takes to cover what's
    // still needed, one real signed init per block used.
    buyable.sort((a, b) => a.price_per_kwh - b.price_per_kwh);
    let qtyRemaining = needed;
    const bought = [];
    const failures = [];
    for (const block of buyable) {
      if (qtyRemaining <= 0.001) break;
      const take = Math.round(Math.min(block.remaining_qty, qtyRemaining) * 100) / 100;
      if (take <= 0) continue;
      const init = beckn.buildInit({ offerId: block.id, quantityKwh: take, pricePerKwh: block.price_per_kwh, bppId: beckn.SELLER_ID, bppUri: AGGREGATOR_BPP_URI });
      // Record the trade BEFORE sending: the aggregator's on_init can come back
      // before our own post has even returned, and the webhook ignores any
      // transaction it has no row for.
      const now = beckn.nowIso();
      db.prepare(
        `INSERT INTO trades (transaction_id, requirement_id, offer_id, bpp_id, bpp_uri, requested_qty, price_per_kwh, status, raw_context, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(init.context.transactionId, requirementId, block.id, beckn.SELLER_ID, AGGREGATOR_BPP_URI, take, block.price_per_kwh, "PENDING", JSON.stringify(init), now, now);
      logEvent(init.context.transactionId, "init", "sent", `Buying ${take} kWh @ ₹${block.price_per_kwh}/kWh from block ${block.id} for requirement ${requirementId}`, init);
      const result = await beckn.postToOnix("/bap/caller/init", init);
      if (!result.ok) {
        const errorMessage = extractOnixError(result);
        failures.push(`${block.id}: ${errorMessage}`);
        db.prepare("UPDATE trades SET status=?, error_message=?, updated_at=? WHERE transaction_id=?").run("REJECTED", errorMessage, beckn.nowIso(), init.context.transactionId);
        logEvent(init.context.transactionId, "init", "received", `Rejected: ${errorMessage}`);
        continue;
      }
      bought.push({ transactionId: init.context.transactionId, offerId: block.id, qty: take, pricePerKwh: block.price_per_kwh });
      qtyRemaining = Math.round((qtyRemaining - take) * 100) / 100;
    }

    if (!bought.length) {
      return res.status(502).json({ error: `All purchase attempts failed: ${failures.join("; ") || "unknown error"}` });
    }

    const shortfallQty = Math.max(0, qtyRemaining);
    res.json({
      ok: true,
      bought,
      boughtQty: Math.round((needed - shortfallQty) * 100) / 100,
      shortfallQty,
      note: shortfallQty > 0.001
        ? `Bought ${Math.round((needed - shortfallQty) * 100) / 100} of the ${needed} kWh still needed from ${bought.length} block(s) — ${shortfallQty} kWh remains unmet; check back once more is published.`
        : `Bought all ${needed} kWh still needed, from ${bought.length} block(s).`,
      failures: failures.length ? failures : undefined,
    });
  } catch (err) {
    console.error("requirements/:id/buy failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    buying.delete(requirementId);
  }
});

const confirmSent = new Set();

// Direct app-to-app notice (NOT a Beckn message): the aggregator declined a
// bid it could not or would not honour (price below the block's fixed price,
// or the block no longer has the quantity). Without this the purchase would
// sit on "Pending" forever.
app.post("/api/notify/:transactionId", (req, res) => {
  const { event, reason } = req.body || {};
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(req.params.transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (event === "declined" && row.status === "PENDING") {
    db.prepare("UPDATE trades SET status=?, error_message=?, updated_at=? WHERE transaction_id=?").run("REJECTED", reason || "Declined by the aggregator", beckn.nowIso(), row.transaction_id);
    logEvent(row.transaction_id, "decline", "received", `Aggregator declined: ${reason || "no reason given"}`);
  }
  res.json({ ok: true });
});

// ---------- inbound webhook: real callbacks from onix-gridapp's bapTxnReceiver ----------
app.post("/api/bap-webhook/:action", async (req, res) => {
  const action = req.params.action;
  const { context, message } = req.body || {};
  console.log(`[grid-webhook] ${action} — txn=${context?.transactionId || "(none)"}`);

  try {
    if (action === "on_init") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      // Only the first on_init of a still-PENDING purchase is acted on.
      if (row && row.status === "PENDING" && !confirmSent.has(context.transactionId)) {
        confirmSent.add(context.transactionId);
        logEvent(context.transactionId, "on_init", "received", "Aggregator accepted our bid — auto-confirming", { context, message });
        const onConfirm = beckn.buildConfirm(context, message.contract);
        db.prepare("UPDATE trades SET raw_context=?, updated_at=? WHERE transaction_id=?").run(JSON.stringify(onConfirm), beckn.nowIso(), context.transactionId);
        logEvent(context.transactionId, "confirm", "sent", "Confirmed", onConfirm);
        const result = await beckn.postToOnix("/bap/caller/confirm", onConfirm);
        if (!result.ok) {
          // Network refused our confirm -- no on_confirm will ever arrive. Mark it
          // rejected with the real reason and tell the aggregator to hand back the
          // block capacity / requirement quantity it already counted at init.
          console.error("confirm send failed:", result.status, result.json);
          const errorMessage = extractOnixError(result);
          db.prepare("UPDATE trades SET status=?, error_message=?, updated_at=? WHERE transaction_id=? AND status=?").run("REJECTED", errorMessage, beckn.nowIso(), context.transactionId, "PENDING");
          logEvent(context.transactionId, "confirm", "received", `Confirm rejected by the network: ${errorMessage}`);
          fetch(`${AGGREGATOR_APP_URL}/api/notify/${context.transactionId}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "confirm_failed", reason: errorMessage }),
          }).catch((e) => console.error("notify aggregator of failed confirm failed (non-fatal):", e.message || e));
        }
      }
    } else if (action === "on_confirm") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (row && row.status === "PENDING") {
        db.prepare("UPDATE trades SET status=?, updated_at=? WHERE transaction_id=?").run("ACTIVE", beckn.nowIso(), context.transactionId);
        logEvent(context.transactionId, "on_confirm", "received", "Trade is now ACTIVE", { context, message });
      }
    } else if (action === "on_status") {
      const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (!row || row.status === "SETTLED") return res.status(200).json(beckn.buildAck(context || {}));
      const buyerCost = beckn.extractRevenueFlow(message.contract, "buyerPlatform");
      const settlementAmount = buyerCost != null ? Math.abs(buyerCost) : null;
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, settlement_amount=?, final_alloc=?, settlement_note=?, updated_at=? WHERE transaction_id=?").run("SETTLED", settlementAmount, extractFinalAlloc(message.contract), extractBuyerNote(message.contract), now, context.transactionId);
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
    confirmSent.clear();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- Reset the WHOLE demo: this platform, then every other one ----------
// Requirements live on the aggregator, so only a whole-demo reset clears them.
app.post("/api/reset-all", async (req, res) => {
  const results = { grid: "ok" };
  try { db.exec("DELETE FROM trades"); db.exec("DELETE FROM events"); confirmSent.clear(); }
  catch (err) { results.grid = String(err.message || err); }
  await Promise.all(Object.entries({ aggregator: AGGREGATOR_APP_URL, seller: SELLER_APP_URL, buyer: BUYER_APP_URL }).map(async ([name, url]) => {
    try {
      const r = await fetch(`${url}/api/reset`, { method: "POST" });
      results[name] = r.ok ? "ok" : `HTTP ${r.status}`;
    } catch (e) { results[name] = `unreachable (${e.message || e})`; }
  }));
  res.json({ ok: Object.values(results).every((v) => v === "ok"), results });
});

app.listen(PORT, () => {
  console.log(`Grid/DISCOM Platform listening on http://localhost:${PORT}`);
  console.log(`  → posting requirements to aggregator-app at ${AGGREGATOR_APP_URL}`);
  console.log(`  → own onix identity at ${process.env.ONIX_GRID_URL || "http://localhost:18085"} (reuses buyerapp.example.com's keys)`);
  console.log(`  → webhook target for onix: http://host.docker.internal:${PORT}/api/bap-webhook`);
});

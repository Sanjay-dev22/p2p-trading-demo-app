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

// Mirrors the REAL enforced seller-discom policy
// (p2p-trading/DEG-repo/devkits/p2p-trading-ies-wave2/policies/
// p2p-trading-ies-wave2-contractpolicy-local-amended.rego) so this
// dashboard displays the number the network will actually settle, not a
// naive price × quantity guess. Keep these three constants in sync with
// that file by hand — this app has no way to read rego directly, and the
// real settlement result never comes back to the seller synchronously
// (confirmed live: onix's response to /bpp/caller/on_status is a bare ACK;
// the real computed numbers only ever appear in the message forwarded on
// to the buyer, which is why this bug — showing an un-penalized amount —
// was invisible until the penalty rate stopped being zero).
const PENALTY_RATE_PER_KWH = 2.5;
const WHEELING_CHARGE_SELLER_PER_KWH = 0.5;
const WHEELING_CHARGE_BUYER_PER_KWH = 0.5;
const round2 = (x) => Math.round(x * 100) / 100;
const { inr, L, finish } = require("./walletlib");

// The real, useful reason onix rejected something is almost always already
// in result.json.message.error.message (a real policy NACK, e.g. "PRICE_PER_KWH
// 2 is outside the published band 6-15 INR/kWh") — found missing here during
// live use: every onix-rejection route below was discarding that and showing
// only a generic "onix rejected the X" instead. Mirrors the extraction
// buyer-app/server.js's own /api/buy handler already did correctly — this
// makes every route use the same real-reason-first fallback chain.
function extractOnixError(result) {
  return (
    result.json?.message?.error?.message ||
    (result.text && result.text.trim()) ||
    `onix returned HTTP ${result.status || "(no response)"} with no readable body`
  );
}

// Real settlement math, FIRM commitments only (this demo never declares
// BEST_EFFORT, so every delivery here is FIRM — same default the policy
// itself falls back to when commitmentType is absent).
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
  if (event === "counter_declined" || event === "confirm_failed") {
    // Only a trade still waiting on the buyer holds a reservation to give
    // back. Without this guard a late/duplicate notice (or one for a trade
    // that already went ACTIVE) would "release" capacity twice and make the
    // offer look bigger than it really is.
    if (row.status !== "AWAITING_CONFIRM") return res.json({ ok: true, ignored: `trade is ${row.status}` });
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
    logEvent(transactionId, "decline", "received", event === "confirm_failed" ? `Buyer's confirm failed on the network${reason ? `: ${reason}` : ""} — reservation released` : `Buyer declined our counter-offer${reason ? `: ${reason}` : ""}`);
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

// The seller's wallet: everything actually settled to them -- direct sales
// (their own trades) PLUS their share of any aggregator block that contained
// one of their offers. The second part used to be missing, so a seller whose
// energy had been pooled and sold saw Rs 0.
app.get("/api/earnings", (req, res) => {
  const direct = db.prepare("SELECT COALESCE(SUM(settlement_amount),0) AS total FROM trades WHERE status='SETTLED'").get().total;
  const pooled = db.prepare("SELECT COALESCE(SUM(net),0) AS total FROM payouts").get().total;
  const inEscrow = db.prepare("SELECT COALESCE(SUM(COALESCE(counter_qty, requested_qty) * COALESCE(counter_price_per_kwh, price_per_kwh)),0) AS total FROM trades WHERE status='ACTIVE'").get().total;
  res.json({ total: round2(direct + pooled), direct: round2(direct), pooled: round2(pooled), inEscrow: round2(inEscrow) });
});

// Every credit to this seller's wallet, newest first, each with the full
// calculation: direct sales (their own trades) and their share of pooled blocks.
app.get("/api/wallet/history", (req, res) => {
  const entries = [];
  for (const t of db.prepare("SELECT * FROM trades WHERE status IN ('SETTLED','ACTIVE')").all()) {
    const price = t.counter_price_per_kwh || t.price_per_kwh;
    const qty = t.counter_qty || t.requested_qty;
    if (t.status === "ACTIVE") {
      entries.push({ id: t.transaction_id, at: t.updated_at, kind: "pending", amount: null, title: `Direct sale · ${t.offer_id}`, subtitle: `${qty} kWh @ ₹${price}/kWh to ${t.buyer_discom} — waiting for delivery`, transactionId: t.transaction_id,
        lines: [L("Agreed", `${qty} kWh @ ₹${price}/kWh`), L("Energy if delivered in full", inr(round2(qty * price))), L("− Seller-side wheeling if in full", inr(-round2(qty * 0.5))), L("= Expected credit", inr(round2(qty * (price - 0.5))), { strong: true }), L("Status", "Not credited yet — settles when you report delivery")] });
      continue;
    }
    const c = computeSettlement({ requestedQty: qty, finalAlloc: t.final_alloc, pricePerKwh: price });
    const lines = [
      L("Agreed", `${qty} kWh @ ₹${price}/kWh${t.counter_price_per_kwh ? " (after your counter-offer)" : ""}`),
      L("Delivered", `${t.final_alloc} kWh${c.shortfallKwh > 0 ? ` (${c.shortfallKwh} kWh short)` : " (in full)"}`),
      L(`Energy: ${t.final_alloc} kWh × ₹${price}/kWh`, inr(c.tradeValue)),
      L(`− Seller-side wheeling: ${t.final_alloc} kWh × ₹0.50/kWh`, inr(-c.wheelingSeller)),
    ];
    if (c.penalty > 0) lines.push(L(`− Shortfall penalty: ${c.shortfallKwh} kWh × ₹2.50/kWh`, inr(-c.penalty)));
    lines.push(L("= Credited to your wallet", inr(c.sellerReceivable), { strong: true }));
    lines.push(L("For reference: the buyer paid", `${inr(c.buyerPayable)} = energy ${inr(c.tradeValue)} + buyer-side wheeling ${inr(c.wheelingBuyer)}. Wheeling goes to the network, not to either party.`, { note: true }));
    entries.push({ id: t.transaction_id, at: t.updated_at, kind: "settled", amount: t.settlement_amount, title: `Direct sale · ${t.offer_id}`, subtitle: `${t.final_alloc} of ${qty} kWh delivered to ${t.buyer_discom}`, transactionId: t.transaction_id, lines });
  }
  for (const p of db.prepare("SELECT * FROM payouts").all()) {
    const lines = [
      L("Your offer's share of this trade", `${p.allocated_kwh} kWh (pro-rata to what you pooled)`),
      L("Your own meter reading", `${p.delivered_kwh} kWh${p.delivered_kwh < p.allocated_kwh ? ` — short by ${round2(p.allocated_kwh - p.delivered_kwh)} kWh` : " — delivered in full"}`),
      L("Energy at YOUR price", inr(p.gross)),
      L("− Seller-side wheeling: delivered kWh × ₹0.50/kWh", inr(-p.wheeling)),
    ];
    if (p.penalty > 0) lines.push(L("− Shortfall penalty: short kWh × ₹2.50/kWh", inr(-p.penalty)));
    lines.push(L("= Credited by the aggregator", inr(p.net), { strong: true }));
    lines.push(L("Aggregator's block", p.block_id || "?", { note: true }));
    entries.push({ id: `${p.transaction_id}:${p.offer_id}`, at: p.created_at, kind: "settled", amount: p.net, title: `Pooled-block payout · ${p.offer_id}`, subtitle: `${p.delivered_kwh} of ${p.allocated_kwh} kWh delivered · block ${p.block_id || "?"}`, transactionId: p.transaction_id, lines });
  }
  res.json(finish(entries));
});

app.get("/api/payouts", (req, res) => {
  res.json(db.prepare("SELECT * FROM payouts ORDER BY created_at DESC").all());
});

// Aggregator -> seller credit (direct app-to-app, NOT Beckn). Idempotent per
// (transaction, offer) so a retry can never pay a seller twice.
app.post("/api/credit", (req, res) => {
  const p = req.body || {};
  if (!p.transactionId || !p.offerId || !Number.isFinite(Number(p.net))) return res.status(400).json({ error: "transactionId, offerId and net are required" });
  if (!db.prepare("SELECT 1 FROM offers WHERE id=?").get(p.offerId)) return res.status(404).json({ error: `${p.offerId} is not on this Seller Platform` });
  const r = db.prepare(
    `INSERT OR IGNORE INTO payouts (transaction_id, offer_id, block_id, allocated_kwh, delivered_kwh, gross, wheeling, penalty, net, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(p.transactionId, p.offerId, p.blockId || null, p.allocatedKwh ?? null, p.deliveredKwh ?? null, p.gross ?? null, p.wheeling ?? null, p.penalty ?? null, Number(p.net), beckn.nowIso());
  if (r.changes) broadcast("payout", { offerId: p.offerId, net: Number(p.net) });
  res.json({ ok: true, duplicate: !r.changes });
});

// ---------- Capacity reservation for the aggregator (direct app-to-app, NOT Beckn) ----------
// Pooling used to leave the underlying small offers fully sellable here, so
// the same physical kWh could be sold inside an aggregated block AND directly
// to a buyer (double-sold). The aggregator now reserves the pooled quantity
// the moment it publishes a block, and releases it if that publish fails.
app.post("/api/reserve", (req, res) => {
  const { offerId, qty } = req.body || {};
  const q = Number(qty);
  if (!offerId || !q || q <= 0) return res.status(400).json({ error: "offerId and a positive qty are required" });
  const offer = db.prepare("SELECT * FROM offers WHERE id=?").get(offerId);
  if (!offer) return res.status(404).json({ error: `${offerId} is not on this Seller Platform` });
  if (q > offer.remaining_qty + 1e-9) return res.status(409).json({ error: `Only ${offer.remaining_qty} kWh remains on ${offerId} — cannot reserve ${q} kWh.` });
  db.prepare("UPDATE offers SET remaining_qty = remaining_qty - ? WHERE id=?").run(q, offerId);
  broadcast("offer_reserved", { offerId, qty: q });
  res.json({ ok: true, remaining_qty: round2(offer.remaining_qty - q) });
});

app.post("/api/release", (req, res) => {
  const { offerId, qty } = req.body || {};
  const q = Number(qty);
  if (!offerId || !q || q <= 0) return res.status(400).json({ error: "offerId and a positive qty are required" });
  // Never release past what was originally published.
  db.prepare("UPDATE offers SET remaining_qty = MIN(quantity_kwh, remaining_qty + ?) WHERE id=?").run(q, offerId);
  broadcast("offer_reserved", { offerId, qty: -q });
  res.json({ ok: true });
});

// ---------- Reset: wipe this platform's own data for a fresh demo run ----------
// Only ever touches this app's own database file — the buyer platform
// has to be reset separately from its own dashboard, on purpose (see
// ARCHITECTURE.md §2: no shared state between the two platforms, ever).
app.post("/api/reset", (req, res) => {
  try {
    db.exec("DELETE FROM trades");
    db.exec("DELETE FROM offers");
    db.exec("DELETE FROM events"); db.exec("DELETE FROM payouts");
    broadcast("reset", {});
    res.json({ ok: true });
  } catch (err) {
    console.error("reset failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- Reset the WHOLE demo: this platform, then every other one ----------
// A half-reset is illogical (e.g. an aggregator block still pointing at seller
// offers that no longer exist), so the dashboards' "Reset demo" button wipes
// all four platforms. Each peer is reset through its own /api/reset — this
// app never touches another app's database directly.
const PEERS = {
  buyer: process.env.BUYER_APP_URL || "http://localhost:4001",
  aggregator: process.env.AGGREGATOR_APP_URL || "http://localhost:4003",
  grid: process.env.GRID_APP_URL || "http://localhost:4004",
};
app.post("/api/reset-all", async (req, res) => {
  const results = { seller: "ok" };
  try {
    db.exec("DELETE FROM trades"); db.exec("DELETE FROM offers"); db.exec("DELETE FROM events"); db.exec("DELETE FROM payouts");
    broadcast("reset", {});
  } catch (err) { results.seller = String(err); }
  await Promise.all(Object.entries(PEERS).map(async ([name, url]) => {
    try {
      const r = await fetch(`${url}/api/reset`, { method: "POST" });
      results[name] = r.ok ? "ok" : `HTTP ${r.status}`;
    } catch (e) { results[name] = `unreachable (${e.message || e})`; }
  }));
  res.json({ ok: Object.values(results).every((v) => v === "ok"), results });
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
      return res.status(result.status || 502).json({ error: extractOnixError(result), detail: result.json, raw: result.text });
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
      const existing = db.prepare("SELECT status FROM trades WHERE transaction_id=?").get(context.transactionId);
      if (existing) {
        // Replayed/duplicate init for a trade we already hold: do nothing.
        return res.status(200).json(beckn.buildAck(context));
      }
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
      if (row && row.status !== "AWAITING_CONFIRM") {
        // A confirm for a trade that was declined, never accepted, already
        // active or settled must not resurrect it (a declined trade used to
        // flip straight to ACTIVE here).
        logEvent(context.transactionId, "confirm", "received", `Ignored — trade is ${row.status}, not awaiting a confirm`, { context });
      } else if (row) {
        logEvent(context.transactionId, "confirm", "received", "Buyer confirmed", { context, message });
        const onConfirm = beckn.buildOnConfirm(context, message.contract);
        // Fire the real on_confirm automatically — the human decision
        // (accept / counter / decline) already happened one step earlier,
        // at on_init; confirm→on_confirm is a pure mechanical handshake
        // with no real choice left to make, so it stays automatic.
        beckn
          .postToOnix("/bpp/caller/on_confirm", onConfirm)
          .then((result) => {
            // Only go ACTIVE if the network actually accepted the on_confirm —
            // otherwise the buyer never hears it and the two sides disagree.
            if (!result.ok) {
              console.error("on_confirm send failed:", result.status, result.json);
              logEvent(context.transactionId, "on_confirm", "sent", `NOT sent — network rejected it: ${extractOnixError(result)}`, onConfirm);
              return;
            }
            const now = beckn.nowIso();
            db.prepare("UPDATE trades SET status=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
              "ACTIVE",
              JSON.stringify(onConfirm),
              now,
              context.transactionId
            );
            logEvent(context.transactionId, "on_confirm", "sent", "Trade is now ACTIVE", onConfirm);
            broadcast("active", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
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
    // Commit locally BEFORE sending: the buyer answers on_init with a confirm
    // almost instantly (possibly before our own post below has returned), and
    // the confirm handler only accepts an AWAITING_CONFIRM trade. If the
    // network then rejects the on_init, everything is rolled back below.
    if (offerRow) {
      db.prepare("UPDATE offers SET remaining_qty = remaining_qty - ? WHERE id=?").run(agreedQty, row.offer_id);
    }
    db.prepare("UPDATE trades SET status=?, counter_price_per_kwh=?, counter_qty=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
      "AWAITING_CONFIRM",
      counter ? counter.pricePerKwh : null,
      counter ? counter.quantityKwh : null,
      JSON.stringify(onInit),
      beckn.nowIso(),
      transactionId
    );
    const result = await beckn.postToOnix("/bpp/caller/on_init", onInit);
    if (!result.ok) {
      console.error("on_init rejected by onix:", result.status, result.text);
      if (offerRow) db.prepare("UPDATE offers SET remaining_qty = remaining_qty + ? WHERE id=?").run(agreedQty, row.offer_id);
      db.prepare("UPDATE trades SET status=?, counter_price_per_kwh=NULL, counter_qty=NULL, raw_context=?, updated_at=? WHERE transaction_id=?").run("PENDING_ACCEPT", row.raw_context, beckn.nowIso(), transactionId);
      return res.status(result.status || 502).json({ error: extractOnixError(result), detail: result.json, raw: result.text });
    }
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
    // The agreed price/quantity are the counter-offer's when this trade went
    // through one (the buyer's original bid was superseded the moment they
    // accepted the counter) — otherwise they're the buyer's own bid, unchanged.
    const pricePerKwh = row.counter_price_per_kwh || row.price_per_kwh;
    const requestedQty = row.counter_qty || row.requested_qty;
    // Real settlement math (price minus wheeling minus any shortfall
    // penalty), not naive price × delivered — see computeSettlement's own
    // comment for why this duplicates the real policy's formula instead of
    // reading the real result back from the network.
    const { shortfallKwh, wheelingSeller, penalty, sellerReceivable } = computeSettlement({ requestedQty, finalAlloc, pricePerKwh });
    const settlementAmount = sellerReceivable;
    const txnRef = `TXN-${transactionId.slice(0, 8).toUpperCase()}-SETTLED`;

    const onStatus = beckn.buildOnStatusSettled(stored.context, stored.message.contract, {
      finalAlloc, pricePerKwh, requestedQty, settlementAmount, shortfallKwh, wheelingSeller, penalty, txnRef,
    });
    const result = await beckn.postToOnix("/bpp/caller/on_status", onStatus);
    if (!result.ok) { console.error("on_status rejected by onix:", result.status, result.text); return res.status(result.status || 502).json({ error: extractOnixError(result), detail: result.json, raw: result.text }); }

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
  console.log(`  → talking to onix-sellerapp at ${process.env.ONIX_SELLER_URL || "http://localhost:18082"}`);
  console.log(`  → webhook target for onix: http://host.docker.internal:${PORT}/api/webhook`);
});

// Buyer Platform — the real business-logic app behind onix-buyerapp,
// replacing the fidedocker/sandbox-2.0 fixture-replay stub. See
// p2p-trading-app/DEMO-APP-PLAN.md for the design this implements.
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const db = require("./db");
const beckn = require("./beckn");
const ledger = require("./ledger");

const PORT = process.env.PORT || 4001;
// The one real seller we can actually transact with — its own REST API is
// the authoritative source of truth for what's really published right now
// (a discovered_offers row can be stale: reset, sold, or long expired).
// Also used for a direct, app-to-app demo-coordination notification (never
// a real Beckn message) when we decline a counter-offer — see seller-app's
// matching BUYER_APP_URL.
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
    askingPricePerKwh: row.asking_price_per_kwh,
    sellerPricePerKwh: row.seller_price_per_kwh,
    sellerQty: row.seller_qty,
    declineReason: row.decline_reason,
    status: row.status,
    settlementAmount: row.settlement_amount,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Protocol/decision timeline — mirrors seller-app's own ----------
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
// The seller platform posts here only when it declines a request outright
// (no counter offered) — there's no real Beckn action for "the BPP
// rejects the init with no response", so this is our own demo-coordination
// channel, same category as our own resolveOffer()/my-offers calls into
// the seller's /api/offers.
app.post("/api/notify/:transactionId", (req, res) => {
  const { transactionId } = req.params;
  const { event, reason } = req.body || {};
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (event === "declined") {
    const now = beckn.nowIso();
    db.prepare("UPDATE trades SET status=?, decline_reason=?, updated_at=? WHERE transaction_id=?").run("DECLINED", reason || "Declined by seller", now, transactionId);
    logEvent(transactionId, "decline", "received", `Seller declined${reason ? `: ${reason}` : ""}`);
    broadcast("declined", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId)));
  }
  res.json({ ok: true });
});

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
//   2. found but not buyable — some other reason it can't be bought here.
//      Important nuance, found the hard way: `sellerapp.example.com` is the
//      *devkit's own generic example participant ID* from its tutorial
//      fixtures, not a unique identity — plenty of real, different testers
//      on the shared network never bothered to rename it, so a
//      discovered_offers row's seller_id being "sellerapp.example.com"
//      does NOT reliably mean it was ever actually us. We genuinely cannot
//      tell "was ours, now stale" apart from "always was someone else's,
//      same generic ID" from seller_id alone — so the message below never
//      claims either with false certainty.
//   3. not found at all — never seen anywhere.
async function resolveOffer(offerId) {
  try {
    const sellerOffers = await fetch(`${SELLER_APP_URL}/api/offers`).then((r) => (r.ok ? r.json() : []));
    const own = sellerOffers.find((o) => o.id === offerId);
    if (own) {
      // remaining_qty is the real sellable balance — quantity_kwh is only
      // the amount originally published and never reflects what's already
      // been sold. A fully depleted offer is found, but not buyable.
      const remaining = own.remaining_qty ?? own.quantity_kwh;
      if (remaining <= 0) {
        return { found: true, buyable: false, sellerId: beckn.SELLER_ID, offerId, pricePerKwh: own.price_per_kwh, availableQty: 0, reason: "This offer is fully sold — no capacity remains." };
      }
      return { found: true, buyable: true, sellerId: beckn.SELLER_ID, offerId, pricePerKwh: own.price_per_kwh, availableQty: remaining };
    }
  } catch (err) {
    console.error("resolveOffer: could not reach Seller Platform at", SELLER_APP_URL, "—", err.message || err);
  }

  const discovered = db.prepare("SELECT * FROM discovered_offers WHERE offer_id=?").get(offerId);
  if (discovered) {
    return {
      found: true,
      buyable: false,
      sellerId: discovered.seller_id,
      offerId,
      pricePerKwh: discovered.price_per_kwh,
      availableQty: discovered.available_qty,
      reason: `Not currently live on ${discovered.seller_id === beckn.SELLER_ID ? "the matching" : discovered.seller_id + "'s"} real catalog right now — either it's your own past publish that's no longer live (republish it to buy it), or a different real network participant's offer this demo instance has no live routing endpoint for.`,
    };
  }

  return { found: false, buyable: false, offerId, reason: "Unknown offer ID — never seen via discover, and not published on our own Seller Platform." };
}

app.get("/api/resolve-offer/:offerId", async (req, res) => {
  res.json(await resolveOffer(req.params.offerId));
});

// ---------- Which discovered offers are genuinely ours, right now ----------
// The only reliable test: is this offer_id actually sitting in the Seller
// Platform's own live catalog at this exact moment? Comparing seller_id
// strings doesn't work (see resolveOffer's comment above) — this proxies
// the real check server-side so the browser never needs cross-origin
// access to the Seller Platform (which may be on an entirely different
// tunnel domain during the real demo).
app.get("/api/my-offers", async (req, res) => {
  try {
    const sellerOffers = await fetch(`${SELLER_APP_URL}/api/offers`).then((r) => (r.ok ? r.json() : []));
    res.json({ ok: true, offerIds: sellerOffers.map((o) => o.id) });
  } catch (err) {
    res.json({ ok: false, offerIds: [], error: String(err.message || err) });
  }
});

// ---------- Network Dashboard: real, ledger-verified trades ----------
// Cached briefly so the dashboard can poll every few seconds without
// re-signing and re-querying the real external ledger on every tick.
let ledgerCache = { at: 0, data: null, error: null };
const LEDGER_CACHE_MS = 15000;
app.get("/api/network/ledger-trades", async (req, res) => {
  try {
    if (!ledgerCache.data || Date.now() - ledgerCache.at > LEDGER_CACHE_MS) {
      const records = await ledger.fetchLedgerTrades({});
      ledgerCache = { at: Date.now(), data: ledger.groupTradesByTransaction(records), error: null };
    }
    res.json({ trades: ledgerCache.data, ledgerUrl: ledger.LEDGER_URL, asOf: new Date(ledgerCache.at).toISOString() });
  } catch (err) {
    console.error("ledger-trades failed:", err.message || err);
    // Serve the last good cache (if any) rather than a hard failure —
    // a transient real network hiccup shouldn't blank out the dashboard
    // mid-demo. Only return an error if we've never had one.
    if (ledgerCache.data) {
      return res.json({ trades: ledgerCache.data, ledgerUrl: ledger.LEDGER_URL, asOf: new Date(ledgerCache.at).toISOString(), staleWarning: String(err.message || err) });
    }
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---------- Reset: wipe this platform's own data for a fresh demo run ----------
// Only ever touches this app's own database file — the seller platform
// has to be reset separately from its own dashboard, on purpose (see
// ARCHITECTURE.md §2: no shared state between the two platforms, ever).
app.post("/api/reset", (req, res) => {
  try {
    db.exec("DELETE FROM trades");
    db.exec("DELETE FROM discovered_offers");
    db.exec("DELETE FROM events");
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
// bidPricePerKwh is a real negotiating bid, not necessarily the seller's
// listed ask — defaults to the ask when omitted or invalid, so the plain
// "just buy at the listed price" path still works with zero extra typing.
// Quantity is still always capped server-side to what's actually available
// (never taken on faith from the client) — bidding is only ever on price.
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
    // bypassed by anyone calling this API directly). The seller's real,
    // currently-published ask is always known before we act — our own bid
    // is allowed to differ from it (that's the negotiation), but never the
    // available quantity.
    const resolution = await resolveOffer(offerId);
    if (!resolution.found) return res.status(404).json({ error: resolution.reason });
    if (!resolution.buyable) return res.status(409).json({ error: resolution.reason });
    if (requestedQty > resolution.availableQty) {
      return res.status(400).json({ error: `Only ${resolution.availableQty} kWh is available on this offer — ${requestedQty} kWh was requested.` });
    }
    const askingPricePerKwh = resolution.pricePerKwh;
    const bid = Number(req.body.bidPricePerKwh);
    const pricePerKwh = bid > 0 ? bid : askingPricePerKwh;
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
        `INSERT INTO trades (transaction_id, offer_id, bpp_id, buyer_discom, requested_qty, price_per_kwh, asking_price_per_kwh, status, error_message, raw_context, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(context.transactionId, offerId, beckn.SELLER_ID, buyerDiscomId, quantityKwh, pricePerKwh, askingPricePerKwh, "REJECTED", errorMessage, JSON.stringify({ context, message }), now, now);
      logEvent(context.transactionId, "init", "sent", `Bid ₹${pricePerKwh}/kWh for ${quantityKwh} kWh`, { context, message });
      logEvent(context.transactionId, "init", "received", `Rejected: ${errorMessage}`);
      const rejected = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId));
      broadcast("rejected", rejected);
      return res.status(200).json({ ok: false, rejected: true, trade: rejected });
    }

    db.prepare(
      `INSERT INTO trades (transaction_id, offer_id, bpp_id, buyer_discom, requested_qty, price_per_kwh, asking_price_per_kwh, status, raw_context, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(context.transactionId, offerId, beckn.SELLER_ID, buyerDiscomId, quantityKwh, pricePerKwh, askingPricePerKwh, "PENDING", JSON.stringify({ context, message }), now, now);
    logEvent(context.transactionId, "init", "sent", `Bid ₹${pricePerKwh}/kWh for ${quantityKwh} kWh${bid > 0 && bid !== askingPricePerKwh ? ` (ask was ₹${askingPricePerKwh}/kWh)` : ""}`, { context, message });

    const trade = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId));
    broadcast("buy_sent", trade);
    res.json({ ok: true, trade });
  } catch (err) {
    console.error("buy failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------- Buyer's real decision when the seller's on_init came back
// with different terms than we bid (a genuine counter-offer) ----------
async function sendRealConfirm(row) {
  const stored = JSON.parse(row.raw_context);
  const onConfirm = beckn.buildConfirm(stored.context, stored.message.contract);
  const result = await beckn.postToOnix("/bap/caller/confirm", onConfirm);
  const now = beckn.nowIso();
  db.prepare("UPDATE trades SET status=?, raw_context=?, updated_at=? WHERE transaction_id=?").run("CONFIRMING", JSON.stringify(onConfirm), now, row.transaction_id);
  logEvent(row.transaction_id, "confirm", "sent", "Confirmed", onConfirm);
  broadcast("confirming", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(row.transaction_id)));
  if (!result.ok) console.error("confirm send failed:", result.status, result.json);
  return result;
}

app.post("/api/trade/:transactionId/accept-counter", async (req, res) => {
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(req.params.transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "AWAITING_MY_DECISION") return res.status(409).json({ error: `trade is ${row.status}, not awaiting a decision` });
  try {
    await sendRealConfirm(row);
    res.json({ ok: true, trade: tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(row.transaction_id)) });
  } catch (err) {
    console.error("accept-counter failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/trade/:transactionId/decline-counter", async (req, res) => {
  const { transactionId } = req.params;
  const row = db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId);
  if (!row) return res.status(404).json({ error: "trade not found" });
  if (row.status !== "AWAITING_MY_DECISION") return res.status(409).json({ error: `trade is ${row.status}, not awaiting a decision` });
  const reason = req.body?.reason || "Buyer declined the counter-offer";
  const now = beckn.nowIso();
  db.prepare("UPDATE trades SET status=?, decline_reason=?, updated_at=? WHERE transaction_id=?").run("DECLINED", reason, now, transactionId);
  logEvent(transactionId, "decline", "local", reason);
  const updated = tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(transactionId));
  broadcast("declined", updated);
  fetch(`${SELLER_APP_URL}/api/notify/${transactionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "counter_declined", reason }),
  }).catch((e) => console.error("notify seller of decline failed (non-fatal):", e.message || e));
  res.json({ ok: true, trade: updated });
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
        const { price: sellerPrice, qty: sellerQty } = beckn.extractInterval0(message.contract);
        const isCountered = (sellerPrice != null && sellerPrice !== row.price_per_kwh) || (sellerQty != null && sellerQty !== row.requested_qty);
        const now = beckn.nowIso();

        if (isCountered) {
          // A real counter-offer — the seller's on_init returned different
          // terms than we bid. This is a genuine decision point, so this
          // does NOT auto-confirm; it waits for the buyer to explicitly
          // accept-counter or decline-counter.
          db.prepare("UPDATE trades SET status=?, seller_price_per_kwh=?, seller_qty=?, raw_context=?, updated_at=? WHERE transaction_id=?").run(
            "AWAITING_MY_DECISION", sellerPrice, sellerQty, JSON.stringify({ context, message }), now, context.transactionId
          );
          logEvent(context.transactionId, "on_init", "received", `Seller countered: ₹${sellerPrice}/kWh for ${sellerQty} kWh (we bid ₹${row.price_per_kwh}/kWh for ${row.requested_qty} kWh)`, { context, message });
          broadcast("seller_countered", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
        } else {
          // Terms match what we asked for — nothing left to actually
          // decide, so confirm→on_confirm proceeds automatically, exactly
          // as the simple "just buy at the listed price" path always has.
          db.prepare("UPDATE trades SET raw_context=?, updated_at=? WHERE transaction_id=?").run(JSON.stringify({ context, message }), now, context.transactionId);
          logEvent(context.transactionId, "on_init", "received", "Seller accepted our bid as-is", { context, message });
          sendRealConfirm(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)).catch((e) => console.error("auto-confirm error:", e));
        }
      }
    } else if (action === "on_confirm") {
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, updated_at=? WHERE transaction_id=?").run("ACTIVE", now, context.transactionId);
      logEvent(context.transactionId, "on_confirm", "received", "Trade is now ACTIVE", { context, message });
      broadcast("active", tradeRow(db.prepare("SELECT * FROM trades WHERE transaction_id=?").get(context.transactionId)));
    } else if (action === "on_status") {
      const buyerCost = beckn.extractRevenueFlow(message.contract, "buyerPlatform");
      const settlementAmount = buyerCost != null ? Math.abs(buyerCost) : null;
      const now = beckn.nowIso();
      db.prepare("UPDATE trades SET status=?, settlement_amount=?, updated_at=? WHERE transaction_id=?").run("SETTLED", settlementAmount, now, context.transactionId);
      logEvent(context.transactionId, "on_status", "received", `Settled — paid ₹${settlementAmount != null ? settlementAmount.toFixed(2) : "?"}`, { context, message });
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

// Run via:  npm test   (resets all four dashboards first and last)
// End-to-end test of the whole demo through the apps' own REST APIs (the same
// calls the dashboards make). Every step hits the real onix/Beckn stack.
const S = "http://localhost:4002", B = "http://localhost:4001", A = "http://localhost:4003", G = "http://localhost:4004";
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(base, path, method = "GET", body) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, ok: r.ok, json, text };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name, extra !== undefined ? "-> " + JSON.stringify(extra) : ""); }
}
async function waitFor(fn, what, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(500); }
  console.log("  (timeout waiting for " + what + ")"); return null;
}
const near = (a, b) => Math.abs(a - b) < 0.011;
async function discoverUntil(ids) {
  if (process.env.NO_TUNNEL) {
    // No public tunnel => the shared-network Discover can't call back. The Buyer
    // resolves offers straight from the Seller/Aggregator platforms anyway
    // (/api/my-offers), which is all the trades below need.
    return waitFor(async () => {
      const mine = (await call(B, "/api/my-offers")).json?.offerIds || [];
      return ids.every((id) => mine.includes(id)) ? [] : null;
    }, "offers visible to the buyer", 20000);
  }
  let last = 0;
  return waitFor(async () => {
    if (Date.now() - last > 12000) { last = Date.now(); await call(B, "/api/discover", "POST", {}); }
    await sleep(2000);
    const offers = (await call(B, "/api/offers")).json || [];
    return ids.every((id) => offers.some((o) => o.offer_id === id)) ? offers : null;
  }, "discovery of " + ids.join(","), 90000);
}
async function publish(qty, price) {
  const r = await call(S, "/api/publish", "POST", { quantityKwh: qty, pricePerKwh: price });
  if (!r.ok) console.log("  publish error:", r.text.slice(0, 300));
  return r.json?.offer?.id;
}
const sellerTrade = async (txn) => ((await call(S, "/api/trades")).json || []).find((t) => t.transactionId === txn);
const buyerTrade = async (txn) => ((await call(B, "/api/trades")).json || []).find((t) => t.transactionId === txn);
const sellerOffer = async (id) => ((await call(S, "/api/offers")).json || []).find((o) => o.id === id);

(async () => {
  console.log("\n== 0. Reset whole demo (from the GRID dashboard's endpoint) ==");
  let r = await call(G, "/api/reset-all", "POST");
  check("reset-all ok on all four", r.json?.ok === true, r.json);
  check("seller empty", ((await call(S, "/api/offers")).json || []).length === 0 && ((await call(S, "/api/trades")).json || []).length === 0);
  check("buyer empty", ((await call(B, "/api/offers")).json || []).length === 0 && ((await call(B, "/api/trades")).json || []).length === 0);
  check("aggregator empty", ((await call(A, "/api/blocks")).json || []).length === 0 && ((await call(A, "/api/requirements")).json || []).length === 0);
  check("grid empty", ((await call(G, "/api/trades")).json || []).length === 0);

  console.log("\n== 1. Direct trade: publish -> discover -> bid at ask -> accept -> auto-confirm -> ACTIVE -> deliver -> SETTLED ==");
  const o1 = await publish(10, 7);
  const o2 = await publish(10, 7.5);
  const o3 = await publish(6, 8);
  check("3 offers published", o1 && o2 && o3);
  const seen = await discoverUntil([o1, o2, o3]);
  check("buyer discovered all 3", !!seen);
  check("my-offers lists them as buyable", (await call(B, "/api/my-offers")).json?.offerIds?.includes(o1));

  let b = await call(B, "/api/buy", "POST", { offerId: o1, quantityKwh: 4, buyerDiscomId: "allowed" });
  check("buy accepted by network", b.json?.ok === true, b.json);
  const t1 = b.json?.trade?.transactionId;
  check("seller sees PENDING_ACCEPT", !!(await waitFor(async () => (await sellerTrade(t1))?.status === "PENDING_ACCEPT", "seller incoming")));
  let acc = await call(S, `/api/respond/${t1}`, "POST", { decision: "accept" });
  check("seller accept ok", acc.json?.ok === true, acc.json);
  check("capacity reserved 10 -> 6", near((await sellerOffer(o1)).remaining_qty, 6));
  check("both sides ACTIVE (no race)", !!(await waitFor(async () => (await sellerTrade(t1))?.status === "ACTIVE" && (await buyerTrade(t1))?.status === "ACTIVE", "ACTIVE both")), [await sellerTrade(t1), await buyerTrade(t1)]);
  let dv = await call(S, `/api/deliver/${t1}`, "POST", { finalAlloc: 3.6 });
  check("deliver ok", dv.json?.ok === true, dv.json);
  // 4 kWh @ 7: delivered 3.6 -> energy 25.2, seller wheeling 1.8, penalty 2.5*0.4=1.0 -> seller 22.4; buyer 25.2+1.8=27.0
  check("seller settlement 22.40", near((await sellerTrade(t1))?.settlementAmount, 22.4), await sellerTrade(t1));
  check("buyer sees SETTLED paying 27.00", !!(await waitFor(async () => { const t = await buyerTrade(t1); return t?.status === "SETTLED" && near(t.settlementAmount, 27.0); }, "buyer settled")), await buyerTrade(t1));
  check("double delivery rejected", (await call(S, `/api/deliver/${t1}`, "POST", { finalAlloc: 3.6 })).status === 409);

  console.log("\n== 2. Counter-offer: buyer bids low -> seller counters -> buyer accepts -> settle ==");
  b = await call(B, "/api/buy", "POST", { offerId: o2, quantityKwh: 5, bidPricePerKwh: 6.5, buyerDiscomId: "allowed" });
  const t2 = b.json?.trade?.transactionId;
  check("bid placed", b.json?.ok === true, b.json);
  await waitFor(async () => (await sellerTrade(t2))?.status === "PENDING_ACCEPT", "seller incoming 2");
  acc = await call(S, `/api/respond/${t2}`, "POST", { decision: "counter", pricePerKwh: 7.2, quantityKwh: 4 });
  check("seller counter ok", acc.json?.ok === true, acc.json);
  check("buyer sees AWAITING_MY_DECISION with seller terms", !!(await waitFor(async () => { const t = await buyerTrade(t2); return t?.status === "AWAITING_MY_DECISION" && t.sellerPricePerKwh === 7.2 && t.sellerQty === 4; }, "buyer counter")), await buyerTrade(t2));
  check("capacity reserved 10 -> 6 (counter qty 4)", near((await sellerOffer(o2)).remaining_qty, 6));
  let ac = await call(B, `/api/trade/${t2}/accept-counter`, "POST");
  check("accept-counter ok", ac.json?.ok === true, ac.json);
  check("both ACTIVE", !!(await waitFor(async () => (await sellerTrade(t2))?.status === "ACTIVE" && (await buyerTrade(t2))?.status === "ACTIVE", "ACTIVE both 2")));
  dv = await call(S, `/api/deliver/${t2}`, "POST", { finalAlloc: 4 });
  // 4 kWh @ 7.2 full delivery -> energy 28.8, seller 28.8-2.0=26.8, buyer 28.8+2.0=30.8
  check("seller settlement 26.80 (agreed counter terms)", near((await sellerTrade(t2))?.settlementAmount, 26.8), await sellerTrade(t2));
  check("buyer paid 30.80", !!(await waitFor(async () => { const t = await buyerTrade(t2); return t?.status === "SETTLED" && near(t.settlementAmount, 30.8); }, "buyer settled 2")), await buyerTrade(t2));

  console.log("\n== 3. Buyer declines a counter -> reserved capacity released ==");
  b = await call(B, "/api/buy", "POST", { offerId: o3, quantityKwh: 3, bidPricePerKwh: 6.5, buyerDiscomId: "allowed" });
  const t3 = b.json?.trade?.transactionId;
  await waitFor(async () => (await sellerTrade(t3))?.status === "PENDING_ACCEPT", "seller incoming 3");
  await call(S, `/api/respond/${t3}`, "POST", { decision: "counter", pricePerKwh: 8, quantityKwh: 3 });
  await waitFor(async () => (await buyerTrade(t3))?.status === "AWAITING_MY_DECISION", "buyer counter 3");
  check("reserved 6 -> 3", near((await sellerOffer(o3)).remaining_qty, 3));
  await call(B, `/api/trade/${t3}/decline-counter`, "POST", { reason: "too pricey" });
  check("capacity released back to 6", !!(await waitFor(async () => near((await sellerOffer(o3)).remaining_qty, 6), "release")), await sellerOffer(o3));
  check("seller trade DECLINED", (await sellerTrade(t3))?.status === "DECLINED", await sellerTrade(t3));
  await call(B, `/api/trade/${t3}/decline-counter`, "POST", {});
  check("duplicate decline does not release twice", near((await sellerOffer(o3)).remaining_qty, 6));

  console.log("\n== 4. Seller declines outright -> buyer sees DECLINED ==");
  b = await call(B, "/api/buy", "POST", { offerId: o3, quantityKwh: 2, buyerDiscomId: "allowed" });
  const t4 = b.json?.trade?.transactionId;
  await waitFor(async () => (await sellerTrade(t4))?.status === "PENDING_ACCEPT", "seller incoming 4");
  await call(S, `/api/respond/${t4}`, "POST", { decision: "decline", reason: "sold elsewhere" });
  check("buyer DECLINED", !!(await waitFor(async () => (await buyerTrade(t4))?.status === "DECLINED", "buyer declined")), await buyerTrade(t4));
  check("capacity untouched by an outright decline", near((await sellerOffer(o3)).remaining_qty, 6));

  console.log("\n== 5. Policy rejection: blocked DISCOM; and over-quantity ==");
  b = await call(B, "/api/buy", "POST", { offerId: o3, quantityKwh: 1, buyerDiscomId: "blocked" });
  check("blocked discom REJECTED with reason", b.json?.rejected === true && !!b.json?.trade?.errorMessage, b.json);
  b = await call(B, "/api/buy", "POST", { offerId: o3, quantityKwh: 99, buyerDiscomId: "allowed" });
  check("over-quantity refused (400)", b.status === 400, b.json);
  b = await call(B, "/api/buy", "POST", { offerId: o3, quantityKwh: 1, bidPricePerKwh: 2, buyerDiscomId: "allowed" });
  check("price below policy band rejected by network", b.json?.rejected === true || b.status >= 400, b.json);

  console.log("\n== 6. Aggregation: requirement -> recommend -> pool -> publish (reserves seller capacity) -> grid buys -> deliver -> disaggregate ==");
  await call(G, "/api/reset-all", "POST");
  const a1 = await publish(10, 7), a2 = await publish(8, 7.5), a3 = await publish(6, 8);
  await discoverUntil([a1, a2, a3]);
  const rq = await call(G, "/api/requirements", "POST", { quantityKwh: 20, maxPricePerKwh: 9 });
  const reqId = rq.json?.id;
  check("requirement posted", !!reqId, rq.json);
  const rec = await call(A, `/api/requirements/${reqId}/recommend`, "POST");
  check("recommendation covers the ask within ceiling", rec.json?.fulfilled === true && near(rec.json.totalQty, 20), rec.json);
  for (const p of rec.json.picked) await call(A, "/api/pool/enroll", "POST", { offerId: p.offerId, sellerId: p.sellerId, pricePerKwh: p.pricePerKwh, qty: p.takeQty });
  const before = {}; for (const p of rec.json.picked) before[p.offerId] = (await sellerOffer(p.offerId)).remaining_qty;
  const pub = await call(A, "/api/pool/publish", "POST", { marginPerKwh: 0.3, requirementId: reqId });
  check("block published", pub.json?.ok === true, pub.json);
  const blockId = pub.json?.block?.id;
  let reservedOk = true;
  for (const p of rec.json.picked) { const now = (await sellerOffer(p.offerId)).remaining_qty; if (!near(now, before[p.offerId] - p.takeQty)) reservedOk = false; }
  check("pooled quantities RESERVED on seller-app (no double-sell)", reservedOk);
  const direct = await call(B, "/api/buy", "POST", { offerId: a1, quantityKwh: 10, buyerDiscomId: "allowed" });
  check("pooled seller offer can no longer be bought in full directly", direct.status >= 400, direct.json);
  const myo = (await call(B, "/api/my-offers")).json?.offerIds || [];
  check("requirement block is NOT offered to the generic buyer (reserved for the DISCOM)", !myo.includes(blockId), myo);
  const resv = await call(B, "/api/buy", "POST", { offerId: blockId, quantityKwh: 2, buyerDiscomId: "allowed" });
  check("generic buyer cannot buy a reserved block", resv.status >= 400 && !resv.json?.trade, resv.json);
  check("aggregator marks the block reserved", ((await call(A, "/api/offers")).json || []).find((o) => o.id === blockId)?.reserved_for === reqId);
  check("block capacity untouched by the declined low bid", near(((await call(A, "/api/offers")).json.find((o) => o.id === blockId)).remaining_qty, 20));

  // parallel double-click on grid buy: exactly one purchase
  const [g1, g2] = await Promise.all([call(G, `/api/requirements/${reqId}/buy`, "POST"), call(G, `/api/requirements/${reqId}/buy`, "POST")]);
  check("double-click buy: exactly one succeeds, the other is blocked", [g1, g2].filter((x) => x.json?.ok).length === 1 && [g1, g2].some((x) => x.status === 409), [g1.json, g2.json]);
  const gt = await waitFor(async () => { const t = ((await call(G, "/api/trades")).json || []); return t.length === 1 && t[0].status === "ACTIVE" ? t[0] : null; }, "grid trade ACTIVE");
  check("grid trade ACTIVE after auto accept+confirm", !!gt, (await call(G, "/api/trades")).json);
  check("requirement FULFILLED, fulfilled_qty = 20", await waitFor(async () => { const q = ((await call(A, "/api/requirements")).json || [])[0]; return q?.status === "FULFILLED" && near(q.fulfilled_qty, 20); }, "fulfilled"), (await call(A, "/api/requirements")).json);
  const dg = await call(A, `/api/deliver/${gt.transactionId}`, "POST", { finalAlloc: 19 });
  check("aggregator deliver ok", dg.json?.ok === true, dg.json);
  const blocks = (await call(A, "/api/blocks")).json;
  const tr = blocks[0].trades[0];
  const d = tr.disaggregation;
  check("trade SETTLED with member payouts", tr.status === "SETTLED" && d.memberPayouts?.length === 3, d);
  check("payouts + margin reconcile to what the aggregator received", near(d.sumMemberNet + d.aggregatorMargin, d.settlementAmount), d);
  check("grid trade SETTLED, paid = energy + buyer wheeling", !!(await waitFor(async () => { const t = ((await call(G, "/api/trades")).json || [])[0]; return t?.status === "SETTLED" && near(t.settlementAmount, d.buyerPayable); }, "grid settled")), [(await call(G, "/api/trades")).json, d.buyerPayable]);
  check("intended margin is per-trade (0.3 x 20)", near(d.intendedMargin, 6), d.intendedMargin);
  // credits are sent right after the settle response, so give them a moment
  await waitFor(async () => ((await call(S, "/api/payouts")).json || []).length === 3, "3 seller credits", 15000);
  const se = (await call(S, "/api/earnings")).json;
  check("SELLER wallet credited with its share of the pooled block", near(se.pooled, d.sumMemberNet) && se.pooled > 0, [se, d.sumMemberNet]);
  check("seller payouts listed (3 offers)", ((await call(S, "/api/payouts")).json || []).length === 3);
  check("GRID wallet = what it paid", near((await call(G, "/api/wallet")).json.total, d.buyerPayable), (await call(G, "/api/wallet")).json);
  const aw = (await call(A, "/api/wallet")).json;
  check("AGGREGATOR wallet = margin kept", near(aw.total, d.aggregatorMargin) && near(aw.received, d.settlementAmount), [aw, d.aggregatorMargin]);
  const sh = (await call(S, "/api/wallet/history")).json;
  check("SELLER history: 3 payouts, balance = wallet, every row has a calculation", sh.entries.length === 3 && near(sh.balance, se.total) && sh.entries.every((e) => e.lines.length >= 4 && e.balanceAfter != null), sh);
  const gh = (await call(G, "/api/wallet/history")).json;
  check("GRID history: 1 payment, shows delivered kWh + wheeling", gh.entries.length === 1 && near(gh.balance, -d.buyerPayable) && gh.entries[0].lines.some((l) => /wheeling/i.test(l.label)), gh);
  const ah = (await call(A, "/api/wallet/history")).json;
  check("AGGREGATOR history: 1 entry = margin, lists a payout per seller + plan reconciliation", ah.entries.length === 1 && near(ah.balance, d.aggregatorMargin) && ah.entries[0].lines.filter((l) => /^− Paid to/.test(l.label)).length === 3 && ah.entries[0].lines.some((l) => /Planned margin/.test(l.label)), ah.entries[0]?.lines);

  console.log("\n== 7. Block sold in TWO trades: both visible and both deliverable ==");
  await call(G, "/api/reset-all", "POST");
  const c1 = await publish(10, 7), c2 = await publish(10, 7.5);
  await discoverUntil([c1, c2]);
  await call(A, "/api/pool/enroll", "POST", { offerId: c1, sellerId: "sellerapp.example.com", pricePerKwh: 7, qty: 10 });
  await call(A, "/api/pool/enroll", "POST", { offerId: c2, sellerId: "sellerapp.example.com", pricePerKwh: 7.5, qty: 10 });
  const pub2 = await call(A, "/api/pool/publish", "POST", { marginPerKwh: 0.4 });
  const blk2 = pub2.json?.block?.id;
  check("second block published", !!blk2, pub2.json);
  await discoverUntil([blk2]);
  const x1 = await call(B, "/api/buy", "POST", { offerId: blk2, quantityKwh: 5, buyerDiscomId: "allowed" });
  const x2 = await call(B, "/api/buy", "POST", { offerId: blk2, quantityKwh: 7, buyerDiscomId: "allowed" });
  const tx1 = x1.json?.trade?.transactionId, tx2 = x2.json?.trade?.transactionId;
  check("both buys placed", !!tx1 && !!tx2, [x1.json, x2.json]);
  check("both ACTIVE on buyer", !!(await waitFor(async () => (await buyerTrade(tx1))?.status === "ACTIVE" && (await buyerTrade(tx2))?.status === "ACTIVE", "both active", 60000)), [await buyerTrade(tx1), await buyerTrade(tx2)]);
  const blk2o = ((await call(A, "/api/offers")).json || []).find((o) => o.id === blk2);
  const low = await call(B, "/api/buy", "POST", { offerId: blk2, quantityKwh: 2, bidPricePerKwh: blk2o.price_per_kwh - 1.5, buyerDiscomId: "allowed" });
  const tLow = low.json?.trade?.transactionId;
  check("below-price bid on an open block ends DECLINED/REJECTED (not stuck PENDING, not sold at a loss)", !!(await waitFor(async () => ["DECLINED", "REJECTED"].includes((await buyerTrade(tLow))?.status), "low bid declined")), await buyerTrade(tLow));
  let bl = (await call(A, "/api/blocks")).json[0];
  check("block shows BOTH trades, 12 sold / 8 left", bl.trades.length === 2 && near(bl.remaining_qty, 8), { n: bl.trades.length, rem: bl.remaining_qty });
  const rd1 = await call(A, `/api/deliver/${tx1}`, "POST", { finalAlloc: 5 });
  const al = (await call(A, `/api/deliver/${tx2}/allocations`)).json.allocations;
  check("trade allocations add up to the traded quantity", near(al.reduce((s, x) => s + x.allocatedKwh, 0), 7), al);
  // seller 1 meters more than its share, seller 2 comes up 1 kWh short
  const rd2 = await call(A, `/api/deliver/${tx2}`, "POST", { readings: [{ offerId: al[0].offerId, kwh: al[0].allocatedKwh + 3 }, { offerId: al[1].offerId, kwh: al[1].allocatedKwh - 1 }] });
  check("EARLIER trade can still be delivered (was unreachable before)", rd1.json?.ok === true && rd2.json?.ok === true, [rd1.json, rd2.json]);
  bl = (await call(A, "/api/blocks")).json[0];
  check("both settle with independent disaggregation", bl.trades.every((t) => t.status === "SETTLED" && near(t.disaggregation.sumMemberNet + t.disaggregation.aggregatorMargin, t.disaggregation.settlementAmount)), bl.trades.map((t) => t.disaggregation));

  const tr2 = bl.trades.find((t) => t.transactionId === tx2).disaggregation;
  const [m0, m1] = tr2.memberPayouts;
  check("over-delivery is capped at the allocated share (not paid beyond contract)", near(m0.deliveredShare, m0.allocatedQty) && m0.penalty === 0, m0);
  check("ONLY the short seller bears a penalty (1 kWh x 2.50)", near(m1.shortfall, 1) && near(m1.penalty, 2.5) && near(m1.net, m1.gross - m1.wheeling - 2.5), m1);
  check("total delivered = sum of the sellers' own meters", near(tr2.finalAlloc, m0.deliveredShare + m1.deliveredShare), tr2);
  check("aggregator margin = block price x delivered - sellers' own-price energy", near(tr2.aggregatorMargin, tr2.finalAlloc * tr2.pricePerKwh - (m0.deliveredShare * m0.originalPricePerKwh + m1.deliveredShare * m1.originalPricePerKwh)), tr2);
  const bad = await call(A, `/api/deliver/${tx1}`, "POST", { readings: [] });
  check("settled trade cannot be re-reported", bad.status === 409, bad.json);
  await waitFor(async () => ((await call(S, "/api/payouts")).json || []).length === 4, "4 seller credits", 15000);
  const se2 = (await call(S, "/api/earnings")).json;
  const sumNets = bl.trades.reduce((s, t) => s + t.disaggregation.sumMemberNet, 0);
  check("seller wallet = sum of both trades' payouts", near(se2.pooled, sumNets), [se2, sumNets]);
  const bw = (await call(B, "/api/wallet")).json;
  const bh = (await call(B, "/api/wallet/history")).json;
  check("BUYER history: both purchases, balance = -(wallet)", bh.entries.length === 2 && near(bh.balance, -bw.total) && bh.entries.every((e) => e.lines.some((l) => /Energy/.test(l.label))), bh);
  const ah2 = (await call(A, "/api/wallet/history")).json;
  check("AGGREGATOR history lists both trades, balance = wallet margin", ah2.entries.length === 2 && near(ah2.balance, (await call(A, "/api/wallet")).json.total), ah2.balance);
  check("BUYER wallet = what the buyer paid on both trades", near(bw.total, bl.trades.reduce((s, t) => s + t.disaggregation.buyerPayable, 0)), bw);

  console.log("\n== 7b. Withdraw unsold capacity; partial requirement ==");
  const c1Before = (await sellerOffer(c1)).remaining_qty;
  const wd = await call(A, `/api/blocks/${blk2}/withdraw`, "POST");
  check("withdraw unsold ok (8 kWh)", wd.json?.ok === true && near(wd.json.withdrawnKwh, 8), wd.json);
  check("capacity handed back to the pooled sellers", near((await sellerOffer(c1)).remaining_qty, c1Before + 4) && near((await sellerOffer(c2)).remaining_qty, 4), [await sellerOffer(c1), await sellerOffer(c2)]);
  check("second withdraw refused", (await call(A, `/api/blocks/${blk2}/withdraw`, "POST")).status === 409);

  await call(G, "/api/reset-all", "POST");
  const e1 = await publish(10, 7), e2 = await publish(8, 7.5), e3 = await publish(6, 8);
  check("aggregator sees new seller offers straight away (no buyer discover)", !!(await waitFor(async () => { const l = (await call(A, "/api/available-offers")).json || []; return [e1, e2, e3].every((id) => l.some((o) => o.offer_id === id)); }, "aggregator list", 15000)));
  const bigReq = (await call(G, "/api/requirements", "POST", { quantityKwh: 100, maxPricePerKwh: 12 })).json.id;
  const rc = (await call(A, `/api/requirements/${bigReq}/recommend`, "POST")).json;
  check("short supply: recommendation flags 76 kWh shortfall", rc.fulfilled === false && near(rc.totalQty, 24) && near(rc.shortfallQty, 76), rc);
  for (const p of rc.picked) await call(A, "/api/pool/enroll", "POST", { offerId: p.offerId, sellerId: p.sellerId, pricePerKwh: p.pricePerKwh, qty: p.takeQty });
  const pp = await call(A, "/api/pool/publish", "POST", { marginPerKwh: 0.3, requirementId: bigReq });
  check("partial block published against the requirement", pp.json?.ok === true, pp.json);
  const gr = ((await call(G, "/api/requirements")).json || []).find((x) => x.id === bigReq);
  check("GRID sees the block and the unmet remainder", gr.blocks.length === 1 && near(gr.published_qty, 24) && gr.status === "PUBLISHED", gr);
  const rc2 = (await call(A, `/api/requirements/${bigReq}/recommend`, "POST")).json;
  check("recommend again only asks for the 76 kWh NOT already on offer (no double-publishing)", near(rc2.neededQty, 76) && rc2.totalQty === 0, rc2);
  const gb = await call(G, `/api/requirements/${bigReq}/buy`, "POST");
  check("grid buys the 24 kWh that exist", gb.json?.ok === true, gb.json);

  const single = await publish(20, 7);
  await waitFor(async () => ((await call(A, "/api/available-offers")).json || []).some((o) => o.offer_id === single), "single offer listed", 15000);
  await call(A, "/api/pool/enroll", "POST", { offerId: single, sellerId: "x", pricePerKwh: 99, qty: 8 });
  const dupe = await call(A, "/api/pool/enroll", "POST", { offerId: single, sellerId: "x", pricePerKwh: 1, qty: 13 });
  check("cannot pool more than the offer's free capacity (counts what is already pending)", dupe.status === 409, dupe.json);
  const pool1 = (await call(A, "/api/pool")).json;
  check("pool price comes from the seller's own offer, not the caller", pool1.members[0].price_per_kwh === 7, pool1.members[0]);
  const one = await call(A, "/api/pool/publish", "POST", { marginPerKwh: 0.5 });
  check("ONE offer is enough to publish a block (aggregator as middleman)", one.json?.ok === true && one.json.block.member_count === 1, one.json);
  const oneBlock = one.json.block.id;
  check("remaining free capacity of the single prosumer still listed (12 kWh)", !!(await waitFor(async () => near(((await call(A, "/api/available-offers")).json || []).find((o) => o.offer_id === single)?.available_qty ?? -1, 12), "12 kWh free", 10000)));
  const wd1 = await call(A, `/api/blocks/${oneBlock}/withdraw`, "POST");
  check("withdraw the unsold 8 kWh of the one-seller block", wd1.json?.ok === true && near(wd1.json.withdrawnKwh, 8), wd1.json);
  check("seller's offer is untouched (still listed, 20 kWh capacity back)", near((await sellerOffer(single)).remaining_qty, 20));
  check("withdrawn capacity is discoverable/poolable again", !!(await waitFor(async () => near(((await call(A, "/api/available-offers")).json || []).find((o) => o.offer_id === single)?.available_qty ?? -1, 20), "20 kWh free again", 10000)));
  await call(A, "/api/pool/enroll", "POST", { offerId: single, sellerId: "x", pricePerKwh: 7, qty: 20 });
  const again = await call(A, "/api/pool/publish", "POST", { marginPerKwh: 0.5 });
  check("re-pooled and re-published after the withdraw", again.json?.ok === true, again.json);

  // assign an open-market block to a requirement after the fact
  await call(G, "/api/reset-all", "POST");
  const f1 = await publish(10, 7), f2 = await publish(10, 7.5);
  await waitFor(async () => { const l = (await call(A, "/api/available-offers")).json || []; return [f1, f2].every((id) => l.some((o) => o.offer_id === id)); }, "f offers", 15000);
  await call(A, "/api/pool/enroll", "POST", { offerId: f1, sellerId: "x", pricePerKwh: 7, qty: 10 });
  const open = (await call(A, "/api/pool/publish", "POST", { marginPerKwh: 0.3 })).json.block.id;
  const rq3 = (await call(G, "/api/requirements", "POST", { quantityKwh: 25, maxPricePerKwh: 10 })).json.id;
  const as1 = await call(A, `/api/blocks/${open}/assign`, "POST", { requirementId: rq3 });
  check("open-market block can be reserved for a requirement afterwards", as1.json?.ok === true, as1.json);
  check("...and the Grid then sees it", !!(await call(G, "/api/requirements")).json.find((x) => x.id === rq3)?.blocks.some((b) => b.id === open));
  // top-up: published remainder must be buyable from the Grid after the first part was bought
  const gb1 = await call(G, `/api/requirements/${rq3}/buy`, "POST");
  check("grid buys the first part", gb1.json?.ok === true && near(gb1.json.boughtQty, 10), gb1.json);
  await call(A, "/api/pool/enroll", "POST", { offerId: f2, sellerId: "x", pricePerKwh: 7.5, qty: 10 });
  const top = await call(A, "/api/pool/publish", "POST", { marginPerKwh: 0.3, requirementId: rq3 });
  check("top-up block published against the partly covered requirement", top.json?.ok === true, top.json);
  const gb2 = await call(G, `/api/requirements/${rq3}/buy`, "POST");
  check("grid buys the top-up too (no dead end)", gb2.json?.ok === true && near(gb2.json.boughtQty, 10), gb2.json);

  console.log("\n== 8. Final: reset-all from the buyer endpoint leaves everything clean ==");
  r = await call(B, "/api/reset-all", "POST");
  check("reset-all ok", r.json?.ok === true, r.json);
  check("all clean again", ((await call(S, "/api/offers")).json || []).length === 0 && ((await call(A, "/api/blocks")).json || []).length === 0 && ((await call(G, "/api/trades")).json || []).length === 0 && ((await call(B, "/api/trades")).json || []).length === 0);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH", e); process.exit(2); });

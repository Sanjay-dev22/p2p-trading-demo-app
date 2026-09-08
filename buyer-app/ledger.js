// Real, signed queries against the shared DEG Ledger — the actual
// external system of record for settled P2P trades, entirely independent
// of our own local SQLite copy. This is what makes it possible to prove
// a trade we did really landed somewhere outside our own two apps: every
// row here comes back with its own rowDigest (a real sha256 hash of the
// record), computed and returned by the ledger service itself.
//
// Credentials below are the standard published wave2 `buyerapp.example.com`
// sandbox signing key — the same one already embedded in
// config/local-p2p-trading-buyerapp.yaml for onix's own outbound calls,
// not a secret unique to this app. Signing scheme (BLAKE2b-512 digest of
// the body, Ed25519 signature over a "(created)/(expires)/digest" string,
// same shape as Beckn's own HTTP message signing) mirrors
// platform_trade_report.py in p2p-trading-ies-ledger-ui-client, which
// verified this exact same query against this exact same live ledger.
const crypto = require("crypto");

const SUBSCRIBER_ID = "buyerapp.example.com";
const RECORD_ID = "76EU8w8ynnqbhderWtVE5KpCmgAoVEXtM8JTCuW3PzUSGdMxtFjzyZ";
const SIGNING_PRIVATE_KEY_B64 = "TTQMAEy0xJcoRXRNofZAwZq1c3VH6j98UUaHP7budQQ=";
const LEDGER_URL = process.env.LEDGER_URL || "https://ies-p2p-energy-ledger.beckn.io";

const seed = Buffer.from(SIGNING_PRIVATE_KEY_B64, "base64");
// Ed25519 raw 32-byte seed → PKCS8 DER: a fixed 16-byte ASN.1 prefix
// (RFC 8410) followed by the seed itself — the only way to get Node's
// crypto module to load a raw seed as a real signing key.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });

function signPayload(bodyBuf) {
  const digestB64 = crypto.createHash("blake2b512").update(bodyBuf).digest("base64");
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 300;
  const signingString = `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digestB64}`;
  const signature = crypto.sign(null, Buffer.from(signingString), privateKey).toString("base64");
  return `Signature keyId="${SUBSCRIBER_ID}|${RECORD_ID}|ed25519",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${signature}"`;
}

// Fetch real ledger records since fromDate, paginating through all pages.
//
// Note on scope (corrected — an earlier version of this comment claimed
// the opposite): the query is genuinely global across all platforms in
// the date range, gated only by needing any one valid registered
// participant's signing credentials — not scoped to the signing
// identity's own party. In practice this demo mostly only ever sees its
// own two platforms' trades simply because that's what's actually in the
// ledger for the date ranges queried, not because of an access
// restriction.
//
// Real intermittent failure mode seen in practice: the sandbox signing
// key sometimes gets a 401 `{"code":"SEC_KEY_EXPIRED_OR_REVOKED",
// "message":"Signature expired"}` even though the request's own signature
// window is freshly computed and correct — most likely transient
// key-validity-cache inconsistency on the ledger service's side (some
// backend replica hasn't caught up), not a bug here or a real, permanent
// revocation (later calls with the identical signing scheme succeed
// again). One immediate retry with a freshly re-signed request usually
// clears it; if not, the caller (server.js) falls back to the last good
// cached result rather than showing nothing.
async function fetchLedgerTrades({ fromDate, toDate, limit = 500 } = {}) {
  const from = fromDate || new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const to = toDate || new Date().toISOString();

  async function fetchPage(offset) {
    const payload = { tradeTimeFrom: from, tradeTimeTo: to, sort: "tradeTime", sortOrder: "desc", limit, offset };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const body = Buffer.from(JSON.stringify(payload));
      const auth = signPayload(body); // freshly signed every attempt — never reuse a signature
      const res = await fetch(`${LEDGER_URL}/ledger/get`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      if (attempt === 2) throw new Error(`ledger returned HTTP ${res.status}: ${text.slice(0, 300)}`);
      // First failure: brief pause, then one retry with a brand-new signature.
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  let offset = 0;
  const all = [];
  while (true) {
    const json = await fetchPage(offset);
    const records = json.records || [];
    all.push(...records);
    if (records.length < limit) break;
    offset += limit;
    if (offset > 5000) break; // safety cap — never loop forever on an unexpected response shape
  }
  return all;
}

// A single real trade produces several ledger rows (one per role —
// SELLER, BUYER_DISCOM, SELLER_DISCOM, etc. — and per settlement
// interval), matching platform_trade_report.py's own observation of the
// same data. Group them back into one card per real transaction for
// display, keeping every row's own rowDigest as proof.
function groupTradesByTransaction(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.transactionId)) {
      map.set(r.transactionId, {
        transactionId: r.transactionId,
        orderItemId: r.orderItemId,
        platformIdBuyer: r.platformIdBuyer,
        platformIdSeller: r.platformIdSeller,
        discomIdBuyer: r.discomIdBuyer,
        discomIdSeller: r.discomIdSeller,
        tradeTime: r.tradeTime,
        intervals: [],
        rowDigests: new Set(),
        roles: new Set(),
      });
    }
    const t = map.get(r.transactionId);
    if (r.role) t.roles.add(r.role);
    if (r.rowDigest) t.rowDigests.add(r.rowDigest);
    for (const d of r.tradeDetails || []) {
      t.intervals.push({ qty: d.tradeQty, price: d.pricePerUnit, currency: d.priceCurrency, unit: d.tradeUnit });
    }
    if (r.tradeTime && r.tradeTime > t.tradeTime) t.tradeTime = r.tradeTime;
  }
  return [...map.values()]
    .map((t) => ({
      ...t,
      roles: [...t.roles],
      rowDigests: [...t.rowDigests],
      totalQty: Math.round(t.intervals.reduce((s, i) => s + (i.qty || 0), 0) * 100) / 100,
      avgPrice: t.intervals.length ? Math.round((t.intervals.reduce((s, i) => s + (i.price || 0), 0) / t.intervals.length) * 100) / 100 : null,
      currency: t.intervals[0]?.currency || "INR",
    }))
    .sort((a, b) => (a.tradeTime < b.tradeTime ? 1 : -1));
}

module.exports = { fetchLedgerTrades, groupTradesByTransaction, SUBSCRIBER_ID, LEDGER_URL };

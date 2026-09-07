// Real, file-based storage — Node's own built-in node:sqlite, not the
// better-sqlite3 npm package: that one is a native addon, and its install
// step needs github.com (prebuilt binary) or nodejs.org (headers to
// compile from source) — both routinely blocked on corporate networks
// that only allow package traffic through an internal registry mirror
// (confirmed the hard way: real ENOTFOUND errors on both hosts). Node's
// own node:sqlite needs neither — it ships inside Node itself, so
// `npm install` here never leaves the configured npm registry at all.
// Still marked experimental by Node itself as of this Node version; the
// API used below (prepare/run/get/all) is stable across recent versions.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "seller-app.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    quantity_kwh REAL NOT NULL,
    price_per_kwh REAL NOT NULL,
    published_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    transaction_id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL,
    bap_id TEXT NOT NULL,
    buyer_discom TEXT NOT NULL,
    requested_qty REAL NOT NULL,
    price_per_kwh REAL NOT NULL,
    status TEXT NOT NULL,           -- PENDING_ACCEPT | AWAITING_CONFIRM | ACTIVE | SETTLED
    final_alloc REAL,
    settlement_amount REAL,
    raw_context TEXT NOT NULL,      -- last-seen real Beckn context, JSON — reused to build on_init/on_confirm/on_status
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

module.exports = db;

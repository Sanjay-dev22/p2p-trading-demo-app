// Real, file-based storage — Node's own built-in node:sqlite, not the
// better-sqlite3 npm package. See seller-app/db.js for why: that package
// is a native addon whose install step needs github.com or nodejs.org,
// both routinely blocked on corporate networks. A separate database file
// from the seller's: the buyer platform is architecturally independent
// (p2p-trading-app/ARCHITECTURE.md §2) — the only thing connecting them
// is real Beckn messages through the router.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "buyer-app.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS discovered_offers (
    offer_id TEXT PRIMARY KEY,
    seller_id TEXT,
    name TEXT,
    price_per_kwh REAL,
    available_qty REAL,
    discovered_at TEXT NOT NULL,
    raw_json TEXT
  );

  CREATE TABLE IF NOT EXISTS trades (
    transaction_id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL,
    bpp_id TEXT NOT NULL,
    buyer_discom TEXT NOT NULL,     -- which persona this trade was placed as
    requested_qty REAL NOT NULL,
    price_per_kwh REAL NOT NULL,
    status TEXT NOT NULL,           -- PENDING | CONFIRMING | ACTIVE | SETTLED | REJECTED
    settlement_amount REAL,
    error_message TEXT,
    raw_context TEXT NOT NULL,      -- last-seen real Beckn {context, message}, JSON
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

module.exports = db;

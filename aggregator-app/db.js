// Real, file-based storage — same pattern as seller-app/db.js and
// buyer-app/db.js: Node's own built-in node:sqlite, not the better-sqlite3
// npm package (native-addon install issues on corporate networks). A
// separate database file from either of those apps — the aggregator is
// architecturally its own platform, same "no shared database" principle
// as ARCHITECTURE.md §2 already applies between seller-app and buyer-app.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "aggregator-app.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  -- One row per small seller offer enrolled into a pool. block_id is NULL
  -- while the pool is still being assembled (pre-publish); once the block
  -- is published, every pending member's block_id is set to the real
  -- offerId seller-app assigned, which is what actually ties this table's
  -- bookkeeping to a real, live, tradeable catalog entry.
  CREATE TABLE IF NOT EXISTS pool_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id TEXT,
    offer_id TEXT NOT NULL,
    seller_id TEXT,
    price_per_kwh REAL NOT NULL,
    enrolled_qty REAL NOT NULL,
    enrolled_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pool_members_block ON pool_members(block_id);

  -- One row per published pooled block. id is the real offerId returned by
  -- seller-app's own /api/publish — the aggregator never mints its own
  -- offer identity, it always uses the one the real network actually
  -- assigned, so looking this block up on seller-app's /api/trades later
  -- is a simple, exact match, not a guess.
  CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    total_quantity_kwh REAL NOT NULL,
    blended_price_per_kwh REAL NOT NULL,
    margin_per_kwh REAL NOT NULL,
    member_count INTEGER NOT NULL,
    published_at TEXT NOT NULL,
    bulk_transaction_id TEXT,
    bulk_settlement_amount REAL,
    settled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id TEXT,
    summary TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_id);
`);

module.exports = db;

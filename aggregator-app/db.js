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

  -- One row per published pooled block. id is the real offerId this app's
  -- own beckn.js mints (aggregation-v2: aggregator-app owns its own onix
  -- instance/catalog now — see onix-aggregatorapp — so it mints its own
  -- offer identity exactly like seller-app does for its own offers, rather
  -- than asking seller-app's /api/publish to do it on its behalf).
  -- remaining_qty is the real sellable balance, same role as seller-app's
  -- offers.remaining_qty — decremented when a bulk buyer's init is
  -- accepted, so the block itself can't be double-sold (the known,
  -- disclosed gap this does NOT fix is one level down: the original
  -- pooled small offers still aren't reserved on seller-app's own catalog
  -- the moment they're pooled — see KNOWLEDGE-BASE.md §9).
  CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    total_quantity_kwh REAL NOT NULL,
    remaining_qty REAL NOT NULL,
    blended_price_per_kwh REAL NOT NULL,
    margin_per_kwh REAL NOT NULL,
    member_count INTEGER NOT NULL,
    published_at TEXT NOT NULL
  );

  -- The real bulk trade against a published block — same shape as
  -- seller-app's own trades table, now owned here instead of there, since
  -- the block's lifecycle (init/confirm/deliver/settle) is this app's own
  -- responsibility from aggregation-v2 onward.
  CREATE TABLE IF NOT EXISTS trades (
    transaction_id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL,
    bap_id TEXT,
    buyer_discom TEXT,
    requested_qty REAL,
    price_per_kwh REAL,
    status TEXT NOT NULL,
    final_alloc REAL,
    settlement_amount REAL,
    raw_context TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_block ON trades(block_id);

  -- A bulk-buyer requirement posted by grid-app (aggregation-v2 demand
  -- side) — quantity + a price ceiling the recommended pool must not
  -- exceed. status moves PENDING -> RECOMMENDED -> PUBLISHED.
  CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY,
    quantity_kwh REAL NOT NULL,
    max_price_per_kwh REAL NOT NULL,
    status TEXT NOT NULL,
    block_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id TEXT,
    summary TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_id);
`);

// Lightweight migration for tables created before a requirement could span
// multiple blocks over time (see server.js's "a requirement is fulfilled
// across however many blocks it takes" logic) — see seller-app/db.js for
// why this pattern (no IF NOT EXISTS for columns in node:sqlite).
for (const stmt of [
  // Cumulative kWh actually bought (init-accepted) against this requirement,
  // across however many blocks it took — the authoritative signal for
  // flipping status to FULFILLED, replacing the old one-block-only check.
  "ALTER TABLE requirements ADD COLUMN fulfilled_qty REAL DEFAULT 0",
  // Which requirement (if any) this block was published to serve. A single
  // requirement can now have more than one block over time (partial
  // publish now, topped up later as new sellers appear), found via
  // `SELECT * FROM blocks WHERE requirement_id = ?` rather than trusting
  // requirements.block_id, which only ever points at the most recent one.
  "ALTER TABLE blocks ADD COLUMN requirement_id TEXT",
]) {
  try { db.exec(stmt); } catch (_) { /* column already exists */ }
}

module.exports = db;

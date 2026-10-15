// Real, file-based storage — node:sqlite, same pattern as every other app
// in this demo (see seller-app/db.js for why). grid-app only started
// needing a database with Aggregation v2 Phase 2 — before that it was a
// stateless REST proxy to aggregator-app's own /api/requirements.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "grid-app.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    transaction_id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    bpp_id TEXT NOT NULL,
    bpp_uri TEXT NOT NULL,
    requested_qty REAL NOT NULL,
    price_per_kwh REAL NOT NULL,
    status TEXT NOT NULL,           -- PENDING | ACTIVE | SETTLED | REJECTED
    settlement_amount REAL,
    error_message TEXT,
    raw_context TEXT NOT NULL,      -- last-seen real Beckn {context, message}, JSON
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL,
    action TEXT NOT NULL,           -- init | on_init | confirm | on_confirm | on_status
    direction TEXT NOT NULL,        -- sent | received | local
    summary TEXT,
    payload TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_txn ON events(transaction_id);
`);

module.exports = db;

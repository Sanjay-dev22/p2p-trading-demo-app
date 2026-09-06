// Real, file-based storage (SQLite via better-sqlite3) — no external DB
// server to run. Deliberately the "lightweight demo" choice explained in
// p2p-trading-app/DEMO-APP-PLAN.md §3: real inserts/queries, survives a
// page refresh mid-demo, zero infra beyond this one file.
const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "seller-app.db"));
db.pragma("journal_mode = WAL");

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

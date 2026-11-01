// Shared (copied into each app) helpers for the wallet transaction history.
// An entry is one money movement (or one still-pending commitment) with the
// full calculation behind it, so a reader can verify every rupee by hand.
const round2 = (x) => Math.round(x * 100) / 100;
const inr = (x) => (x < 0 ? "−" : "") + "₹" + Math.abs(x).toFixed(2);
// One row of a breakdown table.
const L = (label, value, opts = {}) => ({ label, value, ...opts });

// Sorts oldest-first to compute the running balance (only settled money moves
// the balance; "pending" entries are commitments that haven't settled yet),
// then returns newest-first for display.
function finish(entries) {
  const asc = [...entries].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let balance = 0;
  for (const e of asc) {
    if (e.kind === "settled") { balance = round2(balance + e.amount); e.balanceAfter = balance; }
  }
  return { balance, entries: asc.reverse() };
}

module.exports = { round2, inr, L, finish };

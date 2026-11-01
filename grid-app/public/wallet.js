// Wallet transaction history — shared by all four dashboards (same file copied
// into each app). Click the wallet in the header to open it; click a row to see
// the full calculation behind that amount.
(function () {
  const css = `
  .wh-back { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; display: flex; align-items: flex-start; justify-content: center; padding: 5vh 12px; overflow-y: auto; }
  .wh-box { background: var(--panel, #131a24); color: var(--text, #e6edf3); border: 1px solid var(--border, #2a3442); border-radius: 12px; width: 100%; max-width: 760px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
  .wh-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border, #2a3442); }
  .wh-head h3 { margin: 0; font-size: 16px; }
  .wh-bal { font-size: 22px; font-weight: 700; color: var(--accent, #4ade80); }
  .wh-sub { font-size: 12px; color: var(--muted, #8b98a9); }
  .wh-x { background: transparent; border: 1px solid var(--border, #2a3442); color: var(--text, #e6edf3); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
  .wh-list { padding: 8px 12px 16px; }
  .wh-empty { padding: 28px 12px; text-align: center; color: var(--muted, #8b98a9); }
  .wh-row { border: 1px solid var(--border, #2a3442); border-radius: 10px; margin: 8px 0; background: var(--panel2, rgba(255,255,255,.02)); }
  .wh-top { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; }
  .wh-top:hover { background: rgba(255,255,255,.04); border-radius: 10px; }
  .wh-main { flex: 1; min-width: 0; }
  .wh-title { font-weight: 600; font-size: 14px; }
  .wh-meta { font-size: 12px; color: var(--muted, #8b98a9); margin-top: 2px; }
  .wh-amt { text-align: right; font-weight: 700; font-size: 15px; white-space: nowrap; }
  .wh-amt.in { color: #4ade80; } .wh-amt.out { color: #f87171; } .wh-amt.pend { color: var(--muted, #8b98a9); font-weight: 600; font-size: 12px; }
  .wh-run { font-size: 11px; color: var(--muted, #8b98a9); font-weight: 400; }
  .wh-detail { display: none; padding: 4px 14px 14px; border-top: 1px dashed var(--border, #2a3442); }
  .wh-row.open .wh-detail { display: block; }
  .wh-box { overflow: hidden; }
  .wh-tbl { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .wh-tbl td { padding: 5px 4px; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
  .wh-tbl td:first-child { width: auto; }
  .wh-tbl td:last-child { width: 118px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .wh-tbl td[colspan] { width: auto; text-align: left; white-space: normal; }
  .wh-tbl tr.strong td { font-weight: 700; border-top: 1px solid var(--border, #2a3442); }
  .wh-note { font-size: 12px; color: var(--muted, #8b98a9); padding: 2px 4px 6px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
  .wh-txn { font-size: 11px; color: var(--muted, #8b98a9); margin-top: 8px; font-family: ui-monospace, Consolas, monospace; }
  .wh-chev { color: var(--muted, #8b98a9); font-size: 12px; }
  `;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (n) => (n < 0 ? "−" : "") + "₹" + Math.abs(n).toFixed(2);

  function ensureStyle() {
    if (document.getElementById("wh-style")) return;
    const st = document.createElement("style"); st.id = "wh-style"; st.textContent = css; document.head.appendChild(st);
  }

  function lineHtml(l) {
    // A "note" line carries its text in the label and spans the full width.
    if (l.note) return `<tr><td colspan="2"><div class="wh-note">${esc(l.label)}${l.value ? ` — ${esc(l.value)}` : ""}</div></td></tr>`;
    return `<tr class="${l.strong ? "strong" : ""}"><td>${esc(l.label)}</td><td>${esc(l.value)}</td></tr>`;
  }

  function entryHtml(e, i) {
    const cls = e.kind === "pending" ? "pend" : (e.amount >= 0 ? "in" : "out");
    const amt = e.kind === "pending" ? "pending" : (e.amount >= 0 ? "+" : "") + money(e.amount);
    const when = e.at ? new Date(e.at).toLocaleString() : "";
    return `<div class="wh-row" data-i="${i}">
      <div class="wh-top" onclick="this.parentNode.classList.toggle('open')">
        <div class="wh-main"><div class="wh-title">${esc(e.title)}</div><div class="wh-meta">${esc(e.subtitle || "")} · ${esc(when)}</div></div>
        <div class="wh-amt ${cls}">${esc(amt)}${e.kind === "settled" ? `<div class="wh-run">balance ${money(e.balanceAfter)}</div>` : ""}</div>
        <div class="wh-chev">▾</div>
      </div>
      <div class="wh-detail"><table class="wh-tbl">${(e.lines || []).map(lineHtml).join("")}</table>
        <div class="wh-txn">trade ${esc(e.transactionId || "")}</div></div>
    </div>`;
  }

  async function openWalletHistory(title) {
    ensureStyle();
    const back = document.createElement("div");
    back.className = "wh-back";
    back.innerHTML = `<div class="wh-box"><div class="wh-head"><div><h3>${esc(title || "Wallet")}</h3><div class="wh-sub">Click any transaction to see exactly how the amount was calculated</div></div><div style="text-align:right"><div class="wh-bal" id="whBal">…</div><div class="wh-sub">settled balance</div></div><button class="wh-x" id="whClose">Close</button></div><div class="wh-list" id="whList"><div class="wh-empty">Loading…</div></div></div>`;
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("click", (ev) => { if (ev.target === back) close(); });
    document.body.appendChild(back);
    back.querySelector("#whClose").onclick = close;
    try {
      const data = await (await fetch("/api/wallet/history")).json();
      back.querySelector("#whBal").textContent = money(data.balance || 0);
      back.querySelector("#whList").innerHTML = (data.entries || []).length
        ? data.entries.map(entryHtml).join("")
        : `<div class="wh-empty">No transactions yet. They appear here as trades settle.</div>`;
    } catch (e) {
      back.querySelector("#whList").innerHTML = `<div class="wh-empty">Could not load history: ${esc(e.message || e)}</div>`;
    }
  }
  window.openWalletHistory = openWalletHistory;
})();

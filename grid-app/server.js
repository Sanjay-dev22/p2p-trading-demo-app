// Grid/DISCOM Platform — the demand side of aggregation-v2. Posts a bulk
// energy requirement (quantity + a price ceiling) and watches it get
// matched and fulfilled. Deliberately REST-only: no onix adapter, no
// beckn.js, in this phase — it talks to aggregator-app's own REST API
// exactly the way aggregator-app itself already talks to seller-app/
// buyer-app (see aggregator-app/peers.js). Giving Grid/DISCOM its own onix
// identity to execute the real discover/buy/confirm directly (instead of
// buyer-app doing it) is a clean, separately-schedulable later phase — see
// KNOWLEDGE-BASE.md's aggregation-v2 section for the full reasoning.
const express = require("express");
const path = require("path");

const PORT = process.env.PORT || 4004;
const AGGREGATOR_APP_URL = process.env.AGGREGATOR_APP_URL || "http://localhost:4003";

async function getJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    return { ok: false, status: 0, json: null, text: `network error reaching ${url}: ${err.message || err}` };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body, text kept below */ }
  return { ok: res.ok, status: res.status, json, text };
}

function extractError(result) {
  return result.json?.error || (result.text && result.text.trim()) || `aggregator-app returned HTTP ${result.status || "(no response)"} with no readable body`;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => res.status(200).send("ok"));

app.get("/api/requirements", async (req, res) => {
  const result = await getJson(`${AGGREGATOR_APP_URL}/api/requirements`);
  if (!result.ok) return res.status(result.status || 502).json({ error: extractError(result) });
  res.json(result.json || []);
});

app.post("/api/requirements", async (req, res) => {
  const quantityKwh = Number(req.body?.quantityKwh);
  const maxPricePerKwh = Number(req.body?.maxPricePerKwh);
  if (!quantityKwh || quantityKwh <= 0 || !maxPricePerKwh || maxPricePerKwh <= 0) {
    return res.status(400).json({ error: "quantityKwh and maxPricePerKwh must be positive numbers" });
  }
  const result = await getJson(`${AGGREGATOR_APP_URL}/api/requirements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantityKwh, maxPricePerKwh }),
  });
  if (!result.ok) return res.status(result.status || 502).json({ error: extractError(result) });
  res.json(result.json);
});

app.listen(PORT, () => {
  console.log(`Grid/DISCOM Platform listening on http://localhost:${PORT}`);
  console.log(`  → posting requirements to aggregator-app at ${AGGREGATOR_APP_URL}`);
});

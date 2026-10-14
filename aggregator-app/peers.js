// Deliberately NOT a beckn.js — this app never constructs or signs a real
// Beckn message itself, and never talks to onix directly. Here's why, and
// why that's the right call rather than a shortcut:
//
// A real P2P discover is async: onix-buyerapp's config has ONE fixed
// webhook target baked in (host.docker.internal:4001/api/bap-webhook —
// buyer-app, see buyer-app/server.js's own startup log), decided once in
// onix's own config file. If this app called /bap/caller/discover on the
// same onix-buyerapp instance, the real on_discover callback would still
// land at buyer-app, not here — this app would send the request and never
// see its own answer. Same story for publish: onix-sellerapp's init/
// confirm/status webhooks are fixed to seller-app (port 4002); any offer
// published through onix-sellerapp becomes seller-app's own incoming
// request the moment a buyer inits against it, regardless of who actually
// published it.
//
// So instead of re-deriving the protocol flow, this app treats seller-app
// and buyer-app as what ARCHITECTURE.md §2 already says every real
// participant is: an independent platform with its own real REST API.
// Discovering small offers means asking buyer-app what IT has already
// discovered (the exact same proxy pattern buyer-app's own resolveOffer()
// already uses against seller-app — see buyer-app/server.js). Publishing
// the pooled block means asking seller-app to publish it through its own,
// already-working /api/publish — the pooled block then genuinely is one
// of seller-app's real catalog offers, tradeable by anyone on the network,
// settled through seller-app's existing, already-verified lifecycle.
//
// The only things invented here are the pooling/blending math and the
// disaggregation math once a real settlement comes back — never a new
// protocol shape.
const crypto = require("crypto");

const BUYER_APP_URL = process.env.BUYER_APP_URL || "http://localhost:4001";
const SELLER_APP_URL = process.env.SELLER_APP_URL || "http://localhost:4002";

function uuid() {
  return crypto.randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}

async function getJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    // Same graceful shape as seller-app/beckn.js and buyer-app/beckn.js's
    // own postToOnix() — the peer app being down (or not started yet) is
    // an entirely normal, expected state in this demo stack, not a crash.
    return { ok: false, status: 0, json: null, text: `network error reaching ${url}: ${err.message || err}` };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body, text kept below */ }
  return { ok: res.ok, status: res.status, json, text };
}

// Triggers a fresh real discover through buyer-app's own existing
// endpoint. buyer-app's own webhook handler populates ITS OWN
// discovered_offers table with whatever comes back — we read that next.
async function triggerDiscover() {
  return getJson(`${BUYER_APP_URL}/api/discover`, { method: "POST" });
}

// Real offers buyer-app has actually discovered on the shared network,
// right now — not a guess, not our own cache.
async function fetchDiscoveredOffers() {
  const r = await getJson(`${BUYER_APP_URL}/api/offers`);
  return r.ok ? r.json || [] : [];
}

// seller-app's own, authoritative, currently-live catalog. Found needed
// during live use: discover's seller_id field is the devkit's own generic
// tutorial identity ("sellerapp.example.com"), not a unique one -- plenty of
// real, unrelated testers on the shared sandbox never renamed it either, so
// "seller_id looks like ours" tells you nothing. buyer-app's own
// resolveOffer() already solved this the only real way: check the offer_id
// against seller-app's own live catalog directly. This app has to do the
// exact same real check, or "available to pool" silently includes real
// other people's real offers we have no right to repackage and sell.
async function fetchSellerOffers() {
  const r = await getJson(`${SELLER_APP_URL}/api/offers`);
  return r.ok ? r.json || [] : [];
}

// Publishes the pooled block through seller-app's own, already-working
// publish pipeline — real onix call, real signed message, real catalog
// entry. Returns seller-app's own response verbatim (includes the real
// offerId it assigned).
async function publishBlock({ quantityKwh, pricePerKwh }) {
  return getJson(`${SELLER_APP_URL}/api/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantityKwh, pricePerKwh }),
  });
}

// seller-app's own trades — used to find out, by real offerId match,
// whether the bulk buyer's trade against our published block has reached
// SETTLED yet, and if so, the real settlement amount seller-app's own
// linked rego policy actually computed.
async function fetchSellerTrades() {
  const r = await getJson(`${SELLER_APP_URL}/api/trades`);
  return r.ok ? r.json || [] : [];
}

module.exports = {
  BUYER_APP_URL,
  SELLER_APP_URL,
  uuid,
  nowIso,
  triggerDiscover,
  fetchDiscoveredOffers,
  fetchSellerOffers,
  publishBlock,
  fetchSellerTrades,
};

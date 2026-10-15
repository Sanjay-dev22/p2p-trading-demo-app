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
// So instead of re-deriving the discover flow, this app treats buyer-app as
// what ARCHITECTURE.md §2 already says every real participant is: an
// independent platform with its own real REST API. Discovering small
// offers means asking buyer-app what IT has already discovered (the exact
// same proxy pattern buyer-app's own resolveOffer() already uses against
// seller-app), and cross-checking candidates against seller-app's own live
// catalog the same way buyer-app's resolveOffer() does.
//
// Publishing the pooled block is DIFFERENT from the first version of this
// app: aggregation-v2 gives aggregator-app its own onix adapter instance
// (onix-aggregatorapp — see install/docker-compose.yml and beckn.js), so
// publishing/lifecycle now goes through this app's own beckn.js directly,
// not through seller-app's /api/publish. The pooled block is this app's
// own real catalog entry from the moment it's published — see
// KNOWLEDGE-BASE.md's aggregation-v2 section for the full why.
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

module.exports = {
  BUYER_APP_URL,
  SELLER_APP_URL,
  uuid,
  nowIso,
  triggerDiscover,
  fetchDiscoveredOffers,
  fetchSellerOffers,
};

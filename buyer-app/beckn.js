// Real Beckn message construction for the buyer side — mirrors
// seller-app/beckn.js's approach: every field shape here is copied from
// the devkit's own verified-working example fixtures
// (ies-devkit/devkits/p2p-trading-ies-wave2/uc1/examples/*.json).
const crypto = require("crypto");

const NETWORK_ID = "indiaenergystack.in/test-ies-p2p-trading-network";
const SELF_ID = "buyerapp.example.com";
const SELF_URI = "http://buyerapp.example.com:9000/bap/receiver";
const SELF_METER_ID = "TEST_METER_BUYER_001";
const SELF_CUST_ID = "TEST_CUST_BUYER_001";
const SELLER_ID = "sellerapp.example.com"; // the only seller in this demo — we run both sides
const SELLER_URI = "http://sellerapp.example.com:9000/bpp/receiver";
const SELLER_DISCOM_ID = "TEST_DISCOM_SELLER";
const POLICY_URL = "https://api.dedi.global/dedi/lookup/indiaenergystack.in/ies-rulesets/p2p-trading-ies-contractpolicy-common";
const POLICY_QUERY_PATH = "data.deg.contracts.p2p_trading";

// The two personas selectable in the buyer UI — one real, allowed discom
// and one deliberately outside the seller's allowlist, so the rejected
// path (DEMO-APP-PLAN.md §5 step 7) can be triggered live, for real.
const DISCOM_ALLOWED = "TEST_DISCOM_BUYER";
const DISCOM_BLOCKED = "TEST_OUTSIDE_DISCOM";

const ONIX_BUYER_BASE = process.env.ONIX_BUYER_URL || "http://localhost:8081";

const SCHEMA_CONTEXT = [
  "https://schema.nfh.global/EnergyTradeOffer/v2.0/context.jsonld",
  "https://schema.nfh.global/EnergyResource/v2.0/context.jsonld",
  "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld",
  "https://schema.nfh.global/DEGContract/v2.0/context.jsonld",
  "https://schema.nfh.global/BecknTimeSeries/v1.0/context.jsonld",
  "https://schema.nfh.global/DiscomLedgerProvider/v1.0/context.jsonld",
  "https://schema.nfh.global/SettlementTerm/v2.0/context.jsonld",
  "https://schema.nfh.global/RevenueFlow/v2.0/context.jsonld",
  "https://schema.nfh.global/PaymentAction/v2.0/context.jsonld",
];

function uuid() {
  return crypto.randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}

function buildAck(context) {
  return { context, message: { ack: { status: "ACK" } } };
}

async function postToOnix(pathSuffix, body) {
  const url = `${ONIX_BUYER_BASE}${pathSuffix}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* no body / non-JSON */
  }
  return { status: res.status, ok: res.ok, json };
}

function buildDiscover() {
  const transactionId = uuid();
  const messageId = uuid();
  const context = {
    networkId: NETWORK_ID,
    version: "2.0.0",
    action: "discover",
    bapId: SELF_ID,
    bapUri: SELF_URI,
    transactionId,
    messageId,
    timestamp: nowIso(),
    schemaContext: SCHEMA_CONTEXT,
  };
  const message = { intent: { filters: { type: "jsonpath", expression: '$.catalogs[*].offers[*] ? (@.offerAttributes."@type" == "EnergyTradeOffer")' } } };
  return { context, message };
}

// Buyer originates the whole contract object from scratch at init — this
// is the one message in the lifecycle we build without an "original" to
// clone, since nobody has sent us a contract yet.
function buildInit({ offerId, quantityKwh, pricePerKwh, buyerDiscomId }) {
  const transactionId = uuid();
  const messageId = uuid();
  const context = {
    networkId: NETWORK_ID,
    version: "2.0.0",
    action: "init",
    bapId: SELF_ID,
    bapUri: SELF_URI,
    bppId: SELLER_ID,
    bppUri: SELLER_URI,
    transactionId,
    messageId,
    timestamp: nowIso(),
    schemaContext: SCHEMA_CONTEXT,
  };
  const contract = {
    status: { code: "DRAFT" },
    commitments: [
      {
        id: "commitment-p2p-001",
        status: { descriptor: { code: "DRAFT" } },
        resources: [
          {
            id: "energy-resource-solar-001",
            descriptor: { name: "Solar energy slot (demo)" },
            quantity: { "@type": "Quantity", unitCode: "KWH", unitQuantity: quantityKwh },
            resourceAttributes: { "@context": "https://schema.nfh.global/EnergyResource/v2.0/context.jsonld", "@type": "EnergyResource", type: "SOLAR", id: "TEST_METER_SELLER_001" },
          },
        ],
        offer: { id: offerId, resourceIds: ["energy-resource-solar-001"] },
        commitmentAttributes: {
          "@context": "https://schema.nfh.global/BecknTimeSeries/v1.0/context.jsonld",
          "@type": "TimeSeries",
          intervalPeriod: { start: nowIso(), duration: "PT1H" },
          payloadDescriptors: [
            { objectType: "EVENT_PAYLOAD_DESCRIPTOR", payloadType: "PRICE_PER_KWH", currency: "INR", insertedBy: "sellerPlatform" },
            { objectType: "EVENT_PAYLOAD_DESCRIPTOR", payloadType: "AVAILABLE_QTY", units: "KWH", insertedBy: "sellerPlatform" },
            { objectType: "EVENT_PAYLOAD_DESCRIPTOR", payloadType: "REQUESTED_QTY", units: "KWH", insertedBy: "buyerPlatform" },
          ],
          // AVAILABLE_QTY is required here by the real linked policy even
          // at init — reuses the same quantity the buyer is requesting,
          // since this simplified single-field demo form doesn't track a
          // separately-known "originally available" figure.
          intervals: [{ id: 0, payloads: [{ type: "PRICE_PER_KWH", values: [pricePerKwh] }, { type: "AVAILABLE_QTY", values: [quantityKwh] }, { type: "REQUESTED_QTY", values: [quantityKwh] }] }],
        },
      },
    ],
    contractAttributes: {
      "@context": "https://schema.nfh.global/DEGContract/v2.0/context.jsonld",
      "@type": "DEGContract",
      roles: [
        { role: "buyerPlatform", participantId: SELF_ID },
        { role: "sellerPlatform", participantId: SELLER_ID },
        { role: "buyerDiscom", participantId: buyerDiscomId },
        { role: "sellerDiscom", participantId: SELLER_DISCOM_ID },
      ],
      policy: { url: POLICY_URL, queryPath: POLICY_QUERY_PATH },
    },
    participants: [
      { id: SELLER_ID, participantAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: "TEST_METER_SELLER_001", utilityCustomerId: "TEST_CUST_SELLER_001", platformUrl: "http://sellerapp.example.com:9000" } },
      { id: SELF_ID, participantAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: SELF_METER_ID, utilityCustomerId: SELF_CUST_ID, platformUrl: "http://buyerapp.example.com:9000" } },
      { id: buyerDiscomId, participantAttributes: { "@context": "https://schema.nfh.global/DiscomLedgerProvider/v1.0/context.jsonld", "@type": "DiscomLedgerProvider", discomId: "buyer-discom.example.com", discomUri: "http://buyer-discom.example.com:9000", ledgerId: "buyer-discom-ledger.example.com", ledgerUri: "http://buyer-discom-ledger.example.com:9000" } },
      { id: SELLER_DISCOM_ID, participantAttributes: { "@context": "https://schema.nfh.global/DiscomLedgerProvider/v1.0/context.jsonld", "@type": "DiscomLedgerProvider", discomId: "seller-discom.example.com", discomUri: "http://seller-discom.example.com:9000", ledgerId: "seller-discom-ledger.example.com", ledgerUri: "http://seller-discom-ledger.example.com:9000" } },
    ],
  };
  return { context, message: { contract } };
}

// confirm: reuses the contract exactly as the seller's on_init returned it
// (already includes the proposed settlement terms) — mirrors
// confirm-request.json, which keeps status DRAFT (only on_confirm flips it
// to ACTIVE).
function buildConfirm(originalCtx, originalContract) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  const context = { ...originalCtx, action: "confirm", messageId: uuid(), timestamp: nowIso() };
  return { context, message: { contract } };
}

function extractRevenueFlow(contract, role) {
  const flows = contract?.consideration?.[0]?.considerationAttributes?.revenueFlows || [];
  return flows.find((f) => f.role === role)?.value;
}

module.exports = {
  NETWORK_ID,
  SELF_ID,
  SELLER_ID,
  DISCOM_ALLOWED,
  DISCOM_BLOCKED,
  postToOnix,
  buildAck,
  buildDiscover,
  buildInit,
  buildConfirm,
  extractRevenueFlow,
  uuid,
  nowIso,
};

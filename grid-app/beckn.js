// Real Beckn message construction for the grid/DISCOM side — adapted from
// buyer-app/beckn.js. grid-app reuses buyerapp.example.com's already-
// registered signing identity (same keys, new onix instance/hostname — see
// Aggregation v2 Phase 2 in KNOWLEDGE-BASE.md §9) so it can execute a real,
// signed init -> confirm against whichever block fulfills its own posted
// requirement, instead of buyer-app doing it on its behalf.
const crypto = require("crypto");

const NETWORK_ID = "indiaenergystack.in/test-ies-p2p-trading-network";
const SELF_ID = "buyerapp.example.com";
const SELF_URI = "http://gridapp.example.com:9000/bap/receiver";
const SELF_METER_ID = "TEST_METER_GRID_001";
const SELF_CUST_ID = "TEST_CUST_GRID_001";
const SELLER_ID = "sellerapp.example.com"; // the shared signing identity behind seller-app AND aggregator-app
const SELLER_DISCOM_ID = "TEST_DISCOM_SELLER";
const POLICY_URL = "http://host.docker.internal:8099/p2p-trading-ies-wave2-contractpolicy-local-amended.rego";
const POLICY_QUERY_PATH = "data.deg.contracts.p2p_trading";

// grid-app always buys as a single persona — it isn't demoing the
// rejected-discom path the way buyer-app's UI does, so there is no
// blocked/allowed toggle here.
const DISCOM_ALLOWED = "TEST_DISCOM_BUYER";

const ONIX_GRID_BASE = process.env.ONIX_GRID_URL || "http://localhost:18085";

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
  const url = `${ONIX_GRID_BASE}${pathSuffix}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: 0, ok: false, json: null, text: `network error reaching ${url}: ${err.message || err}` };
  }
  const rawText = await res.text().catch(() => "");
  let json = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    /* body wasn't JSON — rawText kept below so nothing is lost */
  }
  return { status: res.status, ok: res.ok, json, text: rawText };
}

// Buyer (here: grid-app) originates the whole contract object from scratch
// at init. bppUri/bppId are always the block's real publisher — in this
// phase that's always aggregator-app's own catalog, reusing
// sellerapp.example.com's signing identity, but the parameters stay
// general rather than hardcoded.
function buildInit({ offerId, quantityKwh, pricePerKwh, bppId, bppUri }) {
  const transactionId = uuid();
  const messageId = uuid();
  const context = {
    networkId: NETWORK_ID,
    version: "2.0.0",
    action: "init",
    bapId: SELF_ID,
    bapUri: SELF_URI,
    bppId: bppId || SELLER_ID,
    bppUri,
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
            descriptor: { name: "Pooled energy block (demo)" },
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
          intervals: [{ id: 0, payloads: [{ type: "PRICE_PER_KWH", values: [pricePerKwh] }, { type: "AVAILABLE_QTY", values: [quantityKwh] }, { type: "REQUESTED_QTY", values: [quantityKwh] }] }],
        },
      },
    ],
    contractAttributes: {
      "@context": "https://schema.nfh.global/DEGContract/v2.0/context.jsonld",
      "@type": "DEGContract",
      roles: [
        { role: "buyerPlatform", participantId: SELF_ID },
        { role: "sellerPlatform", participantId: bppId || SELLER_ID },
        { role: "buyerDiscom", participantId: DISCOM_ALLOWED },
        { role: "sellerDiscom", participantId: SELLER_DISCOM_ID },
      ],
      policy: { url: POLICY_URL, queryPath: POLICY_QUERY_PATH },
    },
    participants: [
      { id: bppId || SELLER_ID, participantAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: "TEST_METER_SELLER_001", utilityCustomerId: "TEST_CUST_SELLER_001", platformUrl: "http://sellerapp.example.com:9000" } },
      { id: SELF_ID, participantAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: SELF_METER_ID, utilityCustomerId: SELF_CUST_ID, platformUrl: "http://gridapp.example.com:9000" } },
      { id: DISCOM_ALLOWED, participantAttributes: { "@context": "https://schema.nfh.global/DiscomLedgerProvider/v1.0/context.jsonld", "@type": "DiscomLedgerProvider", discomId: "buyer-discom.example.com", discomUri: "http://buyer-discom.example.com:9000", ledgerId: "buyer-discom-ledger.example.com", ledgerUri: "http://buyer-discom-ledger.example.com:9000" } },
      { id: SELLER_DISCOM_ID, participantAttributes: { "@context": "https://schema.nfh.global/DiscomLedgerProvider/v1.0/context.jsonld", "@type": "DiscomLedgerProvider", discomId: "seller-discom.example.com", discomUri: "http://seller-discom.example.com:9000", ledgerId: "seller-discom-ledger.example.com", ledgerUri: "http://seller-discom-ledger.example.com:9000" } },
    ],
  };
  return { context, message: { contract } };
}

// confirm: reuses the contract exactly as the seller's on_init returned it.
function buildConfirm(originalCtx, originalContract) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  const context = { ...originalCtx, action: "confirm", messageId: uuid(), timestamp: nowIso() };
  return { context, message: { contract } };
}

function extractRevenueFlow(contract, role) {
  const flows = contract?.consideration?.[0]?.considerationAttributes?.revenueFlows || [];
  return flows.find((f) => f.role === role)?.value;
}

function extractInterval0(contract) {
  const interval = contract?.commitments?.[0]?.commitmentAttributes?.intervals?.[0];
  const payloads = interval?.payloads || [];
  const find = (type) => payloads.find((p) => p.type === type)?.values?.[0];
  return { price: find("PRICE_PER_KWH"), qty: find("AVAILABLE_QTY") };
}

module.exports = {
  NETWORK_ID,
  SELF_ID,
  SELF_URI,
  SELLER_ID,
  DISCOM_ALLOWED,
  postToOnix,
  buildAck,
  buildInit,
  buildConfirm,
  extractRevenueFlow,
  extractInterval0,
  uuid,
  nowIso,
};

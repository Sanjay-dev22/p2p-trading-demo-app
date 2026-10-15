// Real Beckn message construction for the aggregator's own pooled block —
// adapted from seller-app/beckn.js (same proven field shapes, same schema
// validation passes against onix-aggregatorapp for the same reason). The
// one deliberate difference: SELF_ID stays "sellerapp.example.com" (the
// already-registered signing identity, reused — no new DeDi registration,
// see KNOWLEDGE-BASE.md's aggregation-v2 section) while SELF_URI points at
// this app's own onix instance (onix-aggregatorapp), not seller-app's. This
// is what makes the pooled block genuinely its own catalog entry/lifecycle
// instead of living inside seller-app's.
const crypto = require("crypto");

const NETWORK_ID = "indiaenergystack.in/test-ies-p2p-trading-network";
const SELF_ID = "sellerapp.example.com";
const SELF_URI = "http://aggregatorapp.example.com:9000/bpp/receiver";
const SELF_METER_ID = "TEST_METER_SELLER_001";
const SELF_CUST_ID = "TEST_CUST_SELLER_001";
const SELLER_DISCOM_ID = "TEST_DISCOM_SELLER";
const POLICY_URL = "http://host.docker.internal:8099/p2p-trading-ies-wave2-contractpolicy-local-amended.rego";
const POLICY_QUERY_PATH = "data.deg.contracts.p2p_trading";

// Same real external ledger seller-app's own beckn.js points at — see that
// file's comment for the full why. The aggregator's block settles through
// the identical real pipeline, so its trades land on the same real,
// independently-queryable ledger too.
const SELLER_LEDGER_ID = "ies-p2p-energy-ledger.beckn.io";
const SELLER_LEDGER_URI = "https://ies-p2p-energy-ledger.beckn.io";

function pointSellerDiscomAtRealLedger(contract) {
  const participants = contract?.participants || [];
  const sellerDiscom = participants.find((p) => p.id === SELLER_DISCOM_ID);
  if (sellerDiscom?.participantAttributes) {
    sellerDiscom.participantAttributes.ledgerId = SELLER_LEDGER_ID;
    sellerDiscom.participantAttributes.ledgerUri = SELLER_LEDGER_URI;
  }
  return contract;
}

// onix-aggregatorapp's own host-mapped port (see install/docker-compose.yml)
const ONIX_AGGREGATOR_BASE = process.env.ONIX_AGGREGATOR_URL || "http://localhost:18084";

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
  const url = `${ONIX_AGGREGATOR_BASE}${pathSuffix}`;
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
    /* body wasn't JSON — rawText itself is kept below so nothing is lost */
  }
  return { status: res.status, ok: res.ok, json, text: rawText };
}

// Publishes the pooled block as its own catalog entry — same shape as
// seller-app's buildPublishCatalog, descriptor clearly labeled as an
// aggregated block so it's visually distinguishable in discover results
// even though bppId is shared with the real seller.
function buildPublishCatalog({ offerId, quantityKwh, pricePerKwh, memberCount }) {
  const transactionId = uuid();
  const messageId = uuid();
  const context = {
    networkId: NETWORK_ID,
    version: "2.0.0",
    action: "catalog/publish",
    bppId: SELF_ID,
    bppUri: SELF_URI,
    transactionId,
    messageId,
    timestamp: nowIso(),
    schemaContext: SCHEMA_CONTEXT,
  };
  const catalogId = `catalog-p2p-energy-agg-${Date.now()}`;
  const message = {
    publishDirectives: [{ catalogId, catalogType: "REGULAR", updateMode: "MERGE", visibleTo: [NETWORK_ID] }],
    catalogs: [
      {
        id: catalogId,
        descriptor: { name: "Aggregated Energy Block (demo)", shortDesc: `Pooled block from ${memberCount} sellers — ${quantityKwh} kWh @ ₹${pricePerKwh}/kWh` },
        bppId: SELF_ID,
        bppUri: SELF_URI,
        provider: { id: SELF_ID, descriptor: { name: `Aggregator — ${memberCount} sellers pooled` } },
        resources: [
          {
            id: "energy-resource-solar-001",
            descriptor: { name: "Pooled solar energy block (demo)" },
            resourceAttributes: { "@context": "https://schema.nfh.global/EnergyResource/v2.0/context.jsonld", "@type": "EnergyResource", type: "SOLAR", id: SELF_METER_ID },
          },
        ],
        offers: [
          {
            id: offerId,
            descriptor: { name: "Aggregated Block", shortDesc: `₹${pricePerKwh}/kWh — pooled from ${memberCount} sellers` },
            resourceIds: ["energy-resource-solar-001"],
            availableTo: [],
            offerAttributes: {
              "@context": "https://schema.nfh.global/EnergyTradeOffer/v2.0/context.jsonld",
              "@type": "EnergyTradeOffer",
              contractAttributes: {
                "@context": "https://schema.nfh.global/DEGContract/v2.0/context.jsonld",
                "@type": "DEGContract",
                roles: [
                  { role: "buyerPlatform", participantId: null },
                  { role: "sellerPlatform", participantId: SELF_ID },
                  { role: "buyerDiscom", participantId: null },
                  { role: "sellerDiscom", participantId: SELLER_DISCOM_ID },
                ],
                policy: { url: POLICY_URL, queryPath: POLICY_QUERY_PATH },
              },
              participants: [
                { id: SELF_ID, participantAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: SELF_METER_ID, utilityCustomerId: SELF_CUST_ID, platformUrl: "http://aggregatorapp.example.com:9000" } },
                { id: SELLER_DISCOM_ID, participantAttributes: { "@context": "https://schema.nfh.global/DiscomLedgerProvider/v1.0/context.jsonld", "@type": "DiscomLedgerProvider", discomId: "seller-discom.example.com", discomUri: "http://seller-discom.example.com:9000", ledgerId: "seller-discom-ledger.example.com", ledgerUri: "http://seller-discom-ledger.example.com:9000" } },
              ],
              commitmentAttributes: {
                "@context": "https://schema.nfh.global/BecknTimeSeries/v1.0/context.jsonld",
                "@type": "TimeSeries",
                intervalPeriod: { start: nowIso(), duration: "PT1H" },
                payloadDescriptors: [
                  { objectType: "EVENT_PAYLOAD_DESCRIPTOR", payloadType: "PRICE_PER_KWH", currency: "INR", insertedBy: "sellerPlatform" },
                  { objectType: "EVENT_PAYLOAD_DESCRIPTOR", payloadType: "AVAILABLE_QTY", units: "KWH", insertedBy: "sellerPlatform" },
                  { objectType: "EVENT_PAYLOAD_DESCRIPTOR", payloadType: "REQUESTED_QTY", units: "KWH", insertedBy: "buyerPlatform" },
                  { objectType: "REPORT_PAYLOAD_DESCRIPTOR", payloadType: "FINAL_ALLOC", units: "KWH", insertedBy: "sellerDiscom" },
                ],
                intervals: [{ id: 0, payloads: [{ type: "PRICE_PER_KWH", values: [pricePerKwh] }, { type: "AVAILABLE_QTY", values: [quantityKwh] }] }],
              },
            },
            provider: {
              id: SELF_ID,
              descriptor: { name: `Aggregator — ${memberCount} sellers pooled` },
              providerAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: SELF_METER_ID, utilityCustomerId: SELF_CUST_ID },
            },
          },
        ],
      },
    ],
  };
  return { context, message };
}

// on_init — identical shape to seller-app's plain-accept path (no
// counter-offer feature here: the block's price was already fixed and
// reviewed at pooling/publish time, so there's no further negotiation to
// model for this demo — a disclosed simplification, see /api/about).
function buildOnInit(originalCtx, originalContract) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  pointSellerDiscomAtRealLedger(contract);
  contract.status = { code: "DRAFT" };
  contract.commitments[0].status = { descriptor: { code: "DRAFT" } };
  contract.settlements = [
    {
      id: "settlement-p2p-001",
      status: "DRAFT",
      settlementAttributes: {
        "@context": "https://schema.nfh.global/SettlementTerm/v2.0/context.jsonld",
        "@type": "SettlementTerm",
        payTo: { accountHolderName: "Aggregator Platform Pvt Ltd", accountNumber: "0012345678999", branchCode: "HDFC0001234", bankName: "HDFC Bank" },
        acceptedPaymentMethods: ["BANK_TRANSFER"],
        paymentTrigger: "ON_FULFILLMENT",
        settlementStatus: "PENDING",
      },
    },
  ];
  const context = { ...originalCtx, action: "on_init", messageId: uuid(), timestamp: nowIso() };
  return { context, message: { contract } };
}

function buildOnConfirm(originalCtx, originalContract) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  pointSellerDiscomAtRealLedger(contract);
  contract.status = { code: "ACTIVE" };
  contract.commitments[0].status = { descriptor: { code: "ACTIVE" } };
  contract.id = "contract-p2p-agg-001";
  if (contract.settlements && contract.settlements[0]) {
    contract.settlements[0].status = "COMMITTED";
  }
  const context = { ...originalCtx, action: "on_confirm", messageId: uuid(), timestamp: nowIso() };
  return { context, message: { contract } };
}

// on_status (settled) — identical math/shape to seller-app's own, since
// it's settling against the exact same real linked policy.
function buildOnStatusSettled(originalCtx, originalContract, { finalAlloc, pricePerKwh, requestedQty, settlementAmount, shortfallKwh, wheelingSeller, penalty, txnRef }) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  pointSellerDiscomAtRealLedger(contract);
  contract.status = { code: "COMPLETE" };
  contract.commitments[0].status = { descriptor: { code: "CLOSED" } };
  const interval0 = contract.commitments[0].commitmentAttributes.intervals[0];
  interval0.payloads = interval0.payloads.filter((p) => p.type !== "FINAL_ALLOC");
  interval0.payloads.push({ type: "FINAL_ALLOC", values: [finalAlloc] });
  const descriptors = contract.commitments[0].commitmentAttributes.payloadDescriptors;
  if (!descriptors.some((d) => d.payloadType === "FINAL_ALLOC")) {
    descriptors.push({ objectType: "REPORT_PAYLOAD_DESCRIPTOR", payloadType: "FINAL_ALLOC", units: "KWH", insertedBy: "sellerDiscom" });
  }

  const tradeValue = Math.round(finalAlloc * pricePerKwh * 100) / 100;
  const wheelingBuyer = Math.round(finalAlloc * 0.5 * 100) / 100;
  const buyerPayable = Math.round((tradeValue + wheelingBuyer) * 100) / 100;
  contract.consideration = [
    {
      id: "auto-settlement-flows",
      considerationAttributes: {
        "@context": "https://schema.nfh.global/RevenueFlow/v2.0/context.jsonld",
        "@type": "RevenueFlow",
        revenueFlows: [
          { role: "sellerPlatform", value: settlementAmount, currency: "INR", description: `Receives ${settlementAmount} INR = energy ${tradeValue} INR − seller-side wheeling 0.5 INR/kWh × ${finalAlloc} kWh = ${wheelingSeller} INR − delivery penalty 2.5 INR/kWh × ${shortfallKwh} kWh shortfall = ${penalty} INR` },
          { role: "buyerPlatform", value: -buyerPayable, currency: "INR", description: `Pays ${buyerPayable} INR = energy ${tradeValue} INR + buyer-side wheeling 0.5 INR/kWh × ${finalAlloc} kWh = ${wheelingBuyer} INR` },
          { role: "buyerDiscom", value: wheelingBuyer, currency: "INR", description: `Buyer-side wheeling charge = ${wheelingBuyer} INR` },
          { role: "sellerDiscom", value: Math.round((wheelingSeller + penalty) * 100) / 100, currency: "INR", description: `Seller-side wheeling ${wheelingSeller} INR + delivery penalty ${penalty} INR` },
        ],
      },
    },
  ];
  if (contract.settlements && contract.settlements[0]) {
    contract.settlements[0].status = "COMPLETE";
    contract.settlements[0].considerationId = "auto-settlement-flows";
    contract.settlements[0].settlementAttributes.settlementStatus = "COMPLETE";
  }
  contract.settlements = contract.settlements || [];
  contract.settlements.push({
    id: "payment-p2p-001",
    considerationId: "auto-settlement-flows",
    status: "COMPLETE",
    settlementAttributes: {
      "@context": "https://schema.nfh.global/PaymentAction/v2.0/context.jsonld",
      "@type": "PaymentAction",
      amount: { currency: "INR", value: settlementAmount },
      paymentMethod: { method: "BANK_TRANSFER" },
      paymentStatus: "SETTLED",
      txnRef,
      paidAt: nowIso(),
    },
  });

  const context = { ...originalCtx, action: "on_status", messageId: uuid(), timestamp: nowIso() };
  return { context, message: { contract } };
}

function extractBuyerDiscom(contract) {
  const roles = contract?.contractAttributes?.roles || [];
  const row = roles.find((r) => r.role === "buyerDiscom");
  return row ? row.participantId : "unknown";
}

function extractInterval0(contract) {
  const interval = contract?.commitments?.[0]?.commitmentAttributes?.intervals?.[0];
  const payloads = interval?.payloads || [];
  const find = (type) => payloads.find((p) => p.type === type)?.values?.[0];
  return { price: find("PRICE_PER_KWH"), requestedQty: find("REQUESTED_QTY") };
}

module.exports = {
  NETWORK_ID,
  SELF_ID,
  SELF_URI,
  postToOnix,
  buildAck,
  buildPublishCatalog,
  buildOnInit,
  buildOnConfirm,
  buildOnStatusSettled,
  extractBuyerDiscom,
  extractInterval0,
  uuid,
  nowIso,
};

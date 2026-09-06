// Real Beckn message construction for the seller side — every field shape
// here is copied from the devkit's own verified-working example fixtures
// (ies-devkit/devkits/p2p-trading-ies-wave2/uc1/examples/*.json), not
// invented, so real schema validation on onix-sellerapp passes. Only the
// per-trade values (price, quantity, buyer discom, ids, timestamps,
// FINAL_ALLOC) are dynamic.
const crypto = require("crypto");

const NETWORK_ID = "indiaenergystack.in/test-ies-p2p-trading-network";
const SELF_ID = "sellerapp.example.com";
const SELF_URI = "http://sellerapp.example.com:9000/bpp/receiver";
const SELF_METER_ID = "TEST_METER_SELLER_001";
const SELF_CUST_ID = "TEST_CUST_SELLER_001";
const SELLER_DISCOM_ID = "TEST_DISCOM_SELLER";
const POLICY_URL = "https://api.dedi.global/dedi/lookup/indiaenergystack.in/ies-rulesets/p2p-trading-ies-contractpolicy-common";
const POLICY_QUERY_PATH = "data.deg.contracts.p2p_trading";

const ONIX_SELLER_BASE = process.env.ONIX_SELLER_URL || "http://localhost:8082";

// Union of every schemaContext URL seen across the real example fixtures —
// safe to always send the full set (extra, unused context URLs don't
// invalidate a message; the schema validator only checks what's present).
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

// Standard Beckn ACK, echoing context back — mirrors the sandbox stub's
// own buildAck(context) behaviour (confirmed via sandbox-ack-status-route.js,
// which patches the stock sandbox to `res.status(200).json(buildAck(context))`).
function buildAck(context) {
  return { context, message: { ack: { status: "ACK" } } };
}

async function postToOnix(pathSuffix, body) {
  const url = `${ONIX_SELLER_BASE}${pathSuffix}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* no body / non-JSON — fine, we still have res.status */
  }
  return { status: res.status, ok: res.ok, json };
}

// Builds a fresh catalog/publish message from a seller's own form input.
function buildPublishCatalog({ offerId, quantityKwh, pricePerKwh }) {
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
  const message = {
    publishDirectives: [{ catalogId: `catalog-p2p-energy-${Date.now()}`, catalogType: "REGULAR", updateMode: "MERGE", visibleTo: [NETWORK_ID] }],
    catalogs: [
      {
        id: `catalog-p2p-energy-${Date.now()}`,
        descriptor: { name: "P2P Solar Energy (demo)", shortDesc: `Rooftop solar offer — ${quantityKwh} kWh @ ₹${pricePerKwh}/kWh` },
        bppId: SELF_ID,
        bppUri: "http://sellerapp.example.com/bpp/receiver",
        provider: { id: SELF_ID, descriptor: { name: "Demo Prosumer Solar Farm" } },
        resources: [
          {
            id: "energy-resource-solar-001",
            descriptor: { name: "Solar energy slot (demo)" },
            resourceAttributes: { "@context": "https://schema.nfh.global/EnergyResource/v2.0/context.jsonld", "@type": "EnergyResource", type: "SOLAR", id: SELF_METER_ID },
          },
        ],
        offers: [
          {
            id: offerId,
            descriptor: { name: "Demo Solar Offer", shortDesc: `₹${pricePerKwh}/kWh` },
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
                { id: SELF_ID, participantAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: SELF_METER_ID, utilityCustomerId: SELF_CUST_ID, platformUrl: "http://sellerapp.example.com:9000" } },
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
              descriptor: { name: "Demo Prosumer Solar Farm" },
              providerAttributes: { "@context": "https://schema.nfh.global/EnergyCustomer/v2.0/context.jsonld", "@type": "EnergyCustomer", meterId: SELF_METER_ID, utilityCustomerId: SELF_CUST_ID },
            },
          },
        ],
      },
    ],
  };
  return { context, message };
}

// on_init: reply to an incoming init, reusing the buyer's own contract
// object verbatim (it already passed real schema validation to reach us)
// and adding the seller's proposed settlement terms, exactly mirroring
// on-init-response.json.
function buildOnInit(originalCtx, originalContract) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  contract.status = { code: "DRAFT" };
  contract.commitments[0].status = { descriptor: { code: "DRAFT" } };
  contract.settlements = [
    {
      id: "settlement-p2p-001",
      status: "DRAFT",
      settlementAttributes: {
        "@context": "https://schema.nfh.global/SettlementTerm/v2.0/context.jsonld",
        "@type": "SettlementTerm",
        payTo: { accountHolderName: "Seller Platform Pvt Ltd", accountNumber: "0012345678901", branchCode: "HDFC0001234", bankName: "HDFC Bank" },
        acceptedPaymentMethods: ["BANK_TRANSFER"],
        paymentTrigger: "ON_FULFILLMENT",
        settlementStatus: "PENDING",
      },
    },
  ];
  const context = { ...originalCtx, action: "on_init", messageId: uuid(), timestamp: nowIso() };
  return { context, message: { contract } };
}

// on_confirm: the trade goes ACTIVE. Mirrors on-confirm-response.json.
function buildOnConfirm(originalCtx, originalContract) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  contract.status = { code: "ACTIVE" };
  contract.commitments[0].status = { descriptor: { code: "ACTIVE" } };
  contract.id = "contract-p2p-001";
  if (contract.settlements && contract.settlements[0]) {
    contract.settlements[0].status = "COMMITTED";
  }
  const context = { ...originalCtx, action: "on_confirm", messageId: uuid(), timestamp: nowIso() };
  return { context, message: { contract } };
}

// on_status (settled): delivery is reported. Mirrors
// on-status-response-settled.json — FINAL_ALLOC is appended to interval 0,
// consideration/revenueFlows and the final settlement/payment records are
// added. settlementAmount is computed by the caller (finalAlloc × price)
// using the same formula the real linked .rego policy evaluates.
function buildOnStatusSettled(originalCtx, originalContract, { finalAlloc, pricePerKwh, settlementAmount, txnRef }) {
  const contract = JSON.parse(JSON.stringify(originalContract));
  contract.status = { code: "COMPLETE" };
  contract.commitments[0].status = { descriptor: { code: "CLOSED" } };
  const interval0 = contract.commitments[0].commitmentAttributes.intervals[0];
  interval0.payloads = interval0.payloads.filter((p) => p.type !== "FINAL_ALLOC");
  interval0.payloads.push({ type: "FINAL_ALLOC", values: [finalAlloc] });
  // The real linked policy requires every payload type used in an
  // interval to also be declared in payloadDescriptors (verified live —
  // this exact omission was caught by a real 400 from onix-sellerapp).
  const descriptors = contract.commitments[0].commitmentAttributes.payloadDescriptors;
  if (!descriptors.some((d) => d.payloadType === "FINAL_ALLOC")) {
    descriptors.push({ objectType: "REPORT_PAYLOAD_DESCRIPTOR", payloadType: "FINAL_ALLOC", units: "KWH", insertedBy: "sellerDiscom" });
  }

  contract.consideration = [
    {
      id: "auto-settlement-flows",
      considerationAttributes: {
        "@context": "https://schema.nfh.global/RevenueFlow/v2.0/context.jsonld",
        "@type": "RevenueFlow",
        revenueFlows: [
          { role: "sellerPlatform", value: settlementAmount, currency: "INR", description: `Energy sale proceeds (${finalAlloc} kWh × ₹${pricePerKwh})` },
          { role: "buyerPlatform", value: -settlementAmount, currency: "INR", description: `Energy purchase cost (${finalAlloc} kWh × ₹${pricePerKwh})` },
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

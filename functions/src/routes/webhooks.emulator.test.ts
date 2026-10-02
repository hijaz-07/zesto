// @vitest-environment node
import {createHmac, randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {createMenuItem} from "../domain/menuItems";
import {archiveMenu, createMenu, publishMenu} from "../domain/menus";
import {createOrder, type Order} from "../domain/orders";
import {createOrganization} from "../domain/organizations";
import {createOutlet} from "../domain/outlets";
import {ensureProviderOrder, preparePayment} from "../domain/payments";
import {deriveWebhookEventIdentity, WEBHOOK_EVENTS_COLLECTION} from "../domain/razorpayWebhooks";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createWebhookRoutes} from "./webhooks";

/**
 * The webhook route against a REAL Firestore emulator: real signature
 * verification over the raw bytes, real event claims, the real collection-
 * group payment lookup, and the real trusted payment transitions. Complements
 * `webhooks.test.ts` (paths that need no Firestore) and
 * `domain/razorpayWebhooks.emulator.test.ts` (the full state-machine matrix).
 * The Razorpay API is never called.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

const PROJECT_ID = "demo-zesto-functions-test";
const WEBHOOK_SECRET = "test_webhook_secret_route_emulator";
const KEY_SECRET = "test_key_secret_route_emulator";

let db: Firestore;

vi.setConfig({testTimeout: 30000});

beforeEach(() => {
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("RAZORPAY_KEY_SECRET", KEY_SECRET);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await archiveFixtureMenus();
});

// Every menu this file publishes (see `setupRazorpayPayment`). Left alone,
// each test's menu stays published and open in the shared emulator for good,
// and the global Explore feed (`explore.emulator.test.ts`, capped at 50
// outlets) ends up crowded out by leftovers from other files.
const publishedFixtureMenus: Array<{organizationId: string; outletId: string; menuId: string}> = [];

/**
 * Archives, through the normal `archiveMenu` lifecycle, every menu this file
 * has published since the last call. Runs from `afterEach`, so it also runs
 * when a test's assertions fail. Only "already archived / not there" is
 * tolerated (a test may have archived its own menu); any other error is
 * rethrown after every menu was attempted, so a cleanup that fails cannot
 * silently reintroduce the leak.
 */
async function archiveFixtureMenus(): Promise<void> {
  let firstError: unknown;
  for (const {organizationId, outletId, menuId} of publishedFixtureMenus.splice(0)) {
    try {
      await archiveMenu(db, organizationId, outletId, menuId);
    } catch (error) {
      const alreadyGone = error instanceof HttpsError &&
        (error.code === "failed-precondition" || error.code === "not-found");
      if (!alreadyGone && firstError === undefined) {
        firstError = error;
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this file via " +
      "`npm run test:functions-emulator` (from the repo root), which " +
      "starts the Firestore emulator first.",
    );
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

interface Fixture {
  order: Order;
  providerOrderId: string;
  amountInPaise: number;
}

async function setupRazorpayPayment(priceInPaise = 12000): Promise<Fixture> {
  const ownerId = `U-${randomUUID()}`;
  const {organization} = await createOrganization(db, ownerId, {
    name: `Canteen ${randomUUID()}`, slug: `canteen-${randomUUID()}`,
  });
  const outlet = await createOutlet(db, organization.id, ownerId, {
    name: `Counter ${randomUUID()}`, slug: `counter-${randomUUID()}`,
  });
  const now = Date.now();
  const menu = await createMenu(db, organization.id, outlet.id, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 3600_000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 3600_000)),
    pickupStartsAt: Timestamp.fromDate(new Date(now + 24 * 3600_000)),
    pickupEndsAt: Timestamp.fromDate(new Date(now + 28 * 3600_000)),
  });
  const item = await createMenuItem(db, organization.id, outlet.id, menu.id, ownerId, {
    name: `Item ${randomUUID()}`, description: "Test item.", priceInPaise, displayOrder: 1,
  });
  await publishMenu(db, organization.id, outlet.id, menu.id);
  publishedFixtureMenus.push({organizationId: organization.id, outletId: outlet.id, menuId: menu.id});
  const customerId = `U-${randomUUID()}`;
  const {order} = await createOrder(db, customerId, {
    outletId: outlet.id, menuId: menu.id, items: [{itemId: item.id, quantity: 1}], idempotencyKey: `key-${randomUUID()}`,
  });
  await preparePayment(db, customerId, order.id);
  const providerOrderId = `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  await ensureProviderOrder(db, order.id, order.id, {
    createOrder: async (input) => ({
      id: providerOrderId, amountInPaise: input.amountInPaise, currency: input.currency, receipt: input.receipt, status: "created",
    }),
    fetchOrder: async (id) => ({id, amountInPaise: 0, currency: "INR", status: "created"}),
  });
  return {order, providerOrderId, amountInPaise: order.totalInPaise};
}

function orderRef(order: Order) {
  return db.doc(`organizations/${order.organizationId}/outlets/${order.outletId}/menus/${order.menuId}/orders/${order.id}`);
}

async function readState(order: Order) {
  const [orderSnap, paymentSnap] = await Promise.all([
    orderRef(order).get(), orderRef(order).collection("payments").doc(order.id).get(),
  ]);
  return {order: orderSnap.data() ?? {}, payment: paymentSnap.data() ?? {}};
}

/** Razorpay-style body, deliberately formatted the way JSON.stringify never
 * would (indentation, a trailing newline, an escaped non-ASCII character) so
 * a pass proves the signature was checked against the raw bytes. */
function prettyBody(type: "payment.captured" | "payment.failed", options: {
  providerOrderId: string; amount: number; paymentId?: string; currency?: string;
}): string {
  const status = type === "payment.failed" ? "failed" : "captured";
  return [
    "{",
    "  \"entity\": \"event\",",
    `  "event": "${type}",`,
    "  \"payload\": {",
    "    \"payment\": {",
    "      \"entity\": {",
    `        "id": "${options.paymentId ?? "pay_RouteTest1"}",`,
    `        "amount": ${options.amount},`,
    `        "currency": "${options.currency ?? "INR"}",`,
    `        "status": "${status}",`,
    `        "order_id": "${options.providerOrderId}",`,
    "        \"description\": \"caf\\u00e9 order\",",
    "        \"email\": \"customer@example.com\"",
    "      }",
    "    }",
    "  },",
    "  \"created_at\": 1567674606",
    "}",
    "",
  ].join("\n");
}

function sign(raw: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function send(
  raw: string,
  options: {eventId?: string; signature?: string; database?: Firestore} = {},
): Promise<ApiResult> {
  const headers: NormalizedRequest["headers"] = {"x-razorpay-signature": options.signature ?? sign(raw)};
  if (options.eventId) {
    headers["x-razorpay-event-id"] = options.eventId;
  }
  // No Authorization header, anywhere in this file: the webhook needs none.
  const request: NormalizedRequest = {
    method: "POST", path: "/webhooks/razorpay", headers, query: {}, body: undefined, rawBody: Buffer.from(raw, "utf8"),
  };
  return handleRequest(createWebhookRoutes({db: options.database ?? db}), request, () => {});
}

describe("POST /webhooks/razorpay (Firestore emulator)", () => {
  it("accepts a signed payment.captured delivery, with no Descope session, and confirms the order", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise, paymentId: "pay_RouteCaptured"});

    const result = await send(raw, {eventId: newEventId()});

    expect(result).toMatchObject({kind: "success", status: 200, data: {received: true, outcome: "payment_succeeded"}});
    const state = await readState(order);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: "pay_RouteCaptured"});
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
  });

  it("accepts a signed payment.failed delivery: payment failed, order still pending_payment", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.failed", {providerOrderId, amount: amountInPaise, paymentId: "pay_RouteFailed"});

    const result = await send(raw, {eventId: newEventId()});

    expect(result).toMatchObject({kind: "success", status: 200, data: {outcome: "payment_marked_failed"}});
    const state = await readState(order);
    expect(state.payment).toMatchObject({status: "failed", providerPaymentId: "pay_RouteFailed"});
    expect(state.order).toMatchObject({status: "pending_payment", paymentStatus: "pending"});
  });

  it("acknowledges a duplicate delivery with a 2xx and changes nothing", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise});
    const eventId = newEventId();
    await send(raw, {eventId});
    const afterFirst = await readState(order);

    const second = await send(raw, {eventId});

    expect(second).toMatchObject({kind: "success", status: 200, data: {received: true, outcome: "duplicate"}});
    expect(await readState(order)).toEqual(afterFirst);
  });

  it("concurrent deliveries of one event: one processes it, the rest are 2xx duplicates or a retryable 409 — never a 5xx", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise});
    const eventId = newEventId();

    const results = await Promise.all(Array.from({length: 8}, () => send(raw, {eventId})));

    const processed = results.filter((r) => r.kind === "success" && (r.data as {outcome: string}).outcome === "payment_succeeded");
    expect(processed).toHaveLength(1);
    for (const result of results) {
      expect([200, 409]).toContain(result.status);
    }
    expect((await readState(order)).order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
  });

  it("rejects an invalid signature (401): no state change and NOTHING is recorded", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise});
    const eventId = newEventId();
    const before = await readState(order);

    const result = await send(raw, {eventId, signature: sign(raw, "not-the-webhook-secret")});

    expect(result).toMatchObject({kind: "error", status: 401, code: "invalid_signature"});
    expect(await readState(order)).toEqual(before);
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get()).exists).toBe(false);
    const fingerprintKey = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: Buffer.from(raw)}).eventKey;
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(fingerprintKey).get()).exists).toBe(false);
  });

  it("rejects a body altered after signing (401): the signed amount can't be swapped", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const signedRaw = prettyBody("payment.captured", {providerOrderId, amount: 1});
    const tamperedRaw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise});
    const before = await readState(order);

    const result = await send(tamperedRaw, {signature: sign(signedRaw)});

    expect(result).toMatchObject({kind: "error", status: 401});
    expect(await readState(order)).toEqual(before);
  });

  it("rejects a signed but malformed payload (400) without recording it", async () => {
    const raw = "{ \"event\": \"payment.captured\", \"payload\": {} }\n";
    const key = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: Buffer.from(raw)}).eventKey;

    const result = await send(raw);

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(key).get()).exists).toBe(false);
  });

  it("acknowledges a valid but unsupported event with a 2xx and records nothing", async () => {
    const {providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise}).replace("payment.captured", "order.paid");
    const eventId = newEventId();

    const result = await send(raw, {eventId});

    expect(result).toMatchObject({kind: "success", status: 200, data: {outcome: "ignored_unknown_event"}});
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get()).exists).toBe(false);
  });

  it("acknowledges (2xx) an amount mismatch without confirming — retrying can't fix it", async () => {
    const {order, providerOrderId} = await setupRazorpayPayment();
    const before = await readState(order);

    const result = await send(prettyBody("payment.captured", {providerOrderId, amount: 99}), {eventId: newEventId()});

    expect(result).toMatchObject({kind: "success", status: 200, data: {outcome: "rejected_amount_mismatch"}});
    expect(await readState(order)).toEqual(before);
  });

  it("acknowledges (2xx) an event for a provider order Zesto doesn't know", async () => {
    const raw = prettyBody("payment.captured", {providerOrderId: "order_NotOurs000000", amount: 12000});

    const result = await send(raw, {eventId: newEventId()});

    expect(result).toMatchObject({kind: "success", status: 200, data: {outcome: "ignored_unrecognized_payment"}});
  });

  it("answers 409 (retryable, not 2xx) when the same event ID arrives with a different body", async () => {
    const first = await setupRazorpayPayment();
    const second = await setupRazorpayPayment();
    const eventId = newEventId();
    await send(prettyBody("payment.captured", {providerOrderId: first.providerOrderId, amount: first.amountInPaise}), {eventId});

    const result = await send(prettyBody("payment.captured", {providerOrderId: second.providerOrderId, amount: second.amountInPaise}), {eventId});

    expect(result).toMatchObject({kind: "error", status: 409, code: "event_id_conflict"});
    expect((await readState(second.order)).payment.status).toBe("pending");
  });

  it("answers a transient Firestore failure with a generic 500 (so Razorpay retries), then succeeds on redelivery", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise});
    const eventId = newEventId();
    const flaky = new Proxy(db, {
      get(target, property) {
        if (property === "collectionGroup") {
          return () => {
            throw new Error("transient Firestore failure with internal detail");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const failed = await send(raw, {eventId, database: flaky});

    expect(failed).toMatchObject({kind: "error", status: 500, code: "internal", message: "An unexpected error occurred."});
    expect(JSON.stringify(failed)).not.toContain("internal detail");
    expect((await readState(order)).payment.status).toBe("pending");

    const retried = await send(raw, {eventId});
    expect(retried).toMatchObject({kind: "success", status: 200, data: {outcome: "payment_succeeded"}});
  });

  it("never leaks a secret, the signature, or webhook content in a response or its log context", async () => {
    const {providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const raw = prettyBody("payment.captured", {providerOrderId, amount: amountInPaise, paymentId: "pay_Leak1"});
    const signature = sign(raw);

    const results = [
      await send(raw, {eventId: newEventId()}),
      await send(raw, {eventId: newEventId()}),
      await send(raw, {signature: "0".repeat(64)}),
    ];

    for (const result of results) {
      const serialized = JSON.stringify(result);
      for (const forbidden of [WEBHOOK_SECRET, KEY_SECRET, signature, "customer@example.com", "caf"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    // The log context carries identifiers and outcomes only.
    expect(results[0].logContext).toMatchObject({eventType: "payment.captured", providerOrderId, providerPaymentId: "pay_Leak1"});
  });
});

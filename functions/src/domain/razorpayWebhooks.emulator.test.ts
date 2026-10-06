// @vitest-environment node
import {createHmac, randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {createMenuItem, type CreateMenuItemInput} from "./menuItems";
import {archiveMenu, createMenu, publishMenu, type Menu} from "./menus";
import {createOrder, type Order} from "./orders";
import {createOrganization} from "./organizations";
import {createOutlet} from "./outlets";
import {ensureProviderOrder, preparePayment, verifyCheckoutPayment} from "./payments";
import {
  claimWebhookEvent,
  deriveWebhookEventIdentity,
  receiveRazorpayWebhook,
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_EVENTS_COLLECTION,
  type ReceiveWebhookResult,
} from "./razorpayWebhooks";
import type {CreateProviderOrderInput, PaymentProviderGateway} from "../providers/razorpay";
import {businessDateString} from "../time";

/**
 * Webhook reconciliation against a REAL Firestore emulator: real claim
 * transactions, the real collection-group payment lookup, and the real
 * trusted payment transitions. Signature verification is the route's job
 * (`routes/webhooks*.test.ts`); everything here starts from an already
 * authenticated raw body, exactly as `receiveRazorpayWebhook` does.
 *
 * The Razorpay API is never called: provider orders come from a fake
 * `PaymentProviderGateway`, as in `payments.emulator.test.ts`.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

const PROJECT_ID = "demo-zesto-functions-test";
const KEY_SECRET = "test_key_secret_for_verify";

let db: Firestore;

vi.setConfig({testTimeout: 30000});

beforeEach(() => {
  // Only the browser-verification race tests below read the API key secret.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

function freshItemInput(overrides: Partial<CreateMenuItemInput> = {}): CreateMenuItemInput {
  return {name: `Item ${randomUUID()}`, description: "Test item.", priceInPaise: 12000, displayOrder: 1, ...overrides};
}

async function createDraftMenu(organizationId: string, outletId: string, ownerId: string): Promise<Menu> {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  return createMenu(db, organizationId, outletId, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 60 * 60 * 1000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 60 * 60 * 1000)),
    pickupStartsAt: Timestamp.fromDate(new Date(tomorrow)),
    pickupEndsAt: Timestamp.fromDate(new Date(tomorrow + 4 * 60 * 60 * 1000)),
  });
}

interface Fixture {
  order: Order;
  customerId: string;
  providerOrderId: string;
  amountInPaise: number;
}

/** A real, published-menu `pending_payment` order with a prepared payment
 * that already has a (fake-gateway) Razorpay order — i.e. exactly the state
 * a customer's payment is in when Razorpay can first send events for it. */
async function setupRazorpayPayment(priceInPaise = 12000): Promise<Fixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, {
    name: `Canteen ${randomUUID()}`, slug: `canteen-${randomUUID()}`,
  });
  const outlet = await createOutlet(db, organization.id, ownerId, {
    name: `Counter ${randomUUID()}`, slug: `counter-${randomUUID()}`,
  });
  const menu = await createDraftMenu(organization.id, outlet.id, ownerId);
  const item = await createMenuItem(db, organization.id, outlet.id, menu.id, ownerId, freshItemInput({priceInPaise}));
  await publishMenu(db, organization.id, outlet.id, menu.id);
  publishedFixtureMenus.push({organizationId: organization.id, outletId: outlet.id, menuId: menu.id});
  const customerId = freshUserId();
  const {order} = await createOrder(db, customerId, {
    outletId: outlet.id, menuId: menu.id, items: [{itemId: item.id, quantity: 1}], idempotencyKey: `key-${randomUUID()}`,
  });

  await preparePayment(db, customerId, order.id);
  const providerOrderId = `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const gateway: PaymentProviderGateway = {
    createOrder: async (input: CreateProviderOrderInput) => ({
      id: providerOrderId, amountInPaise: input.amountInPaise, currency: input.currency, receipt: input.receipt, status: "created",
    }),
    fetchOrder: async (id: string) => ({id, amountInPaise: 0, currency: "INR", status: "created"}),
  };
  await ensureProviderOrder(db, order.id, order.id, gateway);
  return {order, customerId, providerOrderId, amountInPaise: order.totalInPaise};
}

function orderRef(order: Order) {
  return db.doc(`organizations/${order.organizationId}/outlets/${order.outletId}/menus/${order.menuId}/orders/${order.id}`);
}

async function readState(order: Order) {
  const [orderSnap, paymentSnap] = await Promise.all([
    orderRef(order).get(),
    orderRef(order).collection("payments").doc(order.id).get(),
  ]);
  return {order: orderSnap.data() ?? {}, payment: paymentSnap.data() ?? {}};
}

interface EventOptions {
  type?: "payment.captured" | "payment.failed";
  paymentId?: string;
  providerOrderId: string | null;
  amount?: number;
  currency?: string;
  status?: string;
}

/** The raw bytes of a realistic Razorpay webhook body (extra fields included
 * on purpose — reconciliation must never depend on, store, or log them). */
function eventBody(options: EventOptions): Buffer {
  const type = options.type ?? "payment.captured";
  return Buffer.from(JSON.stringify({
    entity: "event",
    account_id: "acc_TestAccount",
    event: type,
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: options.paymentId ?? "pay_Default1",
          entity: "payment",
          amount: options.amount ?? 12000,
          currency: options.currency ?? "INR",
          status: options.status ?? (type === "payment.failed" ? "failed" : "captured"),
          order_id: options.providerOrderId,
          method: "card",
          email: "customer@example.com",
          contact: "+911234567890",
          card: {last4: "5449"},
        },
      },
    },
    created_at: 1567674606,
  }), "utf8");
}

function deliver(rawBody: Buffer, eventId?: string, now?: Timestamp): Promise<ReceiveWebhookResult> {
  return receiveRazorpayWebhook(db, {rawBody, eventIdHeader: eventId}, now);
}

function processedOutcome(result: ReceiveWebhookResult): string {
  if (result.kind !== "processed") {
    throw new Error(`expected a processed result, got ${JSON.stringify(result)}`);
  }
  return result.outcome;
}

function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function checkoutSignature(providerOrderId: string, paymentId: string): string {
  return createHmac("sha256", KEY_SECRET).update(`${providerOrderId}|${paymentId}`).digest("hex");
}

// ---------------------------------------------------------------------------
// payment.captured
// ---------------------------------------------------------------------------

describe("payment.captured", () => {
  it("confirms the order and records the Razorpay payment ID, atomically", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Captured1"}), newEventId());

    expect(processedOutcome(result)).toBe("payment_succeeded");
    const state = await readState(order);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: "pay_Captured1", providerOrderId});
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
  });

  it("never changes the order's total, items, customer, menu, or outlet", async () => {
    const {order, providerOrderId, amountInPaise, customerId} = await setupRazorpayPayment(7500);
    const before = await readState(order);

    await deliver(eventBody({providerOrderId, amount: amountInPaise}), newEventId());

    const after = await readState(order);
    const immutable = ["subtotalInPaise", "totalInPaise", "items", "userId", "menuId", "outletId", "organizationId", "currency", "createdAt"];
    for (const field of immutable) {
      expect(after.order[field]).toEqual(before.order[field]);
    }
    expect(after.order.userId).toBe(customerId);
    expect(after.order.totalInPaise).toBe(7500);
    expect(after.payment.amountInPaise).toBe(7500);
  });

  it("rejects an amount mismatch: nothing changes, and the event is still recorded as processed", async () => {
    const {order, providerOrderId} = await setupRazorpayPayment();
    const before = await readState(order);
    const eventId = newEventId();

    const result = await deliver(eventBody({providerOrderId, amount: 100}), eventId);

    expect(processedOutcome(result)).toBe("rejected_amount_mismatch");
    expect(await readState(order)).toEqual(before);
    const record = await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get();
    expect(record.data()).toMatchObject({status: "processed", outcome: "rejected_amount_mismatch"});
  });

  it("rejects a currency mismatch: nothing changes", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const before = await readState(order);

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise, currency: "USD"}), newEventId());

    expect(processedOutcome(result)).toBe("rejected_currency_mismatch");
    expect(await readState(order)).toEqual(before);
  });

  it("does not confirm an order on a wrong provider order ID — it isn't a Zesto payment at all", async () => {
    const {order, amountInPaise} = await setupRazorpayPayment();
    const before = await readState(order);

    const result = await deliver(eventBody({providerOrderId: "order_NotOurs000000", amount: amountInPaise}), newEventId());

    expect(processedOutcome(result)).toBe("ignored_unrecognized_payment");
    expect(await readState(order)).toEqual(before);
  });

  it("ignores an event for a provider order Zesto has no payment for, creating nothing", async () => {
    // Everything asserted here belongs to THIS test. Counting every `payments`
    // / `orders` document in the shared emulator before and after would race
    // with the other emulator files, which create orders concurrently.
    const {order} = await setupRazorpayPayment();
    const ordersOfItsMenu = orderRef(order).parent;
    const before = await readState(order);
    const ordersBefore = (await ordersOfItsMenu.count().get()).data().count;
    const unknownProviderOrderId = `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const eventId = newEventId();

    const result = await deliver(eventBody({providerOrderId: unknownProviderOrderId}), eventId);

    expect(processedOutcome(result)).toBe("ignored_unrecognized_payment");
    // No payment exists for the unknown provider order: the lookup stays unresolved...
    const payments = await db.collectionGroup("payments").where("providerOrderId", "==", unknownProviderOrderId).get();
    expect(payments.empty).toBe(true);
    // ...the bystander order and payment this test owns are untouched, and no
    // order appeared next to them...
    expect(await readState(order)).toEqual(before);
    expect((await ordersOfItsMenu.count().get()).data().count).toBe(ordersBefore);
    // ...and the only trace the event leaves is its own bookkeeping record.
    const record = await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get();
    expect(record.data()).toMatchObject({
      status: "processed", outcome: "ignored_unrecognized_payment", providerOrderId: unknownProviderOrderId,
    });
  });

  it("ignores a payment that isn't tied to any Razorpay order (e.g. a payment link)", async () => {
    const result = await deliver(eventBody({providerOrderId: null}), newEventId());

    expect(processedOutcome(result)).toBe("ignored_unrecognized_payment");
  });

  it("ignores an event whose payment snapshot isn't actually captured", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const before = await readState(order);

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise, status: "authorized"}), newEventId());

    expect(processedOutcome(result)).toBe("ignored_status_mismatch");
    expect(await readState(order)).toEqual(before);
  });

  it("is idempotent when the payment already succeeded: a second captured event changes nothing", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const body = eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Same1"});
    await deliver(body, newEventId());
    const afterFirst = await readState(order);

    const second = await deliver(body, newEventId());

    expect(processedOutcome(second)).toBe("success_noop_already_succeeded");
    expect(await readState(order)).toEqual(afterFirst);
  });

  it("does not confirm a cancelled order: the capture is recorded and refunded (late capture)", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    await orderRef(order).update({status: "cancelled"});

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise}), newEventId());

    expect(processedOutcome(result)).toBe("payment_succeeded");
    const state = await readState(order);
    expect(state.order.status).toBe("cancelled");
    expect(state.payment).toMatchObject({status: "succeeded", capturedAmountInPaise: amountInPaise});
    const refunds = await orderRef(order).collection("payments").doc(order.id).collection("refunds").get();
    expect(refunds.docs.map((doc) => doc.data())).toMatchObject([
      {amountInPaise, status: "requested", reason: "late_capture_after_cancel"},
    ]);
  });

  it("does not mark a payment successful when its Zesto order is missing", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    await orderRef(order).delete(); // the payment subdocument survives; its parent order is gone

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise}), newEventId());

    expect(processedOutcome(result)).toBe("rejected_missing_order");
    const payment = await orderRef(order).collection("payments").doc(order.id).get();
    expect(payment.data()?.status).toBe("pending");
  });

  it("refuses to guess when two Zesto payments claim the same provider order ID", async () => {
    const first = await setupRazorpayPayment();
    const second = await setupRazorpayPayment();
    await orderRef(second.order).collection("payments").doc(second.order.id).update({providerOrderId: first.providerOrderId});

    const result = await deliver(eventBody({providerOrderId: first.providerOrderId, amount: first.amountInPaise}), newEventId());

    expect(processedOutcome(result)).toBe("rejected_ambiguous_payment");
    expect((await readState(first.order)).payment.status).toBe("pending");
    expect((await readState(second.order)).payment.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// payment.failed
// ---------------------------------------------------------------------------

describe("payment.failed", () => {
  it("marks the payment failed but leaves the order pending_payment and payable", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();

    const result = await deliver(
      eventBody({type: "payment.failed", providerOrderId, amount: amountInPaise, paymentId: "pay_Failed1"}), newEventId(),
    );

    expect(processedOutcome(result)).toBe("payment_marked_failed");
    const state = await readState(order);
    expect(state.payment).toMatchObject({status: "failed", providerPaymentId: "pay_Failed1"});
    expect(state.order).toMatchObject({status: "pending_payment", paymentStatus: "pending"});
  });

  it("is idempotent: a repeated failure changes nothing", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const body = eventBody({type: "payment.failed", providerOrderId, amount: amountInPaise});
    await deliver(body, newEventId());
    const afterFirst = await readState(order);

    const second = await deliver(body, newEventId());

    expect(processedOutcome(second)).toBe("failure_noop_already_failed");
    expect(await readState(order)).toEqual(afterFirst);
  });

  it("rejects a failure event with a mismatched amount", async () => {
    const {order, providerOrderId} = await setupRazorpayPayment();
    const before = await readState(order);

    const result = await deliver(eventBody({type: "payment.failed", providerOrderId, amount: 1}), newEventId());

    expect(processedOutcome(result)).toBe("rejected_amount_mismatch");
    expect(await readState(order)).toEqual(before);
  });

  it("ignores a failure event for an unrecognized provider order", async () => {
    const result = await deliver(eventBody({type: "payment.failed", providerOrderId: "order_NotOurs000000"}), newEventId());

    expect(processedOutcome(result)).toBe("ignored_unrecognized_payment");
  });
});

// ---------------------------------------------------------------------------
// Out-of-order delivery and races with the browser verification path
// ---------------------------------------------------------------------------

describe("out-of-order delivery", () => {
  it("failed → captured: a later success confirms the order and replaces the failed attempt's payment ID", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    await deliver(eventBody({type: "payment.failed", providerOrderId, amount: amountInPaise, paymentId: "pay_Attempt1"}), newEventId());

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Attempt2"}), newEventId());

    expect(processedOutcome(result)).toBe("payment_succeeded");
    const state = await readState(order);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: "pay_Attempt2"});
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
  });

  it("captured → failed: success stays authoritative and is never moved backward", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Won1"}), newEventId());
    const afterSuccess = await readState(order);

    const result = await deliver(
      eventBody({type: "payment.failed", providerOrderId, amount: amountInPaise, paymentId: "pay_EarlierAttempt"}), newEventId(),
    );

    expect(processedOutcome(result)).toBe("failure_ignored_already_succeeded");
    expect(await readState(order)).toEqual(afterSuccess);
  });

  it("captured → captured and failed → failed are idempotent no-ops", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const captured = eventBody({providerOrderId, amount: amountInPaise});
    await deliver(captured, newEventId());
    const afterCaptured = await readState(order);
    expect(processedOutcome(await deliver(captured, newEventId()))).toBe("success_noop_already_succeeded");
    expect(await readState(order)).toEqual(afterCaptured);

    const other = await setupRazorpayPayment();
    const failed = eventBody({type: "payment.failed", providerOrderId: other.providerOrderId, amount: other.amountInPaise});
    await deliver(failed, newEventId());
    const afterFailed = await readState(other.order);
    expect(processedOutcome(await deliver(failed, newEventId()))).toBe("failure_noop_already_failed");
    expect(await readState(other.order)).toEqual(afterFailed);
  });

  it("browser verification first, then the webhook: an idempotent no-op", async () => {
    const {order, customerId, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const paymentId = "pay_Browser1";
    await verifyCheckoutPayment(db, customerId, order.id, {
      razorpayPaymentId: paymentId, razorpayOrderId: providerOrderId, razorpaySignature: checkoutSignature(providerOrderId, paymentId),
    });
    const afterBrowser = await readState(order);
    expect(afterBrowser.order.status).toBe("confirmed");

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId}), newEventId());

    expect(processedOutcome(result)).toBe("success_noop_already_succeeded");
    expect(await readState(order)).toEqual(afterBrowser);
  });

  it("browser verification first, then a webhook for a DIFFERENT Razorpay payment: reported, never overwritten", async () => {
    const {order, customerId, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    await verifyCheckoutPayment(db, customerId, order.id, {
      razorpayPaymentId: "pay_Browser2", razorpayOrderId: providerOrderId, razorpaySignature: checkoutSignature(providerOrderId, "pay_Browser2"),
    });
    const afterBrowser = await readState(order);

    const result = await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_SecondCapture"}), newEventId());

    expect(processedOutcome(result)).toBe("success_conflicting_payment_id");
    expect(await readState(order)).toEqual(afterBrowser);
    expect((await readState(order)).payment.providerPaymentId).toBe("pay_Browser2");
  });

  it("webhook success first, then browser verification of the same payment: idempotent", async () => {
    const {order, customerId, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const paymentId = "pay_Webhook1";
    await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId}), newEventId());
    const afterWebhook = await readState(order);

    const verified = await verifyCheckoutPayment(db, customerId, order.id, {
      razorpayPaymentId: paymentId, razorpayOrderId: providerOrderId, razorpaySignature: checkoutSignature(providerOrderId, paymentId),
    });

    expect(verified.order.status).toBe("confirmed");
    expect(await readState(order)).toEqual(afterWebhook);
  });

  it("webhook success first, then browser verification of a different payment: a conflict, never an overwrite", async () => {
    const {order, customerId, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Webhook2"}), newEventId());

    await expect(verifyCheckoutPayment(db, customerId, order.id, {
      razorpayPaymentId: "pay_Other", razorpayOrderId: providerOrderId, razorpaySignature: checkoutSignature(providerOrderId, "pay_Other"),
    })).rejects.toMatchObject({code: "already-exists"});
    expect((await readState(order)).payment.providerPaymentId).toBe("pay_Webhook2");
  });

  it("concurrent captured events with DIFFERENT event IDs still confirm the order exactly once", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const body = eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Race1"});

    const results = await Promise.all(Array.from({length: 6}, () => deliver(body, newEventId())));

    for (const result of results) {
      expect(["payment_succeeded", "success_noop_already_succeeded"]).toContain(processedOutcome(result));
    }
    const state = await readState(order);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: "pay_Race1"});
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
  });

  it("a captured and a failed event racing never leave the payment failed once it has succeeded", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const captured = eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Win"});
    const failed = eventBody({type: "payment.failed", providerOrderId, amount: amountInPaise, paymentId: "pay_Lose"});

    await Promise.all([deliver(failed, newEventId()), deliver(captured, newEventId()), deliver(failed, newEventId())]);
    // Whatever the interleaving, a follow-up captured delivery must converge on success...
    await deliver(captured, newEventId());
    // ...and a LATE failure after that must not undo it.
    await deliver(failed, newEventId());

    const state = await readState(order);
    expect(state.payment.status).toBe("succeeded");
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("event deduplication", () => {
  it("the same event delivered twice produces exactly one state change; the second is a safe duplicate", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const body = eventBody({providerOrderId, amount: amountInPaise});
    const eventId = newEventId();

    const first = await deliver(body, eventId);
    const afterFirst = await readState(order);
    const second = await deliver(body, eventId);

    expect(processedOutcome(first)).toBe("payment_succeeded");
    expect(second).toEqual({kind: "duplicate", eventKey: `evt_${eventId}`, originalOutcome: "payment_succeeded"});
    expect(await readState(order)).toEqual(afterFirst);
  });

  it("concurrent deliveries of the SAME event: exactly one does the work", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const body = eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Concurrent"});
    const eventId = newEventId();

    const results = await Promise.all(Array.from({length: 8}, () => deliver(body, eventId)));

    expect(results.filter((r) => r.kind === "processed")).toHaveLength(1);
    for (const result of results) {
      expect(["processed", "duplicate", "in_progress"]).toContain(result.kind);
    }
    const state = await readState(order);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: "pay_Concurrent"});
    const record = await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get();
    expect(record.data()).toMatchObject({status: "processed", outcome: "payment_succeeded", attempts: 1});
  });

  it("an already-processed event returns safely, without re-applying — even after the payment moved on", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const failedEventId = newEventId();
    const failed = eventBody({type: "payment.failed", providerOrderId, amount: amountInPaise, paymentId: "pay_F"});
    await deliver(failed, failedEventId);
    await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_S"}), newEventId());
    const afterSuccess = await readState(order);

    const replay = await deliver(failed, failedEventId);

    expect(replay).toMatchObject({kind: "duplicate", originalOutcome: "payment_marked_failed"});
    expect(await readState(order)).toEqual(afterSuccess);
  });

  it("without the event-ID header, the same body is deduplicated by its fingerprint", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const body = eventBody({providerOrderId, amount: amountInPaise});

    const first = await deliver(body, undefined);
    const second = await deliver(Buffer.from(body), undefined);

    expect(processedOutcome(first)).toBe("payment_succeeded");
    expect(second.kind).toBe("duplicate");
    const key = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: body}).eventKey;
    expect(key.startsWith("body_")).toBe(true);
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(key).get()).exists).toBe(true);
    expect((await readState(order)).payment.status).toBe("succeeded");
  });

  it("stores only operational metadata — never the body, a secret, or customer/card data", async () => {
    const {providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const eventId = newEventId();

    await deliver(eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Meta1"}), eventId);

    const data = (await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get()).data() ?? {};
    expect(Object.keys(data).sort()).toEqual([
      "attempts", "bodyFingerprint", "claimedAt", "eventType", "id", "keySource", "leaseExpiresAt",
      "outcome", "processedAt", "providerOrderId", "providerPaymentId", "receivedAt", "status",
    ]);
    expect(data).toMatchObject({
      id: `evt_${eventId}`, eventType: "payment.captured", keySource: "event_id_header", status: "processed",
      outcome: "payment_succeeded", providerOrderId, providerPaymentId: "pay_Meta1",
    });
    const serialized = JSON.stringify(data);
    for (const forbidden of ["customer@example.com", "+911234567890", "5449", "secret", "signature", "acc_TestAccount"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not record a malformed event as processed (or at all)", async () => {
    const malformed = Buffer.from("{\"event\":\"payment.captured\",\"payload\":{}}");
    const key = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: malformed}).eventKey;

    const result = await deliver(malformed, undefined);

    expect(result).toEqual({kind: "malformed"});
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(key).get()).exists).toBe(false);
  });

  it("does not record an unsupported event type, and never mutates state for it", async () => {
    const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
    const before = await readState(order);
    const eventId = newEventId();
    const orderPaid = Buffer.from(JSON.stringify({
      entity: "event", event: "order.paid",
      payload: {payment: {entity: {id: "pay_X", order_id: providerOrderId, amount: amountInPaise, currency: "INR", status: "captured"}}},
    }));

    const result = await deliver(orderPaid, eventId);

    expect(result).toEqual({kind: "ignored", eventType: "order.paid"});
    expect(await readState(order)).toEqual(before);
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get()).exists).toBe(false);
  });

  it("refuses to treat a known event ID with a DIFFERENT body as a duplicate (the header isn't authenticated)", async () => {
    const real = await setupRazorpayPayment();
    const other = await setupRazorpayPayment();
    const eventId = newEventId();
    await deliver(eventBody({providerOrderId: real.providerOrderId, amount: real.amountInPaise, paymentId: "pay_Real"}), eventId);
    const before = await readState(other.order);

    const result = await deliver(eventBody({providerOrderId: other.providerOrderId, amount: other.amountInPaise, paymentId: "pay_Forged"}), eventId);

    expect(result).toEqual({kind: "event_id_conflict", eventKey: `evt_${eventId}`});
    expect(await readState(other.order)).toEqual(before); // not processed
  });

  describe("claim lease", () => {
    function identity(eventId: string, body: Buffer) {
      return deriveWebhookEventIdentity({eventIdHeader: eventId, rawBody: body});
    }

    it("a delivery that arrives while another holds an unexpired claim is NOT processed (in_progress)", async () => {
      const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
      const body = eventBody({providerOrderId, amount: amountInPaise});
      const eventId = newEventId();
      const t0 = Timestamp.now();
      const claim = await claimWebhookEvent(db, {identity: identity(eventId, body), eventType: "payment.captured"}, t0);
      expect(claim).toEqual({kind: "claimed", attempt: 1});

      const duringLease = await deliver(body, eventId, Timestamp.fromMillis(t0.toMillis() + WEBHOOK_CLAIM_LEASE_MS - 1000));

      expect(duringLease).toEqual({kind: "in_progress", eventKey: `evt_${eventId}`});
      expect((await readState(order)).payment.status).toBe("pending");
    });

    it("once the lease expires, a retried delivery re-claims and completes the event (a crashed attempt is never lost)", async () => {
      const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
      const body = eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Recovered"});
      const eventId = newEventId();
      const t0 = Timestamp.now();
      await claimWebhookEvent(db, {identity: identity(eventId, body), eventType: "payment.captured"}, t0);

      const afterLease = await deliver(body, eventId, Timestamp.fromMillis(t0.toMillis() + WEBHOOK_CLAIM_LEASE_MS + 1000));

      expect(processedOutcome(afterLease)).toBe("payment_succeeded");
      expect((await readState(order)).payment).toMatchObject({status: "succeeded", providerPaymentId: "pay_Recovered"});
      const record = await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get();
      expect(record.data()).toMatchObject({status: "processed", attempts: 2});
    });

    it("an event whose processing fails is NOT left marked processed, and is released for an immediate retry", async () => {
      const {order, providerOrderId, amountInPaise} = await setupRazorpayPayment();
      const body = eventBody({providerOrderId, amount: amountInPaise, paymentId: "pay_Retry"});
      const eventId = newEventId();
      // A Firestore whose collection-group lookup fails transiently, once.
      const flaky = new Proxy(db, {
        get(target, property) {
          if (property === "collectionGroup") {
            return () => {
              throw new Error("transient Firestore failure");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(receiveRazorpayWebhook(flaky, {rawBody: body, eventIdHeader: eventId})).rejects.toThrow("transient");

      const afterFailure = (await db.collection(WEBHOOK_EVENTS_COLLECTION).doc(`evt_${eventId}`).get()).data();
      expect(afterFailure?.status).toBe("processing"); // never "processed"
      expect(afterFailure?.processedAt).toBeUndefined();
      expect((await readState(order)).payment.status).toBe("pending");

      // The very next delivery (no waiting out the lease) completes it.
      const retry = await deliver(body, eventId);

      expect(processedOutcome(retry)).toBe("payment_succeeded");
      expect((await readState(order)).order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
    });
  });
});

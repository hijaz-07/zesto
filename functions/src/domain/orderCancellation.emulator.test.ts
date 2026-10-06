// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import {businessDateString} from "../time";
import type {CancellationActor, OrderCancellationReason} from "./cancellation";
import {createMenu} from "./menus";
import {cancelOrder} from "./orderCancellation";
import {transitionOrderStatus} from "./orderFulfillment";
import {type OrderStatus} from "./orders";
import {createOrganization} from "./organizations";
import {createOutlet} from "./outlets";
import {markPaymentFailed, markPaymentSucceeded, type PaymentTransitionResult} from "./payments";
import {NOTIFICATION_EVENTS_COLLECTION} from "./notificationEvents";
import {refundIdFor} from "./refunds";

/**
 * `cancelOrder`, and the late-capture half of `markPaymentSucceeded`, against a
 * REAL Firestore emulator: the transaction, every document it writes (the
 * order's cancellation and refund mirror, the payment's refund aggregates, the
 * refund document) and the ones it must leave alone, authorization before
 * idempotency, fail-closed deadline reads, payment consistency, and the races
 * that must converge — cancellation vs payment success, repeated cancellation,
 * repeated refund creation.
 *
 * The organization/outlet/menu chain is built through the domain functions;
 * orders and payments are written directly in whatever state a test needs, with
 * the exact shape the domain writes.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own: it runs deliberately contended
// transactions (the race tests), which in the project every other emulator suite
// shares would slow those suites' collection-group order lookups down (see
// orderFulfillment.emulator.test.ts, same reasoning and same fix).
const PROJECT_ID = "demo-zesto-cancellation-domain";

let db: Firestore;

// The same per-file (not global) timeout `payments.emulator.test.ts` and the
// fulfillment emulator files use.
vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this file via " +
      "`npm run test:functions-emulator` (from the repo root), which " +
      "starts the Firestore emulator first.",
    );
  }
  const app = getApps().length > 0 ?
    getApps()[0] :
    initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

// Everything a test seeds hangs off an order; `recursiveDelete` removes the order
// with its payment, the payment's refunds, so leftovers never slow the
// collection-group order lookups every call here does.
const seededOrderRefs: DocumentReference[] = [];

afterEach(async () => {
  // Outbox events a live success records for an order (a late capture records none).
  for (const ref of seededOrderRefs.splice(0)) {
    const events = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", ref.id).get();
    await Promise.all(events.docs.map((event) => event.ref.delete()));
    await db.recursiveDelete(ref);
  }
});

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

function member(organizationId: string, role: OrganizationMemberRole): OrganizationMembership {
  return {userId: freshUserId(), organizationId, role, status: "active"};
}

async function createDraftMenu(organizationId: string, outletId: string, ownerId: string) {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  return createMenu(db, organizationId, outletId, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 60 * 60 * 1000)),
    // An hour from now: a customer may cancel a confirmed order right now.
    orderingClosesAt: Timestamp.fromDate(new Date(now + 60 * 60 * 1000)),
    pickupStartsAt: Timestamp.fromDate(new Date(tomorrow)),
    pickupEndsAt: Timestamp.fromDate(new Date(tomorrow + 4 * 60 * 60 * 1000)),
  });
}

interface OrgFixture {
  organizationId: string;
  outletId: string;
  ownerId: string;
  menuId: string;
  /** The menu's `orderingClosesAt` — the customer cancellation deadline. */
  closesAt: Timestamp;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const suffix = randomUUID();
  const {organization} = await createOrganization(db, ownerId, {name: `${label} ${suffix}`, slug: `cancel-org-${suffix}`});
  const outlet = await createOutlet(db, organization.id, ownerId, {name: `${label} Canteen`, slug: `outlet-${randomUUID()}`});
  const menu = await createDraftMenu(organization.id, outlet.id, ownerId);
  return {
    organizationId: organization.id,
    outletId: outlet.id,
    ownerId,
    menuId: menu.id,
    closesAt: menu.orderingClosesAt,
  };
}

const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));
const AMOUNT = 10000;

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
  organizationId: string;
  outletId: string;
  menuId: string;
}

interface SeedOrderInput {
  org: OrgFixture;
  status: OrderStatus;
  paymentStatus?: "pending" | "paid";
  menuId?: string;
  extra?: Record<string, unknown>;
}

async function seedOrder(input: SeedOrderInput): Promise<SeededOrder> {
  const {org} = input;
  const menuId = input.menuId ?? org.menuId;
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(org.outletId)
    .collection("menus").doc(menuId)
    .collection("orders").doc();
  seededOrderRefs.push(ref);
  const customerId = freshUserId();
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId,
    status: input.status,
    paymentStatus: input.paymentStatus ?? (input.status === "pending_payment" ? "pending" : "paid"),
    currency: "INR",
    subtotalInPaise: AMOUNT,
    totalInPaise: AMOUNT,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: AMOUNT}],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input.extra,
  });
  return {id: ref.id, ref, customerId, organizationId: org.organizationId, outletId: org.outletId, menuId};
}

interface SeedPaymentInput {
  set?: Record<string, unknown>;
  omit?: string[];
}

/** The order's payment document, `succeeded` by default, as `markPaymentSucceeded` writes it. */
async function seedPayment(order: SeededOrder, input: SeedPaymentInput = {}): Promise<void> {
  const data: Record<string, unknown> = {
    id: order.id,
    orderId: order.id,
    userId: order.customerId,
    organizationId: order.organizationId,
    outletId: order.outletId,
    menuId: order.menuId,
    amountInPaise: AMOUNT,
    currency: "INR",
    status: "succeeded",
    provider: "razorpay",
    providerOrderId: `order_${randomUUID().slice(0, 14)}`,
    providerPaymentId: `pay_${randomUUID().slice(0, 14)}`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input.set,
  };
  for (const key of input.omit ?? []) {
    delete data[key];
  }
  await paymentRef(order).create(data);
}

function paymentRef(order: SeededOrder): DocumentReference {
  return order.ref.collection("payments").doc(order.id);
}

/** A paid order exactly as `markPaymentSucceeded` leaves it (a legacy one when `legacy`: no captured amount). */
async function seedPaidOrder(
  org: OrgFixture,
  status: OrderStatus = "confirmed",
  payment: SeedPaymentInput = {},
  legacy = true,
): Promise<SeededOrder> {
  const order = await seedOrder({org, status, paymentStatus: "paid"});
  await seedPayment(order, {
    ...payment,
    set: {...(legacy ? {} : {capturedAmountInPaise: AMOUNT}), ...payment.set},
  });
  return order;
}

/** An unpaid order with a still-pending payment that has a provider order. */
async function seedPendingOrder(org: OrgFixture): Promise<SeededOrder> {
  const order = await seedOrder({org, status: "pending_payment"});
  await seedPayment(order, {set: {status: "pending"}, omit: ["providerPaymentId"]});
  return order;
}

async function raw(ref: DocumentReference): Promise<Record<string, unknown>> {
  const data = (await ref.get()).data();
  if (!data) {
    throw new Error(`${ref.path} is gone`);
  }
  return data;
}

const rawOrder = (order: SeededOrder) => raw(order.ref);
const rawPayment = (order: SeededOrder) => raw(paymentRef(order));

async function refundsOf(order: SeededOrder): Promise<Array<Record<string, unknown>>> {
  const snapshot = await paymentRef(order).collection("refunds").get();
  return snapshot.docs.map((doc) => doc.data());
}

/** Every outbox FORWARD order event recorded for the order (none must exist for a late capture). */
async function notificationEventsOf(order: SeededOrder): Promise<string[]> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", order.id).get();
  return snapshot.docs
    .filter((doc) => !/^(refund_|order_cancelled_)/.test(String(doc.data().type)))
    .map((doc) => doc.id);
}

/** Every outbox CANCELLATION event recorded for the order: one per cancellation, never a repeat. */
async function cancellationEventsOf(order: SeededOrder): Promise<Array<Record<string, unknown>>> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", order.id).get();
  return snapshot.docs.filter((doc) => String(doc.data().type).startsWith("order_cancelled_")).map((doc) => doc.data());
}

/** Every outbox REFUND event recorded for the order: one `refund_requested` per refund created. */
async function refundEventsOf(order: SeededOrder): Promise<string[]> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", order.id).get();
  return snapshot.docs.filter((doc) => String(doc.data().type).startsWith("refund_")).map((doc) => doc.id).sort();
}

function without(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)));
}

/**
 * The cross-document invariant every refund-touching test ends on: the payment's
 * aggregates are the sum of its refunds, `refundSeq` counts them, and the
 * order's mirror equals the payment's figures (or is absent exactly when the
 * payment has no refund activity).
 */
async function expectConsistent(order: SeededOrder): Promise<void> {
  const [orderData, payment, refunds] = await Promise.all([rawOrder(order), rawPayment(order), refundsOf(order)]);
  const sum = (statuses: string[]) => refunds
    .filter((refund) => statuses.includes(refund.status as string))
    .reduce((total, refund) => total + (refund.amountInPaise as number), 0);
  const pending = sum(["requested", "pending"]);
  const refunded = sum(["processed"]);

  expect((payment.refundPendingInPaise as number | undefined) ?? 0).toBe(pending);
  expect((payment.refundedAmountInPaise as number | undefined) ?? 0).toBe(refunded);
  expect((payment.refundSeq as number | undefined) ?? 0).toBe(refunds.length);
  expect(pending + refunded).toBeLessThanOrEqual(AMOUNT);

  if (payment.refundState === undefined || payment.refundState === "none") {
    expect(orderData.refundStatus).toBeUndefined();
    expect(orderData.refundedInPaise).toBeUndefined();
  } else {
    expect(orderData.refundStatus).toBe(payment.refundState);
    expect(orderData.refundedInPaise).toBe(refunded);
  }
}

/** A refund document in the full shape the domain writes, at the given sequence. */
async function seedRefund(
  order: SeededOrder,
  seq: number,
  status: "requested" | "pending" | "processed" | "failed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const id = `${order.id}-r${seq}`;
  await paymentRef(order).collection("refunds").doc(id).set({
    id,
    paymentId: order.id,
    orderId: order.id,
    organizationId: order.organizationId,
    outletId: order.outletId,
    menuId: order.menuId,
    userId: order.customerId,
    providerPaymentId: "pay_seeded",
    amountInPaise: AMOUNT,
    currency: "INR",
    status,
    reason: "customer_cancelled",
    source: "cancellation",
    initiatedBy: order.customerId,
    initiatedByRole: "customer",
    idempotencyKey: id,
    submitAttempts: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    attentionRequired: false,
    ...extra,
  });
}

function customer(order: SeededOrder): CancellationActor {
  return {kind: "customer", userId: order.customerId};
}

function organization(who: OrganizationMembership): CancellationActor {
  return {kind: "organization", membership: who};
}

async function rejectionOf(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}

/** Retries a call that lost a race Firestore could not retry past (409 `aborted`): the call is idempotent. */
async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt < 3 && error instanceof HttpsError && error.code === "aborted") {
        continue;
      }
      throw error;
    }
  }
}

function capture(order: SeededOrder, overrides: Partial<Parameters<typeof markPaymentSucceeded>[1]> = {}): Promise<PaymentTransitionResult> {
  return markPaymentSucceeded(db, {
    orderId: order.id,
    paymentId: order.id,
    amountInPaise: AMOUNT,
    currency: "INR",
    providerPaymentId: "pay_captured_1",
    ...overrides,
  });
}

describe("cancelOrder (Firestore emulator)", () => {
  let orgA: OrgFixture;
  let orgB: OrgFixture;

  beforeAll(async () => {
    orgA = await buildOrg("Org A");
    orgB = await buildOrg("Org B");
  });

  describe("a customer cancelling", () => {
    it("cancels an unpaid pending_payment order: audit fields, no refund, no mirror, nothing else touched", async () => {
      const order = await seedPendingOrder(orgA);
      const before = await rawOrder(order);
      const paymentBefore = await rawPayment(order);

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "changed_my_mind"});

      expect(result).toMatchObject({changed: true, previousStatus: "pending_payment", refund: null});
      expect(result.order.status).toBe("cancelled");
      const after = await rawOrder(order);
      expect(after).toMatchObject({
        status: "cancelled",
        cancelledBy: order.customerId,
        cancelledByRole: "customer",
        cancelledFromStatus: "pending_payment",
        cancellationReason: "changed_my_mind",
      });
      expect(after.cancelledAt).toBeInstanceOf(Timestamp);
      expect(after.updatedAt).toEqual(after.cancelledAt);
      // Money, items, ownership and history are untouched, and there is no refund of any kind.
      expect(without(after, [
        "status", "updatedAt", "cancelledAt", "cancelledBy", "cancelledByRole", "cancelledFromStatus", "cancellationReason",
      ])).toEqual(without(before, ["status", "updatedAt"]));
      expect(await refundsOf(order)).toEqual([]);
      expect(await rawPayment(order)).toEqual(paymentBefore);
      expect(after.refundStatus).toBeUndefined();
      expect(after.refundedInPaise).toBeUndefined();
      // Notifications: one cancellation event, and — no money having moved — no refund event.
      expect(await cancellationEventsOf(order)).toMatchObject([
        {type: "order_cancelled_by_customer", refundInitiated: false, status: "pending"},
      ]);
      expect(await refundEventsOf(order)).toEqual([]);
    });

    it("cancels a pending_payment order that never got a payment document", async () => {
      const order = await seedOrder({org: orgA, status: "pending_payment"});

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result.changed).toBe(true);
      expect((await rawOrder(order)).status).toBe("cancelled");
    });

    it("writes no cancellationReason at all when the customer gave none (never an undefined field)", async () => {
      const order = await seedPendingOrder(orgA);

      await cancelOrder(db, {actor: customer(order), orderId: order.id});

      const after = await rawOrder(order);
      expect(after.status).toBe("cancelled");
      expect(Object.keys(after)).not.toContain("cancellationReason");
      expect(Object.values(after).every((value) => value !== undefined)).toBe(true);
    });

    it("cancels a confirmed order before the deadline, and refunds it", async () => {
      const order = await seedPaidOrder(orgA);

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "ordered_by_mistake"});

      expect(result).toMatchObject({changed: true, previousStatus: "confirmed"});
      expect(result.refund).toEqual({refundId: refundIdFor(order.id, 1), amountInPaise: AMOUNT});
      expect((await rawOrder(order)).status).toBe("cancelled");
      // The cancellation and the refund are separate events, both written with the cancellation.
      expect(await cancellationEventsOf(order)).toMatchObject([
        {type: "order_cancelled_by_customer", refundInitiated: true},
      ]);
      expect(await refundEventsOf(order)).toEqual([`${refundIdFor(order.id, 1)}_refund_requested`]);
      await expectConsistent(order);
    });

    it("refuses a cancellation exactly at the deadline: the instant itself is closed", async () => {
      const order = await seedPaidOrder(orgA);
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {
        actor: customer(order), orderId: order.id, now: () => orgA.closesAt,
      }));

      expect(error.httpErrorCode.status).toBe(409);
      expect(error.message).toMatch(/Ordering has closed/);
      expect(await rawOrder(order)).toEqual(before);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("accepts a cancellation one millisecond before the deadline", async () => {
      const order = await seedPaidOrder(orgA);

      const result = await cancelOrder(db, {
        actor: customer(order), orderId: order.id, now: () => Timestamp.fromMillis(orgA.closesAt.toMillis() - 1),
      });

      expect(result.changed).toBe(true);
    });

    it("refuses a cancellation after the deadline", async () => {
      const order = await seedPaidOrder(orgA);
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {
        actor: customer(order), orderId: order.id, now: () => Timestamp.fromMillis(orgA.closesAt.toMillis() + 1),
      }));

      expect(error.httpErrorCode.status).toBe(409);
      expect(await rawOrder(order)).toEqual(before);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("has no deadline for an unpaid order: it may always be abandoned", async () => {
      const order = await seedPendingOrder(orgA);

      const result = await cancelOrder(db, {
        actor: customer(order), orderId: order.id, now: () => Timestamp.fromMillis(orgA.closesAt.toMillis() + 86_400_000),
      });

      expect(result.changed).toBe(true);
    });

    it.each<[OrderStatus, string]>([
      ["preparing", "already being prepared"],
      ["ready", "ready for pickup"],
      ["picked_up", "already been picked up"],
      ["completed", "already been completed"],
    ])("refuses a %s order (409) and changes nothing", async (status, message) => {
      const order = await seedPaidOrder(orgA, status);
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {actor: customer(order), orderId: order.id}));

      expect(error.httpErrorCode.status).toBe(409);
      expect(error.message).toContain(message);
      expect(await rawOrder(order)).toEqual(before);
      expect(await refundsOf(order)).toEqual([]);
    });
  });

  describe("an organization cancelling", () => {
    it.each<[OrderStatus, boolean]>([
      ["pending_payment", false],
      ["confirmed", true],
      ["preparing", true],
      ["ready", true],
    ])("lets an owner and a manager cancel a %s order (refund: %s)", async (status, refunds) => {
      for (const role of ["owner", "manager"] as const) {
        const order = status === "pending_payment" ? await seedPendingOrder(orgA) : await seedPaidOrder(orgA, status);
        const actor = member(orgA.organizationId, role);

        const result = await cancelOrder(db, {actor: organization(actor), orderId: order.id, reason: "outlet_closed"});

        expect(result).toMatchObject({changed: true, previousStatus: status});
        expect(await rawOrder(order)).toMatchObject({
          status: "cancelled",
          cancelledBy: actor.userId,
          cancelledByRole: "organization",
          cancelledFromStatus: status,
          cancellationReason: "outlet_closed",
        });
        expect(await refundsOf(order)).toHaveLength(refunds ? 1 : 0);
        if (refunds) {
          expect((await refundsOf(order))[0]).toMatchObject({
            reason: "outlet_cancelled", initiatedBy: actor.userId, initiatedByRole: "organization", amountInPaise: AMOUNT,
          });
        }
        await expectConsistent(order);
      }
    });

    it("is not bound by the customer's deadline", async () => {
      const order = await seedPaidOrder(orgA);

      const result = await cancelOrder(db, {
        actor: organization(member(orgA.organizationId, "owner")),
        orderId: order.id,
        reason: "cannot_fulfil_in_time",
        now: () => Timestamp.fromMillis(orgA.closesAt.toMillis() + 86_400_000),
      });

      expect(result.changed).toBe(true);
    });

    it.each<OrderStatus>(["picked_up", "completed"])("refuses a %s order (409)", async (status) => {
      const order = await seedPaidOrder(orgA, status);
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {
        actor: organization(member(orgA.organizationId, "owner")), orderId: order.id, reason: "other",
      }));

      expect(error.httpErrorCode.status).toBe(409);
      expect(await rawOrder(order)).toEqual(before);
    });

    it("refuses staff (403): cancelling starts a refund", async () => {
      const order = await seedPaidOrder(orgA);
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {
        actor: organization(member(orgA.organizationId, "staff")), orderId: order.id, reason: "outlet_closed",
      }));

      expect(error.httpErrorCode.status).toBe(403);
      expect(await rawOrder(order)).toEqual(before);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("refuses a member who is not active (403)", async () => {
      const order = await seedPaidOrder(orgA);

      for (const status of ["invited", "revoked"] as const) {
        const actor = {...member(orgA.organizationId, "owner"), status};
        const error = await rejectionOf(cancelOrder(db, {actor: organization(actor), orderId: order.id, reason: "other"}));
        expect(error.httpErrorCode.status).toBe(403);
      }
      expect((await rawOrder(order)).status).toBe("confirmed");
    });

    it("refuses another organization's owner as a plain 404, and changes nothing", async () => {
      const order = await seedPaidOrder(orgA);
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {
        actor: organization(member(orgB.organizationId, "owner")), orderId: order.id, reason: "outlet_closed",
      }));

      expect(error.httpErrorCode.status).toBe(404);
      expect(error.message).toBe("Order not found.");
      expect(await rawOrder(order)).toEqual(before);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("requires a reason (400) and refuses a customer's reason (400)", async () => {
      const order = await seedPaidOrder(orgA);
      const owner = organization(member(orgA.organizationId, "owner"));

      for (const reason of [undefined, "changed_my_mind", "nonsense", 7, null]) {
        const error = await rejectionOf(cancelOrder(db, {actor: owner, orderId: order.id, reason}));
        expect(error.httpErrorCode.status).toBe(400);
      }
      expect((await rawOrder(order)).status).toBe("confirmed");
      expect(await refundsOf(order)).toEqual([]);
    });
  });

  describe("authorization comes before everything else", () => {
    it("refuses another customer (404) and changes nothing", async () => {
      const order = await seedPaidOrder(orgA);
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {
        actor: {kind: "customer", userId: freshUserId()}, orderId: order.id,
      }));

      expect(error.httpErrorCode.status).toBe(404);
      expect(error.message).toBe("Order not found.");
      expect(await rawOrder(order)).toEqual(before);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("answers a missing order exactly like another customer's order", async () => {
      const error = await rejectionOf(cancelOrder(db, {
        actor: {kind: "customer", userId: freshUserId()}, orderId: "no-such-order",
      }));

      expect(error.httpErrorCode.status).toBe(404);
      expect(error.message).toBe("Order not found.");
    });

    it("refuses a malformed order ID (400) before reading anything", async () => {
      const error = await rejectionOf(cancelOrder(db, {actor: {kind: "customer", userId: "U-1"}, orderId: "a/b"}));

      expect(error.httpErrorCode.status).toBe(400);
    });

    it.each<[string, (order: SeededOrder) => CancellationActor, number]>([
      ["another customer", () => ({kind: "customer", userId: freshUserId()}), 404],
      ["another organization's owner", () => organization(member(orgB.organizationId, "owner")), 404],
      ["staff of the order's own organization", () => organization(member(orgA.organizationId, "staff")), 403],
    ])("does not let an already-cancelled order become an authorization bypass for %s", async (_who, actorFor, status) => {
      const order = await seedPaidOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "changed_my_mind"});
      const before = await rawOrder(order);

      const error = await rejectionOf(cancelOrder(db, {actor: actorFor(order), orderId: order.id, reason: "other"}));

      expect(error.httpErrorCode.status).toBe(status);
      expect(await rawOrder(order)).toEqual(before);
    });

    it("still validates the reason of an authorized repeat: an invalid one is a 400, not a no-op", async () => {
      const order = await seedPaidOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});

      const error = await rejectionOf(cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "item_unavailable"}));

      expect(error.httpErrorCode.status).toBe(400);
    });

    it("refuses an invalid customer reason (400) before the order's status is considered", async () => {
      const order = await seedPaidOrder(orgA, "completed");

      const error = await rejectionOf(cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "item_unavailable"}));

      expect(error.httpErrorCode.status).toBe(400);
    });
  });

  describe("the customer's deadline fails closed", () => {
    it("refuses when the order's menu is missing, but not an organization", async () => {
      const customerOrder = await seedOrder({org: orgA, status: "confirmed", menuId: `no-menu-${randomUUID()}`});
      await seedPayment(customerOrder);
      const orgOrder = await seedOrder({org: orgA, status: "confirmed", menuId: `no-menu-${randomUUID()}`});
      await seedPayment(orgOrder);

      const error = await rejectionOf(cancelOrder(db, {actor: customer(customerOrder), orderId: customerOrder.id}));
      expect(error.httpErrorCode.status).toBe(409);
      expect(error.message).toMatch(/Ordering has closed/);
      expect((await rawOrder(customerOrder)).status).toBe("confirmed");

      const result = await cancelOrder(db, {
        actor: organization(member(orgA.organizationId, "owner")), orderId: orgOrder.id, reason: "outlet_closed",
      });
      expect(result.changed).toBe(true);
    });

    it("refuses when the menu's deadline is unreadable", async () => {
      const menu = await createDraftMenu(orgA.organizationId, orgA.outletId, orgA.ownerId);
      const order = await seedOrder({org: orgA, status: "confirmed", menuId: menu.id});
      await seedPayment(order);
      await db
        .collection("organizations").doc(orgA.organizationId)
        .collection("outlets").doc(orgA.outletId)
        .collection("menus").doc(menu.id)
        .update({orderingClosesAt: "tomorrow"});

      const error = await rejectionOf(cancelOrder(db, {actor: customer(order), orderId: order.id}));

      expect(error.httpErrorCode.status).toBe(409);
      expect((await rawOrder(order)).status).toBe("confirmed");
      expect(await refundsOf(order)).toEqual([]);
    });

    it("does not need the menu to abandon an unpaid order", async () => {
      const order = await seedOrder({org: orgA, status: "pending_payment", menuId: `no-menu-${randomUUID()}`});

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result.changed).toBe(true);
    });

    it("reads the deadline from the order's OWN menu, not another menu of the organization", async () => {
      const closedMenu = await createDraftMenu(orgA.organizationId, orgA.outletId, orgA.ownerId);
      await db
        .collection("organizations").doc(orgA.organizationId)
        .collection("outlets").doc(orgA.outletId)
        .collection("menus").doc(closedMenu.id)
        .update({
          orderingOpensAt: Timestamp.fromMillis(Date.now() - 4 * 3_600_000),
          orderingClosesAt: Timestamp.fromMillis(Date.now() - 3_600_000),
        });
      const order = await seedOrder({org: orgA, status: "confirmed", menuId: closedMenu.id});
      await seedPayment(order);

      const error = await rejectionOf(cancelOrder(db, {actor: customer(order), orderId: order.id}));

      expect(error.httpErrorCode.status).toBe(409);
      expect(error.message).toMatch(/Ordering has closed/);
    });
  });

  describe("idempotency", () => {
    it("treats a repeat by the authorized actor as a no-op that keeps the original audit data", async () => {
      const order = await seedPaidOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "changed_my_mind"});
      const orderBefore = await rawOrder(order);
      const paymentBefore = await rawPayment(order);
      const refundsBefore = await refundsOf(order);

      const again = await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "other"});

      expect(again).toMatchObject({changed: false, previousStatus: "cancelled", refund: null});
      expect(again.order.status).toBe("cancelled");
      expect(await rawOrder(order)).toEqual(orderBefore);
      expect(await rawPayment(order)).toEqual(paymentBefore);
      expect(await refundsOf(order)).toEqual(refundsBefore);
    });

    it("lets the organization repeat a customer's cancellation without taking the credit", async () => {
      const order = await seedPaidOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "changed_my_mind"});

      const again = await cancelOrder(db, {
        actor: organization(member(orgA.organizationId, "manager")), orderId: order.id, reason: "outlet_closed",
      });

      expect(again.changed).toBe(false);
      expect(await rawOrder(order)).toMatchObject({cancelledBy: order.customerId, cancelledByRole: "customer"});
      expect(await refundsOf(order)).toHaveLength(1);
    });

    it("does not reserve money twice when a cancellation is repeated", async () => {
      const order = await seedPaidOrder(orgA);

      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(await refundsOf(order)).toHaveLength(1);
      expect(await rawPayment(order)).toMatchObject({refundPendingInPaise: AMOUNT, refundSeq: 1, refundState: "in_progress"});
      await expectConsistent(order);
    });
  });

  describe("payment and refund", () => {
    it("creates exactly one refund for a paid cancellation, in the pre-provider state", async () => {
      const order = await seedPaidOrder(orgA);
      const providerPaymentId = (await rawPayment(order)).providerPaymentId;
      const actorId = order.customerId;

      await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "wrong_pickup_time"});

      const refunds = await refundsOf(order);
      expect(refunds).toHaveLength(1);
      const refund = refunds[0];
      expect(refund).toMatchObject({
        id: `${order.id}-r1`,
        paymentId: order.id,
        orderId: order.id,
        organizationId: orgA.organizationId,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        userId: order.customerId,
        providerPaymentId,
        amountInPaise: AMOUNT,
        currency: "INR",
        status: "requested",
        reason: "customer_cancelled",
        source: "cancellation",
        initiatedBy: actorId,
        initiatedByRole: "customer",
        submitAttempts: 0,
        attentionRequired: false,
      });
      // Nothing the provider would have said: the refund has not been submitted.
      for (const field of ["providerRefundId", "providerStatus", "pendingAt", "processedAt", "failedAt", "lastSubmitAt"]) {
        expect(refund[field]).toBeUndefined();
      }
      expect(Object.values(refund).every((value) => value !== undefined)).toBe(true);
    });

    it("uses one value for the refund ID and the provider idempotency key, stable across a repeat", async () => {
      const order = await seedPaidOrder(orgA);

      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      const first = (await refundsOf(order))[0];
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      const second = (await refundsOf(order))[0];

      expect(first.id).toBe(refundIdFor(order.id, 1));
      expect(first.idempotencyKey).toBe(first.id);
      expect(second).toEqual(first);
    });

    it("refunds the entire remaining amount: earlier processed money is not refunded again", async () => {
      const order = await seedPaidOrder(orgA, "confirmed", {
        set: {capturedAmountInPaise: AMOUNT, refundedAmountInPaise: 3000, refundSeq: 1, refundState: "partially_refunded"},
      });
      await order.ref.update({refundStatus: "partially_refunded", refundedInPaise: 3000});
      // The earlier, processed refund (r1), as a later checkpoint will have left it.
      await paymentRef(order).collection("refunds").doc(`${order.id}-r1`).set({
        id: `${order.id}-r1`, orderId: order.id, amountInPaise: 3000, status: "processed",
      });

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result.refund).toEqual({refundId: `${order.id}-r2`, amountInPaise: 7000});
      expect(await rawPayment(order)).toMatchObject({
        capturedAmountInPaise: AMOUNT, refundedAmountInPaise: 3000, refundPendingInPaise: 7000, refundSeq: 2, refundState: "in_progress",
      });
      expect(await rawOrder(order)).toMatchObject({refundStatus: "in_progress", refundedInPaise: 3000});
      await expectConsistent(order);
    });

    it("cannot reserve more than remains: a fully reserved payment still cancels, with no second refund", async () => {
      const order = await seedPaidOrder(orgA, "confirmed", {
        set: {capturedAmountInPaise: AMOUNT, refundPendingInPaise: AMOUNT, refundSeq: 1, refundState: "in_progress"},
      });
      await paymentRef(order).collection("refunds").doc(`${order.id}-r1`).set({
        id: `${order.id}-r1`, orderId: order.id, amountInPaise: AMOUNT, status: "requested",
      });

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result).toMatchObject({changed: true, refund: null});
      expect(await refundsOf(order)).toHaveLength(1);
      expect(await rawPayment(order)).toMatchObject({refundPendingInPaise: AMOUNT, refundSeq: 1});
      // The cancelled order mirrors the payment's figures, in the same transaction.
      expect(await rawOrder(order)).toMatchObject({status: "cancelled", refundStatus: "in_progress", refundedInPaise: 0});
      await expectConsistent(order);
    });

    it("keeps a legacy payment (no captured amount, no refund fields) compatible, and normalizes it", async () => {
      const order = await seedPaidOrder(orgA, "confirmed", {}, true);
      const legacy = await rawPayment(order);
      for (const field of ["capturedAmountInPaise", "refundedAmountInPaise", "refundPendingInPaise", "refundSeq", "refundState"]) {
        expect(legacy[field]).toBeUndefined();
      }

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result.refund).toEqual({refundId: refundIdFor(order.id, 1), amountInPaise: AMOUNT});
      expect(await rawPayment(order)).toMatchObject({
        status: "succeeded",
        capturedAmountInPaise: AMOUNT,
        refundedAmountInPaise: 0,
        refundPendingInPaise: AMOUNT,
        refundSeq: 1,
        refundState: "in_progress",
      });
      await expectConsistent(order);
    });

    it("writes the refund, the payment aggregates and the order together (the order mirror matches the payment)", async () => {
      const order = await seedPaidOrder(orgA, "preparing");

      await cancelOrder(db, {
        actor: organization(member(orgA.organizationId, "owner")), orderId: order.id, reason: "item_unavailable",
      });

      expect(await rawOrder(order)).toMatchObject({status: "cancelled", refundStatus: "in_progress", refundedInPaise: 0});
      expect(await rawPayment(order)).toMatchObject({refundState: "in_progress", refundPendingInPaise: AMOUNT});
      await expectConsistent(order);
    });

    describe("an inconsistent payment is refused, never refunded or cancelled on a guess", () => {
      const refuse = async (order: SeededOrder, actor: CancellationActor = customer(order), reason?: OrderCancellationReason) => {
        const orderBefore = await rawOrder(order);
        const error = await rejectionOf(cancelOrder(db, {actor, orderId: order.id, reason}));
        expect(error.httpErrorCode.status).toBe(409);
        expect(await rawOrder(order)).toEqual(orderBefore);
        expect(await refundsOf(order)).toEqual([]);
      };

      it("a confirmed order whose payment document is missing", async () => {
        await refuse(await seedOrder({org: orgA, status: "confirmed", paymentStatus: "paid"}));
      });

      it("a confirmed order whose payment is still pending", async () => {
        const order = await seedOrder({org: orgA, status: "confirmed", paymentStatus: "paid"});
        await seedPayment(order, {set: {status: "pending"}, omit: ["providerPaymentId"]});
        await refuse(order);
      });

      it("a confirmed order whose payment failed", async () => {
        const order = await seedOrder({org: orgA, status: "confirmed", paymentStatus: "paid"});
        await seedPayment(order, {set: {status: "failed"}});
        await refuse(order);
      });

      it("a paid status whose order says the payment is pending", async () => {
        const order = await seedOrder({org: orgA, status: "confirmed", paymentStatus: "pending"});
        await seedPayment(order);
        await refuse(order);
      });

      it("a pending_payment order whose payment already succeeded", async () => {
        const order = await seedOrder({org: orgA, status: "pending_payment"});
        await seedPayment(order);
        await refuse(order);
      });

      it("a succeeded payment with no provider payment ID: the provider cannot be asked to refund it", async () => {
        const order = await seedPaidOrder(orgA, "confirmed", {omit: ["providerPaymentId"]});
        await refuse(order);
        await refuse(order, organization(member(orgA.organizationId, "owner")), "outlet_closed");
      });

      it("a succeeded payment in another currency", async () => {
        await refuse(await seedPaidOrder(orgA, "confirmed", {set: {currency: "USD"}}));
      });

      it("a succeeded payment whose amount is not the order's total", async () => {
        await refuse(await seedPaidOrder(orgA, "confirmed", {set: {amountInPaise: 9000}}));
      });

      it("a payment whose refund figures exceed what was captured", async () => {
        await refuse(await seedPaidOrder(orgA, "confirmed", {
          set: {capturedAmountInPaise: AMOUNT, refundedAmountInPaise: 8000, refundPendingInPaise: 8000},
        }));
      });

      it("a refund slot that is already taken although the payment says none was made", async () => {
        const order = await seedPaidOrder(orgA);
        await paymentRef(order).collection("refunds").doc(`${order.id}-r1`).set({id: `${order.id}-r1`, status: "requested"});
        const orderBefore = await rawOrder(order);
        const paymentBefore = await rawPayment(order);

        await expect(cancelOrder(db, {actor: customer(order), orderId: order.id})).rejects.toThrow(/already exists/);

        expect(await rawOrder(order)).toEqual(orderBefore);
        expect(await rawPayment(order)).toEqual(paymentBefore);
      });
    });

    it("fails loudly (nothing written) for a pending_payment order whose payment document is malformed", async () => {
      const order = await seedOrder({org: orgA, status: "pending_payment"});
      await seedPayment(order, {set: {status: "pending", amountInPaise: "free"}});
      const before = await rawOrder(order);

      await expect(cancelOrder(db, {actor: customer(order), orderId: order.id})).rejects.toThrow(/Malformed payment/);

      expect(await rawOrder(order)).toEqual(before);
    });
  });

  describe("the response summary of the refund", () => {
    it("summarizes a refund this call reserved: status, amount, currency and when it started — and nothing else", async () => {
      const order = await seedPaidOrder(orgA);

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      const stored = (await refundsOf(order))[0];
      expect(result.refundSummary).toEqual({
        status: "requested",
        amountInPaise: AMOUNT,
        currency: "INR",
        initiatedAt: (stored.createdAt as Timestamp).toDate().toISOString(),
      });
      expect(Object.keys(result.refundSummary ?? {}).sort()).toEqual(["amountInPaise", "currency", "initiatedAt", "status"]);
    });

    it("has no refund summary when no money was captured", async () => {
      const order = await seedPendingOrder(orgA);

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result.refundSummary).toBeNull();
    });

    it("gives the same summary to a repeat of the cancellation", async () => {
      const order = await seedPaidOrder(orgA);
      const first = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      const again = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(again.changed).toBe(false);
      expect(again.refundSummary).toEqual(first.refundSummary);
    });

    it("summarizes the refund of a late capture when the cancellation is repeated", async () => {
      const order = await seedPendingOrder(orgA);
      const first = await cancelOrder(db, {actor: customer(order), orderId: order.id});
      expect(first.refundSummary).toBeNull();
      await capture(order);

      const again = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(again.refundSummary).toMatchObject({status: "requested", amountInPaise: AMOUNT, currency: "INR"});
    });

    it("reports completedAt once the refund is processed, and never the provider's identifiers", async () => {
      const order = await seedPaidOrder(orgA, "confirmed", {
        set: {capturedAmountInPaise: AMOUNT, refundedAmountInPaise: AMOUNT, refundSeq: 1, refundState: "refunded"},
      });
      const processedAt = Timestamp.fromDate(new Date("2026-09-02T08:30:00Z"));
      await seedRefund(order, 1, "processed", {providerRefundId: "rfnd_secret_1", providerStatus: "processed", processedAt});
      await order.ref.update({refundStatus: "refunded", refundedInPaise: AMOUNT});

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result).toMatchObject({changed: true, refund: null});
      expect(result.refundSummary).toEqual({
        status: "processed",
        amountInPaise: AMOUNT,
        currency: "INR",
        initiatedAt: CREATED_AT.toDate().toISOString(),
        completedAt: processedAt.toDate().toISOString(),
      });
      expect(JSON.stringify(result.refundSummary)).not.toMatch(/rfnd_secret_1|pay_seeded|idempotency|initiatedBy/);
    });

    it("summarizes the LATEST refund when an earlier one failed", async () => {
      const order = await seedPaidOrder(orgA, "confirmed", {
        set: {capturedAmountInPaise: AMOUNT, refundPendingInPaise: AMOUNT, refundSeq: 2, refundState: "in_progress"},
      });
      await seedRefund(order, 1, "failed", {failedAt: CREATED_AT, failureCode: "bank_declined"});
      await seedRefund(order, 2, "pending", {providerRefundId: "rfnd_2", pendingAt: CREATED_AT});
      await order.ref.update({refundStatus: "in_progress", refundedInPaise: 0});

      const result = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(result.refundSummary).toMatchObject({status: "pending", amountInPaise: AMOUNT});
      expect(result.refundSummary?.completedAt).toBeUndefined();
    });

    it("leaves a malformed latest refund out of the summary instead of failing a repeat", async () => {
      const order = await seedPaidOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      await paymentRef(order).collection("refunds").doc(`${order.id}-r1`).update({status: "teleported"});

      const again = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(again).toMatchObject({changed: false, refundSummary: null});
    });
  });

  describe("payment capture", () => {
    it("writes the captured amount atomically with every new success, and confirms as before", async () => {
      const order = await seedPendingOrder(orgA);

      const result = await capture(order);

      expect(result.order.status).toBe("confirmed");
      expect(result.refundId).toBeUndefined();
      expect(await rawPayment(order)).toMatchObject({
        status: "succeeded", capturedAmountInPaise: AMOUNT, providerPaymentId: "pay_captured_1",
      });
      expect(await rawOrder(order)).toMatchObject({status: "confirmed", paymentStatus: "paid"});
      expect((await rawOrder(order)).refundStatus).toBeUndefined();
      expect(await refundsOf(order)).toEqual([]);
      // Contrast with a late capture: a live success DOES record the order_confirmed event.
      expect(await notificationEventsOf(order)).toEqual([`${order.id}_order_confirmed`]);
    });

    it("a replayed success is a no-op that changes nothing", async () => {
      const order = await seedPendingOrder(orgA);
      await capture(order);
      const orderBefore = await rawOrder(order);
      const paymentBefore = await rawPayment(order);

      const again = await capture(order);

      expect(again.refundId).toBeUndefined();
      expect(await rawOrder(order)).toEqual(orderBefore);
      expect(await rawPayment(order)).toEqual(paymentBefore);
    });

    it("never writes a captured amount that is not the payment amount", async () => {
      const order = await seedPendingOrder(orgA);

      const error = await rejectionOf(capture(order, {amountInPaise: AMOUNT - 1}));

      expect(error.httpErrorCode.status).toBe(400);
      expect((await rawPayment(order)).capturedAmountInPaise).toBeUndefined();
      expect((await rawPayment(order)).status).toBe("pending");
    });
  });

  describe("late capture after cancellation", () => {
    it("records the capture, keeps the order cancelled but paid, and reserves the whole amount for a refund", async () => {
      const order = await seedPendingOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "changed_my_mind"});
      const cancelled = await rawOrder(order);
      expect(cancelled.paymentStatus).toBe("pending");

      const result = await capture(order);

      expect(result.refundId).toBe(refundIdFor(order.id, 1));
      expect(result.order.status).toBe("cancelled");
      expect(result.payment.status).toBe("succeeded");

      // The payment: succeeded, captured, the whole amount reserved.
      expect(await rawPayment(order)).toMatchObject({
        status: "succeeded",
        capturedAmountInPaise: AMOUNT,
        providerPaymentId: "pay_captured_1",
        refundedAmountInPaise: 0,
        refundPendingInPaise: AMOUNT,
        refundSeq: 1,
        refundState: "in_progress",
      });
      // The order: still CANCELLED (never reopened or confirmed), now PAID — the money was captured —
      // with its cancellation audit fields untouched; only paymentStatus, the mirror and updatedAt moved.
      const after = await rawOrder(order);
      expect(after).toMatchObject({status: "cancelled", paymentStatus: "paid", refundStatus: "in_progress", refundedInPaise: 0});
      expect(result.order).toMatchObject({status: "cancelled", paymentStatus: "paid"});
      expect(without(after, ["paymentStatus", "refundStatus", "refundedInPaise", "updatedAt"]))
        .toEqual(without(cancelled, ["paymentStatus", "updatedAt"]));
      // No order_confirmed (or any order) event was written; the refund's own `refund_requested` was.
      expect(await notificationEventsOf(order)).toEqual([]);
      expect(await refundEventsOf(order)).toEqual([`${order.id}-r1_refund_requested`]);
      // The refund: requested, ready for the provider-dispatch checkpoint, started by the system.
      const refunds = await refundsOf(order);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        id: `${order.id}-r1`,
        idempotencyKey: `${order.id}-r1`,
        paymentId: order.id,
        orderId: order.id,
        userId: order.customerId,
        providerPaymentId: "pay_captured_1",
        amountInPaise: AMOUNT,
        status: "requested",
        reason: "late_capture_after_cancel",
        source: "cancellation",
        initiatedBy: "system",
        initiatedByRole: "system",
        submitAttempts: 0,
        attentionRequired: false,
      });
      await expectConsistent(order);
    });

    it("handles an order that was cancelled without audit fields, and a payment that had failed before", async () => {
      const order = await seedOrder({org: orgA, status: "cancelled", paymentStatus: "pending"});
      await seedPayment(order, {set: {status: "failed"}});

      const result = await capture(order);

      expect(result.refundId).toBe(`${order.id}-r1`);
      expect(await rawOrder(order)).toMatchObject({status: "cancelled", paymentStatus: "paid", refundStatus: "in_progress"});
      await expectConsistent(order);
    });

    it("is idempotent: a duplicate capture creates no second refund and changes nothing", async () => {
      const order = await seedPendingOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      await capture(order);
      const orderBefore = await rawOrder(order);
      const paymentBefore = await rawPayment(order);

      const again = await capture(order);

      expect(again.refundId).toBeUndefined();
      expect(await refundsOf(order)).toHaveLength(1);
      expect(await rawOrder(order)).toEqual(orderBefore);
      expect(await rawPayment(order)).toEqual(paymentBefore);
      expect(await notificationEventsOf(order)).toEqual([]);
      expect(await refundEventsOf(order)).toEqual([`${order.id}-r1_refund_requested`]);
    });

    it("a late payment.failed cannot regress the succeeded payment, the paid order or the refund", async () => {
      const order = await seedPendingOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      await capture(order);
      const orderBefore = await rawOrder(order);
      const paymentBefore = await rawPayment(order);
      const refundsBefore = await refundsOf(order);

      const after = await markPaymentFailed(db, {orderId: order.id, paymentId: order.id, providerPaymentId: "pay_failed_late"});

      expect(after.status).toBe("succeeded");
      expect(await rawPayment(order)).toEqual(paymentBefore);
      expect(await rawOrder(order)).toEqual(orderBefore);
      expect(await refundsOf(order)).toEqual(refundsBefore);
      expect(await rawOrder(order)).toMatchObject({status: "cancelled", paymentStatus: "paid"});
    });

    it("does not make a later cancellation request create another refund", async () => {
      const order = await seedPendingOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      await capture(order);

      const again = await cancelOrder(db, {actor: customer(order), orderId: order.id});

      expect(again).toMatchObject({changed: false, refund: null});
      expect(await refundsOf(order)).toHaveLength(1);
      await expectConsistent(order);
    });

    it("refuses a capture of the wrong amount or currency, writing nothing", async () => {
      const order = await seedPendingOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      const orderBefore = await rawOrder(order);
      const paymentBefore = await rawPayment(order);

      for (const overrides of [{amountInPaise: 1}, {currency: "USD"}]) {
        const error = await rejectionOf(capture(order, overrides));
        expect(error.httpErrorCode.status).toBe(400);
      }

      expect(await rawOrder(order)).toEqual(orderBefore);
      expect(await rawPayment(order)).toEqual(paymentBefore);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("refuses a capture that cannot be refunded (no provider payment ID), writing nothing", async () => {
      const order = await seedPendingOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});
      const paymentBefore = await rawPayment(order);

      const error = await rejectionOf(capture(order, {providerPaymentId: undefined}));

      expect(error.httpErrorCode.status).toBe(400);
      expect(await rawPayment(order)).toEqual(paymentBefore);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("still refuses to confirm an order that is neither pending_payment nor cancelled", async () => {
      const order = await seedOrder({org: orgA, status: "preparing", paymentStatus: "paid"});
      await seedPayment(order, {set: {status: "failed"}});

      const error = await rejectionOf(capture(order));

      expect(error.httpErrorCode.status).toBe(400);
      expect(await refundsOf(order)).toEqual([]);
    });
  });

  describe("races", {timeout: 60000}, () => {
    it("a cancellation racing a payment success ends cancelled, captured, with exactly one full refund", async () => {
      for (let round = 0; round < 6; round++) {
        const order = await seedPendingOrder(orgA);

        await Promise.all([
          settled(() => cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "changed_my_mind"})),
          settled(() => capture(order)),
        ]);

        // Whichever committed first, the other saw it: the order is cancelled, the
        // money was captured, and it is being refunded exactly once, in full.
        const after = await rawOrder(order);
        expect(after).toMatchObject({status: "cancelled", paymentStatus: "paid"});
        expect(await rawPayment(order)).toMatchObject({status: "succeeded", capturedAmountInPaise: AMOUNT, refundPendingInPaise: AMOUNT});
        const refunds = await refundsOf(order);
        expect(refunds).toHaveLength(1);
        expect(refunds[0].amountInPaise).toBe(AMOUNT);
        expect(["customer_cancelled", "late_capture_after_cancel"]).toContain(refunds[0].reason);
        // The order was confirmed (and its event recorded) only if the capture committed first; a
        // late capture, which the cancellation beat, never confirms anything.
        expect(await notificationEventsOf(order)).toEqual(
          refunds[0].reason === "late_capture_after_cancel" ? [] : [`${order.id}_order_confirmed`],
        );
        // One cancellation's audit data, whole.
        expect(after).toMatchObject({cancelledBy: order.customerId, cancelledByRole: "customer", cancellationReason: "changed_my_mind"});
        await expectConsistent(order);
      }
    });

    it("duplicate cancellations: one wins, one refund, one set of audit data", async () => {
      const order = await seedPaidOrder(orgA);

      const results = await Promise.all(
        Array.from({length: 6}, () => settled(() => cancelOrder(db, {
          actor: customer(order), orderId: order.id, reason: "changed_my_mind",
        }))),
      );

      expect(results.filter((result) => result.changed)).toHaveLength(1);
      expect(results.filter((result) => result.refund !== null)).toHaveLength(1);
      expect(await refundsOf(order)).toHaveLength(1);
      expect(await rawPayment(order)).toMatchObject({refundPendingInPaise: AMOUNT, refundSeq: 1});
      await expectConsistent(order);
    });

    it("a customer and the organization cancelling at once never mix their audit data", async () => {
      const order = await seedPaidOrder(orgA);
      const owner = member(orgA.organizationId, "owner");

      const results = await Promise.all([
        settled(() => cancelOrder(db, {actor: customer(order), orderId: order.id, reason: "changed_my_mind"})),
        settled(() => cancelOrder(db, {actor: organization(owner), orderId: order.id, reason: "outlet_closed"})),
      ]);

      expect(results.filter((result) => result.changed)).toHaveLength(1);
      const after = await rawOrder(order);
      const refund = (await refundsOf(order))[0];
      if (after.cancelledByRole === "customer") {
        expect(after).toMatchObject({cancelledBy: order.customerId, cancellationReason: "changed_my_mind"});
        expect(refund).toMatchObject({reason: "customer_cancelled", initiatedBy: order.customerId});
      } else {
        expect(after).toMatchObject({cancelledBy: owner.userId, cancelledByRole: "organization", cancellationReason: "outlet_closed"});
        expect(refund).toMatchObject({reason: "outlet_cancelled", initiatedBy: owner.userId});
      }
      expect(await refundsOf(order)).toHaveLength(1);
      await expectConsistent(order);
    });

    it("duplicate late-capture processing creates one refund", async () => {
      const order = await seedPendingOrder(orgA);
      await cancelOrder(db, {actor: customer(order), orderId: order.id});

      const results = await Promise.all(Array.from({length: 6}, () => settled(() => capture(order))));

      expect(results.filter((result) => result.refundId !== undefined)).toHaveLength(1);
      expect(await refundsOf(order)).toHaveLength(1);
      expect(await rawOrder(order)).toMatchObject({status: "cancelled", paymentStatus: "paid"});
      expect(await notificationEventsOf(order)).toEqual([]);
      expect(await refundEventsOf(order)).toEqual([`${order.id}-r1_refund_requested`]);
      expect(await rawPayment(order)).toMatchObject({refundPendingInPaise: AMOUNT, refundSeq: 1});
      await expectConsistent(order);
    });

    it("duplicate success of a live payment confirms once and refunds nothing", async () => {
      const order = await seedPendingOrder(orgA);

      await Promise.all(Array.from({length: 4}, () => settled(() => capture(order))));

      expect(await rawOrder(order)).toMatchObject({status: "confirmed"});
      expect(await refundsOf(order)).toEqual([]);
    });

    it("a customer's cancellation racing the start of preparation: either the order is refunded or it is being prepared, never both", async () => {
      for (let round = 0; round < 4; round++) {
        const order = await seedPaidOrder(orgA);
        const staff = member(orgA.organizationId, "staff");

        const [cancelled, prepared] = await Promise.allSettled([
          settled(() => cancelOrder(db, {actor: customer(order), orderId: order.id})),
          settled(() => transitionOrderStatus(db, {membership: staff, orderId: order.id, to: "preparing"})),
        ]);

        const status = (await rawOrder(order)).status;
        const refunds = await refundsOf(order);
        if (status === "cancelled") {
          expect(cancelled.status).toBe("fulfilled");
          expect(prepared.status).toBe("rejected");
          expect(refunds).toHaveLength(1);
        } else {
          expect(status).toBe("preparing");
          expect(cancelled.status).toBe("rejected");
          expect(prepared.status).toBe("fulfilled");
          expect(refunds).toHaveLength(0);
        }
        await expectConsistent(order);
      }
    });
  });
});

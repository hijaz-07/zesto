// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import {businessDateString} from "../time";
import {createMenu} from "./menus";
import {handleNotificationEventCreated} from "./notificationEventTrigger";
import * as notificationEvents from "./notificationEvents";
import {
  NOTIFICATION_EVENTS_COLLECTION,
  buildCancellationNotificationEvent,
  buildRefundNotificationEvent,
  type NotificationEvent,
} from "./notificationEvents";
import {processNotificationEvent} from "./notificationProcessor";
import {
  customerScope,
  markNotificationRead,
  notificationId,
  notificationsCollection,
  organizationScope,
  parseNotification,
  toNotificationResponse,
} from "./notifications";
import {cancelOrder} from "./orderCancellation";
import type {Order, OrderStatus} from "./orders";
import {createOrganization} from "./organizations";
import {createOutlet} from "./outlets";
import {receiveRazorpayWebhook} from "./razorpayWebhooks";
import {
  cleanupScenarios,
  seedScenario,
  type Scenario,
} from "./refundScenario.fake";
import type {Refund} from "./refunds";

/**
 * Cancellation and refund NOTIFICATIONS (Checkpoint 7.6) against a REAL Firestore emulator:
 * the producers (the cancelling transaction writes the cancellation's outbox event, and never
 * a refund event for an unpaid order), the policy as the processor applies it (who is told what,
 * role by role), `refund_requested` consumed without any inbox document, idempotency and
 * `readAt` preservation, privacy, and malformed events. The cancellations and the refund
 * webhooks are the REAL ones; only the cases that need an impossible state hand-write an event.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// Wraps (does not replace) the real recorder, so one test can make exactly one call throw.
vi.mock("./notificationEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notificationEvents")>();
  return {...actual, recordCancellationNotificationEvent: vi.fn(actual.recordCancellationNotificationEvent)};
});

const PROJECT_ID = "demo-zesto-cancellation-notifications";
let db: Firestore;

vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

// Everything a test creates outside the refund scenario kit, deleted afterwards.
const created: DocumentReference[] = [];
const orderRefs: DocumentReference[] = [];
const usersTouched = new Set<string>();

afterEach(async () => {
  vi.mocked(notificationEvents.recordCancellationNotificationEvent).mockClear();
  await cleanupScenarios(db);
  for (const ref of orderRefs.splice(0)) {
    await db.recursiveDelete(ref);
  }
  for (const userId of usersTouched) {
    await db.recursiveDelete(db.collection("users").doc(userId));
  }
  usersTouched.clear();
  await Promise.all(created.splice(0).map((ref) => ref.delete()));
  const events = await db.collection(NOTIFICATION_EVENTS_COLLECTION).get();
  await Promise.all(events.docs.map((doc) => doc.ref.delete()));
});

const freshUserId = () => `U-${randomUUID()}`;

// ---------------------------------------------------------------- fixtures

interface OrgFixture {
  organizationId: string;
  outletId: string;
  menuId: string;
  ownerId: string;
}

async function buildOrg(outletName = "Main Canteen"): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const suffix = randomUUID();
  const {organization} = await createOrganization(db, ownerId, {name: `Org ${suffix}`, slug: `cn-org-${suffix}`});
  const outlet = await createOutlet(db, organization.id, ownerId, {name: outletName, slug: `outlet-${randomUUID()}`});
  const now = Date.now();
  const menu = await createMenu(db, organization.id, outlet.id, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 3_600_000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 3_600_000)),
    pickupStartsAt: Timestamp.fromDate(new Date(now + 24 * 3_600_000)),
    pickupEndsAt: Timestamp.fromDate(new Date(now + 28 * 3_600_000)),
  });
  usersTouched.add(ownerId);
  return {organizationId: organization.id, outletId: outlet.id, menuId: menu.id, ownerId};
}

async function addMember(
  organizationId: string,
  role: OrganizationMemberRole,
  status: "active" | "invited" | "revoked" = "active",
): Promise<string> {
  const userId = freshUserId();
  usersTouched.add(userId);
  const ref = db.collection("organizations").doc(organizationId).collection("members").doc(userId);
  created.push(ref);
  await ref.set({userId, organizationId, role, status, createdAt: Timestamp.now()});
  return userId;
}

const membership = (organizationId: string, userId: string, role: OrganizationMemberRole = "owner"): OrganizationMembership =>
  ({userId, organizationId, role, status: "active"});

const AMOUNT = 10000;
const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
  org: OrgFixture;
}

/** A paid, confirmed order exactly as a captured payment leaves it, or an unpaid pending one. */
async function seedOrder(org: OrgFixture, paid: boolean): Promise<SeededOrder> {
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(org.outletId)
    .collection("menus").doc(org.menuId)
    .collection("orders").doc();
  orderRefs.push(ref);
  const customerId = freshUserId();
  usersTouched.add(customerId);
  const status: OrderStatus = paid ? "confirmed" : "pending_payment";
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId: org.menuId,
    status,
    paymentStatus: paid ? "paid" : "pending",
    currency: "INR",
    subtotalInPaise: AMOUNT,
    totalInPaise: AMOUNT,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: AMOUNT}],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await ref.collection("payments").doc(ref.id).create({
    id: ref.id,
    orderId: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId: org.menuId,
    amountInPaise: AMOUNT,
    currency: "INR",
    status: paid ? "succeeded" : "pending",
    provider: "razorpay",
    providerOrderId: `order_${randomUUID().slice(0, 14)}`,
    ...(paid ? {providerPaymentId: `pay_${randomUUID().slice(0, 14)}`, capturedAmountInPaise: AMOUNT} : {}),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return {id: ref.id, ref, customerId, org};
}

type EventDoc = Record<string, unknown>;

async function eventsOf(orderId: string): Promise<Record<string, EventDoc>> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", orderId).get();
  return Object.fromEntries(snapshot.docs.map((doc) => [doc.id, doc.data()]));
}

const eventIdsOf = async (orderId: string) => Object.keys(await eventsOf(orderId)).sort();

async function eventDoc(eventId: string): Promise<EventDoc> {
  return (await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).get()).data() ?? {};
}

/** A user's whole inbox, parsed (and registered for cleanup through `usersTouched`). */
async function inbox(userId: string) {
  usersTouched.add(userId);
  const snapshot = await notificationsCollection(db, userId).get();
  return snapshot.docs.map((doc) => parseNotification(doc.data(), doc.id));
}

async function inboxTypes(userId: string): Promise<string[]> {
  return (await inbox(userId)).map((notification) => notification.type).sort();
}

async function notificationsForEvent(eventId: string) {
  return (await db.collectionGroup("notifications").where("eventId", "==", eventId).get()).docs;
}

// ---------------------------------------------------------------- producers

describe("cancellation events are produced in the cancelling transaction", () => {
  it("a customer cancelling an UNPAID order writes order_cancelled_by_customer and NO refund event", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, false);

    const result = await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});

    expect(result.refund).toBeNull();
    expect(await eventIdsOf(order.id)).toEqual([`${order.id}_order_cancelled_by_customer`]);
    const event = await eventDoc(`${order.id}_order_cancelled_by_customer`);
    expect(event).toMatchObject({
      id: `${order.id}_order_cancelled_by_customer`,
      type: "order_cancelled_by_customer",
      orderId: order.id,
      organizationId: org.organizationId,
      outletId: org.outletId,
      menuId: org.menuId,
      customerUserId: order.customerId,
      status: "pending",
      attempts: 0,
      refundInitiated: false,
    });
    expect((event.occurredAt as Timestamp).isEqual((await order.ref.get()).data()?.cancelledAt as Timestamp)).toBe(true);
    expect((await order.ref.collection("payments").doc(order.id).collection("refunds").get()).size).toBe(0);
  });

  it("a customer cancelling a PAID order writes the cancellation event AND a separate refund_requested", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);

    const result = await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id, reason: "changed_my_mind"});

    expect(result.refund?.refundId).toBe(`${order.id}-r1`);
    expect(await eventIdsOf(order.id)).toEqual([
      `${order.id}-r1_refund_requested`,
      `${order.id}_order_cancelled_by_customer`,
    ]);
    expect(await eventDoc(`${order.id}_order_cancelled_by_customer`)).toMatchObject({refundInitiated: true, status: "pending"});
    expect(await eventDoc(`${order.id}-r1_refund_requested`)).toMatchObject({
      type: "refund_requested", refundId: `${order.id}-r1`, status: "pending",
    });
  });

  it("an organization owner cancelling writes order_cancelled_by_outlet (with and without a refund)", async () => {
    const org = await buildOrg();
    const paid = await seedOrder(org, true);
    const unpaid = await seedOrder(org, false);
    const actor = {kind: "organization" as const, membership: membership(org.organizationId, org.ownerId)};

    await cancelOrder(db, {actor, orderId: paid.id, reason: "outlet_closed"});
    await cancelOrder(db, {actor, orderId: unpaid.id, reason: "duplicate_order"});

    expect(await eventIdsOf(paid.id)).toEqual([`${paid.id}-r1_refund_requested`, `${paid.id}_order_cancelled_by_outlet`]);
    expect(await eventDoc(`${paid.id}_order_cancelled_by_outlet`)).toMatchObject({type: "order_cancelled_by_outlet", refundInitiated: true});
    expect(await eventIdsOf(unpaid.id)).toEqual([`${unpaid.id}_order_cancelled_by_outlet`]);
    expect(await eventDoc(`${unpaid.id}_order_cancelled_by_outlet`)).toMatchObject({refundInitiated: false});
  });

  it("a repeated cancellation adds no event and leaves the first one untouched", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    const actor = {kind: "customer" as const, userId: order.customerId};

    await cancelOrder(db, {actor, orderId: order.id});
    const first = await eventsOf(order.id);
    const again = await cancelOrder(db, {actor, orderId: order.id});

    expect(again.changed).toBe(false);
    expect(await eventsOf(order.id)).toEqual(first);
  });

  it("a refused cancellation writes no event", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    const staff = await addMember(org.organizationId, "staff");
    const stranger = freshUserId();

    await expect(cancelOrder(db, {
      actor: {kind: "organization", membership: membership(org.organizationId, staff, "staff")},
      orderId: order.id, reason: "outlet_closed",
    })).rejects.toMatchObject({httpErrorCode: {status: 403}});
    await expect(cancelOrder(db, {actor: {kind: "customer", userId: stranger}, orderId: order.id})).rejects.toMatchObject({
      httpErrorCode: {status: 404},
    });

    expect(await eventIdsOf(order.id)).toEqual([]);
    expect((await order.ref.get()).data()?.status).toBe("confirmed");
  });

  it("is atomic: if the event cannot be written the order is not cancelled and nothing is reserved", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    vi.mocked(notificationEvents.recordCancellationNotificationEvent).mockImplementationOnce(() => {
      throw new Error("event write failed");
    });

    await expect(cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id})).rejects.toThrow(
      "event write failed",
    );

    expect((await order.ref.get()).data()?.status).toBe("confirmed");
    expect(await eventIdsOf(order.id)).toEqual([]);
    expect((await order.ref.collection("payments").doc(order.id).collection("refunds").get()).size).toBe(0);
  });

  it("stores only IDs and flags: no copy, no amounts, no provider or contact data", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});

    const event = await eventDoc(`${order.id}_order_cancelled_by_customer`);
    expect(Object.keys(event).sort()).toEqual([
      "attempts", "customerUserId", "id", "menuId", "occurredAt", "orderId", "organizationId", "outletId",
      "refundInitiated", "status", "type",
    ]);
  });
});

// ---------------------------------------------------------------- policy via the processor

describe("a customer's cancellation tells the organization, not the customer", () => {
  it("every active owner, manager and staff member gets one notification; nobody else does", async () => {
    const org = await buildOrg();
    const manager = await addMember(org.organizationId, "manager");
    const staff = await addMember(org.organizationId, "staff");
    const invited = await addMember(org.organizationId, "staff", "invited");
    const revoked = await addMember(org.organizationId, "manager", "revoked");
    const other = await buildOrg();
    const order = await seedOrder(org, false);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    const eventId = `${order.id}_order_cancelled_by_customer`;

    const result = await processNotificationEvent(db, eventId);

    // The owner is a member document too (createOrganization wrote it): owner + manager + staff.
    expect(result).toEqual({kind: "processed", delivered: 3});
    for (const userId of [org.ownerId, manager, staff]) {
      const [note] = await inbox(userId);
      expect(note).toMatchObject({
        id: notificationId(eventId, "org"),
        type: "order_cancelled_by_customer",
        scope: organizationScope(org.organizationId),
        title: "Order cancelled",
        body: "An order from Main Canteen was cancelled by the customer.",
        orderId: order.id,
        readAt: null,
      });
    }
    expect(await inbox(order.customerId)).toEqual([]);
    expect(await inbox(invited)).toEqual([]);
    expect(await inbox(revoked)).toEqual([]);
    expect(await inbox(other.ownerId)).toEqual([]);
    expect((await eventDoc(eventId)).status).toBe("processed");
  });

  it("a paid cancellation's refund_requested is consumed as processed, creating NO inbox document for anyone", async () => {
    const org = await buildOrg();
    const staff = await addMember(org.organizationId, "staff");
    const order = await seedOrder(org, true);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    const requestedId = `${order.id}-r1_refund_requested`;

    const result = await processNotificationEvent(db, requestedId);

    expect(result).toEqual({kind: "processed", delivered: 0});
    expect(await eventDoc(requestedId)).toMatchObject({status: "processed", attempts: 1});
    expect((await eventDoc(requestedId)).processedAt).toBeInstanceOf(Timestamp);
    expect(await notificationsForEvent(requestedId)).toEqual([]);
    for (const userId of [order.customerId, org.ownerId, staff]) {
      expect(await inbox(userId)).toEqual([]);
    }
  });
});

describe("an outlet's cancellation tells the customer, not the organization", () => {
  it("a paid cancellation says a refund was initiated, and shows no provider detail", async () => {
    const org = await buildOrg();
    const staff = await addMember(org.organizationId, "staff");
    const order = await seedOrder(org, true);
    await cancelOrder(db, {
      actor: {kind: "organization", membership: membership(org.organizationId, org.ownerId)},
      orderId: order.id, reason: "item_unavailable",
    });
    const eventId = `${order.id}_order_cancelled_by_outlet`;

    expect(await processNotificationEvent(db, eventId)).toEqual({kind: "processed", delivered: 1});

    const [note] = await inbox(order.customerId);
    expect(note).toMatchObject({
      id: notificationId(eventId, "customer"),
      type: "order_cancelled_by_outlet",
      scope: customerScope(),
      title: "Order cancelled",
      body: "Your order from Main Canteen was cancelled by the outlet. A refund has been initiated.",
      orderId: order.id,
    });
    expect(`${note.title} ${note.body}`).not.toMatch(/rfnd|pay_|order_|razorpay|₹|\d{4,}/i);
    expect(await inbox(org.ownerId)).toEqual([]);
    expect(await inbox(staff)).toEqual([]);
  });

  it("an unpaid cancellation does not mention a refund", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, false);
    await cancelOrder(db, {
      actor: {kind: "organization", membership: membership(org.organizationId, org.ownerId)},
      orderId: order.id, reason: "outlet_closed",
    });

    await processNotificationEvent(db, `${order.id}_order_cancelled_by_outlet`);

    const [note] = await inbox(order.customerId);
    expect(note.body).toBe("Your order from Main Canteen was cancelled by the outlet.");
  });
});

describe("a system cancellation tells the customer (policy ready; no producer exists yet)", () => {
  it("an order_cancelled_by_system event for a cancelled order notifies the customer only", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    await order.ref.update({status: "cancelled", cancelledAt: CREATED_AT, cancelledBy: "system", updatedAt: CREATED_AT});
    const event = buildCancellationNotificationEvent(
      {id: order.id, userId: order.customerId, organizationId: org.organizationId, outletId: org.outletId, menuId: org.menuId} as Order,
      "order_cancelled_by_system", CREATED_AT, true,
    );
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id).set(event);

    expect(await processNotificationEvent(db, event.id)).toEqual({kind: "processed", delivered: 1});

    const [note] = await inbox(order.customerId);
    expect(note).toMatchObject({type: "order_cancelled_by_system", body: "Your order from Main Canteen was cancelled. A refund has been initiated."});
    expect(await inbox(org.ownerId)).toEqual([]);
  });
});

// ---------------------------------------------------------------- refund events through the real webhook

let webhookSeq = 0;
function refundWebhook(type: string, s: Scenario, status: string): Buffer {
  return Buffer.from(JSON.stringify({
    entity: "event", event: type,
    payload: {refund: {entity: {
      id: "rfnd_notify_1", payment_id: s.providerPaymentId, amount: s.amount, currency: "INR", status,
      receipt: s.loc.refundId, notes: {zestoRefundId: s.loc.refundId, zestoOrderId: s.orderId},
    }}},
  }));
}
const deliver = (body: Buffer) =>
  receiveRazorpayWebhook(db, {rawBody: body, eventIdHeader: `evt_${++webhookSeq}_${randomUUID().slice(0, 6)}`});

/** Gives a scenario's organization an outlet document and members, and returns who is who. */
async function populateScenarioOrg(s: Scenario) {
  const outletRef = db.collection("organizations").doc(s.organizationId).collection("outlets").doc(s.loc.outletId);
  created.push(outletRef);
  await outletRef.set({id: s.loc.outletId, organizationId: s.organizationId, name: "Main Canteen"});
  const owner = await addMember(s.organizationId, "owner");
  const manager = await addMember(s.organizationId, "manager");
  const staff = await addMember(s.organizationId, "staff");
  const revoked = await addMember(s.organizationId, "manager", "revoked");
  const invited = await addMember(s.organizationId, "owner", "invited");
  const customerId = (await s.orderRef.get()).data()?.userId as string;
  usersTouched.add(customerId);
  return {owner, manager, staff, revoked, invited, customerId};
}

describe("refund_completed", () => {
  it("creates exactly one customer notification with the approved copy, and none for the organization", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_notify_1"}});
    const people = await populateScenarioOrg(s);
    await deliver(refundWebhook("refund.processed", s, "processed"));
    const eventId = `${s.loc.refundId}_refund_completed`;

    expect(await processNotificationEvent(db, eventId)).toEqual({kind: "processed", delivered: 1});

    const [note] = await inbox(people.customerId);
    expect(note).toMatchObject({
      id: notificationId(eventId, "customer"),
      type: "refund_completed",
      scope: customerScope(),
      title: "Refund processed",
      body: "Your refund has been processed. It may take a few business days to appear in your account.",
      orderId: s.orderId,
      readAt: null,
    });
    for (const userId of [people.owner, people.manager, people.staff]) {
      expect(await inbox(userId)).toEqual([]);
    }
    expect(await notificationsForEvent(eventId)).toHaveLength(1);
  });

  it("is not blocked by the order's lifecycle: a refund on an order that is not (or no longer) cancelled is still delivered", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", orderStatus: "confirmed", refund: {providerRefundId: "rfnd_notify_1"}});
    const people = await populateScenarioOrg(s);
    await deliver(refundWebhook("refund.processed", s, "processed"));
    expect((await s.orderRef.get()).data()?.status).toBe("confirmed");

    expect(await processNotificationEvent(db, `${s.loc.refundId}_refund_completed`)).toEqual({kind: "processed", delivered: 1});

    expect(await inboxTypes(people.customerId)).toEqual(["refund_completed"]);
  });
});

describe("refund_failed", () => {
  it("tells the customer and the organization's active owners and managers only — never staff, invited or revoked members", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_notify_1"}});
    const people = await populateScenarioOrg(s);
    const otherOrg = await buildOrg();
    await deliver(refundWebhook("refund.failed", s, "failed"));
    const eventId = `${s.loc.refundId}_refund_failed`;

    expect(await processNotificationEvent(db, eventId)).toEqual({kind: "processed", delivered: 3});

    const [customerNote] = await inbox(people.customerId);
    expect(customerNote).toMatchObject({
      id: notificationId(eventId, "customer"),
      type: "refund_failed",
      scope: customerScope(),
      title: "Refund issue",
      body: "We couldn't complete your refund automatically. We're looking into it. Please contact support with your order ID.",
      orderId: s.orderId,
    });
    for (const userId of [people.owner, people.manager]) {
      const [note] = await inbox(userId);
      expect(note).toMatchObject({
        id: notificationId(eventId, "org"),
        type: "refund_failed",
        scope: organizationScope(s.organizationId),
        title: "Refund failed",
        body: "A refund failed and needs attention.",
        orderId: s.orderId,
      });
    }
    for (const userId of [people.staff, people.revoked, people.invited, otherOrg.ownerId]) {
      expect(await inbox(userId)).toEqual([]);
    }
    expect(await notificationsForEvent(eventId)).toHaveLength(3);
  });

  it("carries no provider detail, internal ID, or error text in anything a client can read", async () => {
    const s = await seedScenario(db, {
      refundStatus: "pending",
      refund: {providerRefundId: "rfnd_notify_1"},
    });
    const people = await populateScenarioOrg(s);
    await deliver(refundWebhook("refund.failed", s, "failed"));
    await processNotificationEvent(db, `${s.loc.refundId}_refund_failed`);

    for (const userId of [people.customerId, people.owner]) {
      for (const note of await inbox(userId)) {
        const visible = JSON.stringify(toNotificationResponse(note));
        for (const secret of [s.providerPaymentId, s.providerOrderId, "rfnd_notify_1", s.loc.refundId, userId, s.organizationId]) {
          expect(visible).not.toContain(secret);
        }
        expect(Object.keys(toNotificationResponse(note)).sort()).toEqual([
          "body", "createdAt", "id", "orderId", "readAt", "title", "type",
        ]);
      }
    }
  });
});

// ---------------------------------------------------------------- idempotency

describe("idempotency", () => {
  it("a duplicate refund event (the same logical event, replayed) creates no second notification", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_notify_1"}});
    const people = await populateScenarioOrg(s);
    await deliver(refundWebhook("refund.failed", s, "failed"));
    const eventId = `${s.loc.refundId}_refund_failed`;

    await processNotificationEvent(db, eventId);
    // The same event document re-created (a replay) and back to pending: processed again.
    const original = await eventDoc(eventId);
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).set({...original, status: "pending", attempts: 0});
    await processNotificationEvent(db, eventId);
    await handleNotificationEventCreated(db, eventId);
    await processNotificationEvent(db, eventId);

    expect(await notificationsForEvent(eventId)).toHaveLength(3);
    expect(await inbox(people.customerId)).toHaveLength(1);
    expect(await inbox(people.owner)).toHaveLength(1);
  });

  it("a duplicate cancellation event: two concurrent processors still leave one notification per recipient", async () => {
    const org = await buildOrg();
    const manager = await addMember(org.organizationId, "manager");
    const order = await seedOrder(org, false);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    const eventId = `${order.id}_order_cancelled_by_customer`;

    await Promise.all([processNotificationEvent(db, eventId), processNotificationEvent(db, eventId), handleNotificationEventCreated(db, eventId)]);

    expect(await notificationsForEvent(eventId)).toHaveLength(2);
    expect(await inbox(manager)).toHaveLength(1);
  });

  it("repeated cancellation never re-emits, so nothing is ever notified twice", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    const actor = {kind: "organization" as const, membership: membership(org.organizationId, org.ownerId)};
    await cancelOrder(db, {actor, orderId: order.id, reason: "other"});
    await cancelOrder(db, {actor, orderId: order.id, reason: "other"});
    for (const id of await eventIdsOf(order.id)) {
      await processNotificationEvent(db, id);
      await processNotificationEvent(db, id);
    }

    expect(await inbox(order.customerId)).toHaveLength(1);
  });

  it("reprocessing keeps the notification's ID, createdAt and — above all — a readAt the user already set", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_notify_1"}});
    const people = await populateScenarioOrg(s);
    await deliver(refundWebhook("refund.processed", s, "processed"));
    const eventId = `${s.loc.refundId}_refund_completed`;
    await processNotificationEvent(db, eventId);
    const id = notificationId(eventId, "customer");
    const readAt = Timestamp.fromDate(new Date("2026-10-06T12:00:00Z"));
    const marked = await markNotificationRead(db, people.customerId, customerScope(), id, readAt);
    expect(marked.readAt).toBe(readAt.toDate().toISOString());
    const before = (await notificationsCollection(db, people.customerId).doc(id).get()).data();

    const original = await eventDoc(eventId);
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).set({...original, status: "pending", attempts: 0});
    await processNotificationEvent(db, eventId);

    const after = (await notificationsCollection(db, people.customerId).doc(id).get()).data();
    expect(after).toEqual(before);
    expect((after?.readAt as Timestamp).isEqual(readAt)).toBe(true);
  });
});

// ---------------------------------------------------------------- privacy / authorization

describe("privacy and authorization", () => {
  it("a customer's notification lives only in that customer's own inbox; another customer's inbox stays empty", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    const bystander = await seedOrder(org, true);
    await cancelOrder(db, {
      actor: {kind: "organization", membership: membership(org.organizationId, org.ownerId)},
      orderId: order.id, reason: "other",
    });
    await processNotificationEvent(db, `${order.id}_order_cancelled_by_outlet`);

    expect(await inboxTypes(order.customerId)).toEqual(["order_cancelled_by_outlet"]);
    expect(await inbox(bystander.customerId)).toEqual([]);
    // Another user cannot read or mark it read through their own inbox: the ID simply is not there.
    await expect(markNotificationRead(db, bystander.customerId, customerScope(), notificationId(`${order.id}_order_cancelled_by_outlet`, "customer")))
      .rejects.toMatchObject({httpErrorCode: {status: 404}});
  });

  it("an organization's notification never reaches another organization, even for a person who is staff of both", async () => {
    const orgA = await buildOrg("A Canteen");
    const orgB = await buildOrg("B Canteen");
    const shared = freshUserId();
    usersTouched.add(shared);
    for (const org of [orgA, orgB]) {
      const ref = db.collection("organizations").doc(org.organizationId).collection("members").doc(shared);
      created.push(ref);
      await ref.set({userId: shared, organizationId: org.organizationId, role: "staff", status: "active", createdAt: Timestamp.now()});
    }
    const order = await seedOrder(orgA, false);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    await processNotificationEvent(db, `${order.id}_order_cancelled_by_customer`);

    expect(await inbox(orgB.ownerId)).toEqual([]);
    const notes = await inbox(shared);
    expect(notes.map((note) => note.scope)).toEqual([organizationScope(orgA.organizationId)]);
  });

  it("a member revoked BEFORE processing is not notified, while the rest are", async () => {
    const org = await buildOrg();
    const manager = await addMember(org.organizationId, "manager");
    const order = await seedOrder(org, false);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    await db.collection("organizations").doc(org.organizationId).collection("members").doc(manager).update({status: "revoked"});

    await processNotificationEvent(db, `${order.id}_order_cancelled_by_customer`);

    expect(await inbox(manager)).toEqual([]);
    expect(await inbox(org.ownerId)).toHaveLength(1);
  });

  it("a refund event whose refund belongs to a different customer is failed, never delivered", async () => {
    const s = await seedScenario(db, {refundStatus: "processed"});
    const people = await populateScenarioOrg(s);
    const refund = (await s.refundRef.get()).data() as Refund;
    const event = buildRefundNotificationEvent({...refund, userId: "U-someone-else"}, "refund_completed", Timestamp.now());
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id).set(event);

    const result = await processNotificationEvent(db, event.id);

    expect(result.kind).toBe("failed");
    expect(await inbox(people.customerId)).toEqual([]);
    expect(await inbox("U-someone-else")).toEqual([]);
  });
});

// ---------------------------------------------------------------- the order rank must not interfere

describe("cancellation and refund events bypass the forward order ranking", () => {
  it("an order cancelled from any status (here: ready, rank 3) still notifies, and a late forward event is unaffected", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    await order.ref.update({status: "ready"});
    await cancelOrder(db, {
      actor: {kind: "organization", membership: membership(org.organizationId, org.ownerId)},
      orderId: order.id, reason: "cannot_fulfil_in_time",
    });

    expect(await processNotificationEvent(db, `${order.id}_order_cancelled_by_outlet`)).toEqual({kind: "processed", delivered: 1});
    expect((await order.ref.get()).data()?.cancelledFromStatus).toBe("ready");
  });

  it("a cancellation event is permanent-failed (no notification) when the order is not actually cancelled", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    const event = buildCancellationNotificationEvent(
      {id: order.id, userId: order.customerId, organizationId: org.organizationId, outletId: org.outletId, menuId: org.menuId} as Order,
      "order_cancelled_by_outlet", Timestamp.now(), false,
    );
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id).set(event);

    const result = await processNotificationEvent(db, event.id);

    expect(result).toMatchObject({kind: "failed"});
    expect((await eventDoc(event.id)).status).toBe("failed");
    expect(await inbox(order.customerId)).toEqual([]);
  });

  it("a system cancellation event (which has no actor to check) is failed when the order is not cancelled", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    const event = buildCancellationNotificationEvent(
      {id: order.id, userId: order.customerId, organizationId: org.organizationId, outletId: org.outletId, menuId: org.menuId} as Order,
      "order_cancelled_by_system", Timestamp.now(), true,
    );
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id).set(event);

    expect((await processNotificationEvent(db, event.id)).kind).toBe("failed");
    expect(await inbox(order.customerId)).toEqual([]);
  });

  it("an event naming the wrong kind of canceller is failed: a customer cancellation is not reported as the outlet's", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, false);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    const event = buildCancellationNotificationEvent(
      {id: order.id, userId: order.customerId, organizationId: org.organizationId, outletId: org.outletId, menuId: org.menuId} as Order,
      "order_cancelled_by_outlet", Timestamp.now(), false,
    );
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id).set(event);

    expect((await processNotificationEvent(db, event.id)).kind).toBe("failed");
    expect(await inbox(order.customerId)).toEqual([]);
  });

  it("a refund event is failed when the refund document itself belongs to someone else, even though the event and the order agree", async () => {
    const s = await seedScenario(db, {refundStatus: "processed"});
    const people = await populateScenarioOrg(s);
    const refund = (await s.refundRef.get()).data() as Refund;
    const event = buildRefundNotificationEvent(refund, "refund_completed", Timestamp.now());
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id).set(event);
    await s.refundRef.update({userId: "U-someone-else"});

    expect((await processNotificationEvent(db, event.id)).kind).toBe("failed");
    expect(await inbox(people.customerId)).toEqual([]);
  });

  it("a refund_completed event whose refund is not yet processed is failed, not announced", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_notify_1"}});
    const people = await populateScenarioOrg(s);
    const refund = (await s.refundRef.get()).data() as Refund;
    const event = buildRefundNotificationEvent(refund, "refund_completed", Timestamp.now());
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id).set(event);

    expect((await processNotificationEvent(db, event.id)).kind).toBe("failed");
    expect(await inbox(people.customerId)).toEqual([]);
  });
});

// ---------------------------------------------------------------- malformed events

describe("malformed events are failed once, loudly, and never retried", () => {
  async function failsWith(data: Record<string, unknown>, id: string) {
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(id).set(data);
    const result = await processNotificationEvent(db, id);
    expect(result.kind).toBe("failed");
    expect(await eventDoc(id)).toMatchObject({status: "failed"});
    // An unreadable event is re-checked (and re-failed) on every call, never retried into a delivery.
    expect((await processNotificationEvent(db, id)).kind).toBe("failed");
    expect(await eventDoc(id)).toMatchObject({status: "failed"});
    expect(await notificationsForEvent(id)).toEqual([]);
  }

  const base = (type: string) => ({
    type, orderId: "ord-x", organizationId: "org-x", outletId: "out-x", menuId: "menu-x",
    customerUserId: "U-x", occurredAt: Timestamp.now(), status: "pending", attempts: 0,
  });

  it("a refund event with no refund or payment ID", async () => {
    await failsWith({id: "ord-x-r1_refund_failed", ...base("refund_failed")}, "ord-x-r1_refund_failed");
  });

  it("a refund event whose ID is not the one its refund and type imply", async () => {
    await failsWith(
      {id: "wrong-id_refund_failed", ...base("refund_failed"), refundId: "ord-x-r1", paymentId: "ord-x"},
      "wrong-id_refund_failed",
    );
  });

  it("an order or cancellation event carrying refund fields", async () => {
    await failsWith(
      {id: "ord-x_order_cancelled_by_customer", ...base("order_cancelled_by_customer"), refundId: "ord-x-r1"},
      "ord-x_order_cancelled_by_customer",
    );
  });

  it("an order event carrying refundInitiated", async () => {
    await failsWith(
      {id: "ord-x_order_ready", ...base("order_ready"), refundInitiated: true},
      "ord-x_order_ready",
    );
  });

  it("an unknown event type", async () => {
    await failsWith({id: "ord-x_order_teleported", ...base("order_teleported")}, "ord-x_order_teleported");
  });

  it("an event for an order that does not exist is failed, for each new family", async () => {
    const org = await buildOrg();
    const ghost = {id: "ghost-order", userId: "U-ghost", organizationId: org.organizationId, outletId: org.outletId, menuId: org.menuId} as Order;
    const cancellation = buildCancellationNotificationEvent(ghost, "order_cancelled_by_customer", Timestamp.now(), false);
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(cancellation.id).set(cancellation);
    const refundEvent: NotificationEvent = buildRefundNotificationEvent({
      id: "ghost-order-r1", paymentId: "ghost-order", orderId: "ghost-order", organizationId: org.organizationId,
      outletId: org.outletId, menuId: org.menuId, userId: "U-ghost", providerPaymentId: "pay_x", amountInPaise: 100,
    } as Refund, "refund_completed", Timestamp.now());
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(refundEvent.id).set(refundEvent);

    expect((await processNotificationEvent(db, cancellation.id)).kind).toBe("failed");
    expect((await processNotificationEvent(db, refundEvent.id)).kind).toBe("failed");
  });
});

describe("through the trigger body", () => {
  it("handleNotificationEventCreated consumes a refund_requested event and creates nothing", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    const id = `${order.id}-r1_refund_requested`;

    await handleNotificationEventCreated(db, id);

    expect(await eventDoc(id)).toMatchObject({status: "processed"});
    expect(await notificationsForEvent(id)).toEqual([]);
  });
});

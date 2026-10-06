// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import {businessDateString} from "../time";
import {createMenu} from "./menus";
import {NOTIFICATION_EVENTS_COLLECTION} from "./notificationEvents";
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
import {createOrganization} from "./organizations";
import {createOutlet} from "./outlets";
import {receiveRazorpayWebhook} from "./razorpayWebhooks";
import {seedScenario, type Scenario} from "./refundScenario.fake";

/**
 * The notification TRIGGER, end to end (Checkpoint 7.6A): every event here is processed by the
 * REAL `onNotificationEventCreated` running in the Functions emulator —
 *
 *   Firestore document create -> Eventarc emulator -> Cloud Function -> processor -> inbox
 *
 * This file never imports or calls the processor or the trigger body; it only writes documents
 * (through the real cancellation transaction and the real refund webhook handler wherever a real
 * transition exists) and then WAITS for the function to do its work. `attempts` and `processedAt`
 * on an event are written only by the processor, so seeing them proves the function ran.
 *
 * Run via `npm run test:functions-trigger` (repo root), which starts the Functions + Firestore
 * emulators from an isolated, secret-free copy of the Functions source. The refund-submission
 * trigger (`onRefundCreated`) also runs there whenever a test creates a refund; with no Razorpay
 * credentials it can only defer, never call the provider.
 */

const PROJECT_ID = "demo-zesto-trigger";
let db: Firestore;

vi.setConfig({testTimeout: 90_000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-trigger`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

// ---------------------------------------------------------------- waiting

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns a truthy value; fails with `what` after `timeoutMs`. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
    }
    await sleep(250);
  }
}

/** Extra time for a (wrongly) duplicated delivery to show itself before a negative assertion. */
const settle = () => sleep(2_500);

type EventDoc = Record<string, unknown>;

async function eventDoc(eventId: string): Promise<EventDoc | undefined> {
  return (await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).get()).data();
}

/** Waits until the trigger has settled the event, and returns it. */
async function waitProcessed(eventId: string): Promise<EventDoc> {
  return waitFor(`event ${eventId} processed by the trigger`, async () => {
    const event = await eventDoc(eventId);
    return event?.status === "processed" ? event : undefined;
  });
}

/** The event as a fresh, unprocessed document: what a replayed (re-created) event looks like. */
function pendingCopy(event: EventDoc): EventDoc {
  const copy: EventDoc = {...event, status: "pending", attempts: 0};
  for (const field of ["processedAt", "lastAttemptAt", "lastError"]) {
    delete copy[field];
  }
  return copy;
}

async function waitEventExists(eventId: string): Promise<EventDoc> {
  return waitFor(`event ${eventId} to be written`, async () => eventDoc(eventId));
}

// ---------------------------------------------------------------- fixtures

interface OrgFixture {
  organizationId: string;
  outletId: string;
  menuId: string;
  ownerId: string;
  managerId: string;
  staffId: string;
  revokedId: string;
  invitedId: string;
}

async function addMember(
  organizationId: string,
  role: OrganizationMemberRole,
  status: "active" | "invited" | "revoked" = "active",
): Promise<string> {
  const userId = `U-${randomUUID()}`;
  await db.collection("organizations").doc(organizationId).collection("members").doc(userId)
    .set({userId, organizationId, role, status, createdAt: Timestamp.now()});
  return userId;
}

async function populateMembers(organizationId: string, ownerId: string) {
  return {
    ownerId,
    managerId: await addMember(organizationId, "manager"),
    staffId: await addMember(organizationId, "staff"),
    revokedId: await addMember(organizationId, "manager", "revoked"),
    invitedId: await addMember(organizationId, "owner", "invited"),
  };
}

async function buildOrg(outletName = "Main Canteen"): Promise<OrgFixture> {
  const ownerId = `U-${randomUUID()}`;
  const suffix = randomUUID();
  const {organization} = await createOrganization(db, ownerId, {name: `Org ${suffix}`, slug: `trig-org-${suffix}`});
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
  return {organizationId: organization.id, outletId: outlet.id, menuId: menu.id, ...(await populateMembers(organization.id, ownerId))};
}

/** A provider-style reference: alphanumerics only, as the provider gateway requires of an ID. */
const providerRef = () => randomUUID().replace(/-/g, "").slice(0, 14);

const AMOUNT = 10000;
const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
  org: OrgFixture;
}

async function seedOrder(org: OrgFixture, paid: boolean, customerId = `U-${randomUUID()}`): Promise<SeededOrder> {
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(org.outletId)
    .collection("menus").doc(org.menuId)
    .collection("orders").doc();
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId: org.menuId,
    status: paid ? "confirmed" : "pending_payment",
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
    providerOrderId: `order_${providerRef()}`,
    ...(paid ? {providerPaymentId: `pay_${providerRef()}`, capturedAmountInPaise: AMOUNT} : {}),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return {id: ref.id, ref, customerId, org};
}

const ownerActor = (org: OrgFixture) => ({
  kind: "organization" as const,
  membership: {userId: org.ownerId, organizationId: org.organizationId, role: "owner", status: "active"} as OrganizationMembership,
});

/** A user's whole inbox, parsed. */
async function inbox(userId: string) {
  const snapshot = await notificationsCollection(db, userId).get();
  return snapshot.docs.map((doc) => parseNotification(doc.data(), doc.id));
}

async function notificationDocsFor(eventId: string) {
  return (await db.collectionGroup("notifications").where("eventId", "==", eventId).get()).docs;
}

/** The raw refund-event IDs written for an order. */
async function eventIdsOf(orderId: string): Promise<string[]> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", orderId).get();
  return snapshot.docs.map((doc) => doc.id).sort();
}

let webhookSeq = 0;
function refundWebhook(type: string, s: Scenario, status: string, providerRefundId: string): Buffer {
  return Buffer.from(JSON.stringify({
    entity: "event", event: type,
    payload: {refund: {entity: {
      id: providerRefundId, payment_id: s.providerPaymentId, amount: s.amount, currency: "INR", status,
      receipt: s.loc.refundId, notes: {zestoRefundId: s.loc.refundId, zestoOrderId: s.orderId},
    }}},
  }));
}
/** Delivers a refund webhook through the real handler and requires that it was APPLIED (not ignored or rejected). */
async function deliverWebhook(body: Buffer, expectedOutcome: "refund_processed" | "refund_failed"): Promise<void> {
  const result = await receiveRazorpayWebhook(db, {rawBody: body, eventIdHeader: `evt_${++webhookSeq}_${randomUUID().slice(0, 6)}`});
  expect(result.kind === "processed" ? result.outcome : result.kind).toBe(expectedOutcome);
}

/** A refund context in the state a provider webhook is about to settle, with a full organization. */
async function refundContext() {
  // Unique per context: the real handler locates refunds by provider ID across the whole database.
  const providerRefundId = `rfnd_trigger_${randomUUID().slice(0, 12)}`;
  const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId}});
  await db.collection("organizations").doc(s.organizationId).collection("outlets").doc(s.loc.outletId)
    .set({id: s.loc.outletId, organizationId: s.organizationId, name: "Main Canteen"});
  const people = await populateMembers(s.organizationId, await addMember(s.organizationId, "owner"));
  const customerId = (await s.orderRef.get()).data()?.userId as string;
  return {s, people, customerId, providerRefundId};
}

// ================================================================ A + D: a customer cancels a PAID order

describe("a customer cancels a paid order (refund_requested + order_cancelled_by_customer)", () => {
  it("the trigger processes both: the organization is told, the customer is not, and refund_requested creates NO inbox document", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);

    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id, reason: "changed_my_mind"});
    const cancelledId = `${order.id}_order_cancelled_by_customer`;
    const requestedId = `${order.id}-r1_refund_requested`;
    expect(await eventIdsOf(order.id)).toEqual([requestedId, cancelledId].sort());

    // ---- refund_requested (A): consumed by the trigger, nothing visible
    const requested = await waitProcessed(requestedId);
    expect(requested).toMatchObject({status: "processed", attempts: 1});
    expect(requested.processedAt).toBeInstanceOf(Timestamp);
    expect(requested.lastError).toBeUndefined();
    await settle();
    expect(await notificationDocsFor(requestedId)).toEqual([]);
    expect((await eventDoc(requestedId))?.attempts).toBe(1); // not processed a second time

    // ---- order_cancelled_by_customer (D): owner + manager + staff, never the customer
    const cancelled = await waitProcessed(cancelledId);
    expect(cancelled).toMatchObject({status: "processed", attempts: 1, refundInitiated: true});
    for (const userId of [org.ownerId, org.managerId, org.staffId]) {
      const notes = await inbox(userId);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        id: notificationId(cancelledId, "org"),
        type: "order_cancelled_by_customer",
        scope: organizationScope(org.organizationId),
        title: "Order cancelled",
        body: "An order from Main Canteen was cancelled by the customer.",
        orderId: order.id,
        readAt: null,
      });
    }
    for (const userId of [order.customerId, org.revokedId, org.invitedId]) {
      expect(await inbox(userId)).toEqual([]);
    }
    expect(await notificationDocsFor(cancelledId)).toHaveLength(3);

    // The refund-submission trigger also fired for this refund; with no credentials it only defers.
    const refund = (await order.ref.collection("payments").doc(order.id).collection("refunds").doc(`${order.id}-r1`).get()).data();
    expect(refund?.status).toBe("requested");
    expect(refund?.providerRefundId).toBeUndefined();
  });

  it("an UNPAID customer cancellation emits only the cancellation event: no refund event, the organization is told", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, false);

    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});

    expect(await eventIdsOf(order.id)).toEqual([`${order.id}_order_cancelled_by_customer`]);
    await waitProcessed(`${order.id}_order_cancelled_by_customer`);
    expect(await inbox(org.ownerId)).toHaveLength(1);
    expect(await inbox(order.customerId)).toEqual([]);
  });
});

// ================================================================ E: the outlet cancels

describe("an organization owner cancels a paid order (order_cancelled_by_outlet)", () => {
  it("the trigger tells the customer once, with safe copy, and the organization nothing", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, true);

    await cancelOrder(db, {actor: ownerActor(org), orderId: order.id, reason: "item_unavailable"});
    const eventId = `${order.id}_order_cancelled_by_outlet`;
    const requestedId = `${order.id}-r1_refund_requested`;

    const event = await waitProcessed(eventId);
    expect(event).toMatchObject({status: "processed", attempts: 1, refundInitiated: true});
    await waitProcessed(requestedId);
    await settle();

    const notes = await inbox(order.customerId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: notificationId(eventId, "customer"),
      type: "order_cancelled_by_outlet",
      scope: customerScope(),
      title: "Order cancelled",
      body: "Your order from Main Canteen was cancelled by the outlet. A refund has been initiated.",
      orderId: order.id,
      readAt: null,
    });
    for (const userId of [org.ownerId, org.managerId, org.staffId]) {
      expect(await inbox(userId)).toEqual([]);
    }

    // Safe: nothing a client can read names a provider, a refund, a user or an organization.
    const refundId = `${order.id}-r1`;
    const payment = (await order.ref.collection("payments").doc(order.id).get()).data();
    const visible = JSON.stringify(toNotificationResponse(notes[0]));
    for (const secret of [
      refundId, "rfnd", payment?.providerPaymentId, payment?.providerOrderId,
      order.customerId, org.ownerId, org.organizationId, org.outletId,
    ]) {
      expect(visible).not.toContain(secret);
    }
    expect(Object.keys(toNotificationResponse(notes[0])).sort()).toEqual(["body", "createdAt", "id", "orderId", "readAt", "title", "type"]);
    expect(notes[0].id).not.toContain(refundId);
    expect(await notificationDocsFor(requestedId)).toEqual([]);
  });

  it("an unpaid outlet cancellation does not mention a refund", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, false);

    await cancelOrder(db, {actor: ownerActor(org), orderId: order.id, reason: "outlet_closed"});
    await waitProcessed(`${order.id}_order_cancelled_by_outlet`);

    const [note] = await inbox(order.customerId);
    expect(note.body).toBe("Your order from Main Canteen was cancelled by the outlet.");
    expect(await eventIdsOf(order.id)).toEqual([`${order.id}_order_cancelled_by_outlet`]);
  });
});

// ================================================================ B: refund completed

describe("refund_completed", () => {
  it("is written by the real webhook handler and processed by the trigger into exactly one customer notification", async () => {
    const {s, people, customerId, providerRefundId} = await refundContext();
    const eventId = `${s.loc.refundId}_refund_completed`;

    await deliverWebhook(refundWebhook("refund.processed", s, "processed", providerRefundId), "refund_processed");
    await waitEventExists(eventId);
    const event = await waitProcessed(eventId);
    await settle();

    expect(event).toMatchObject({status: "processed", attempts: 1, refundId: s.loc.refundId, orderId: s.orderId});
    const notes = await inbox(customerId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: notificationId(eventId, "customer"),
      type: "refund_completed",
      scope: customerScope(),
      title: "Refund processed",
      body: "Your refund has been processed. It may take a few business days to appear in your account.",
      orderId: s.orderId,
      readAt: null,
    });
    // Opaque: the internal refund ID (and the event ID it derives from) is nowhere in the ID a client sees.
    expect(notes[0].id).toMatch(/^refund-[0-9a-f]{24}\.customer$/);
    expect(notes[0].id).not.toContain(s.loc.refundId);
    expect(notes[0].eventId).toBe(eventId); // internal only: never in the client response
    expect(JSON.stringify(toNotificationResponse(notes[0]))).not.toContain(s.loc.refundId);
    for (const userId of [people.ownerId, people.managerId, people.staffId]) {
      expect(await inbox(userId)).toEqual([]);
    }
    expect(await notificationDocsFor(eventId)).toHaveLength(1);
  });

  it("replaying the same logical event (the document re-created) through the trigger creates no duplicate and keeps readAt", async () => {
    const {s, customerId, providerRefundId} = await refundContext();
    const eventId = `${s.loc.refundId}_refund_completed`;
    await deliverWebhook(refundWebhook("refund.processed", s, "processed", providerRefundId), "refund_processed");
    const first = await waitProcessed(eventId);
    const noteId = notificationId(eventId, "customer");
    const readAt = Timestamp.fromDate(new Date("2026-10-06T12:00:00Z"));
    await markNotificationRead(db, customerId, customerScope(), noteId, readAt);
    const before = (await notificationsCollection(db, customerId).doc(noteId).get()).data();

    // Replay: the same event document is deleted and created again, as a fresh pending event.
    const ref = db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId);
    await ref.delete();
    await ref.set(pendingCopy(first));
    const replayed = await waitProcessed(eventId);
    await settle();

    expect(replayed).toMatchObject({status: "processed", attempts: 1}); // the trigger ran AGAIN on the re-created document
    expect(await notificationDocsFor(eventId)).toHaveLength(1);
    expect(await inbox(customerId)).toHaveLength(1);
    const after = (await notificationsCollection(db, customerId).doc(noteId).get()).data();
    expect(after).toEqual(before);
    expect((after?.readAt as Timestamp).isEqual(readAt)).toBe(true);
  });
});

// ================================================================ C: refund failed

describe("refund_failed", () => {
  it("tells the customer and each active owner and manager exactly once — never staff, invited or revoked members", async () => {
    const {s, people, customerId, providerRefundId} = await refundContext();
    const eventId = `${s.loc.refundId}_refund_failed`;

    await deliverWebhook(refundWebhook("refund.failed", s, "failed", providerRefundId), "refund_failed");
    await waitEventExists(eventId);
    const event = await waitProcessed(eventId);
    await settle();

    expect(event).toMatchObject({status: "processed", attempts: 1});
    const customerNotes = await inbox(customerId);
    expect(customerNotes).toHaveLength(1);
    expect(customerNotes[0]).toMatchObject({
      id: notificationId(eventId, "customer"),
      type: "refund_failed",
      scope: customerScope(),
      title: "Refund issue",
      body: "We couldn't complete your refund automatically. We're looking into it. Please contact support with your order ID.",
      orderId: s.orderId,
    });
    // `people.ownerId` is the active owner member added with the context; the invited "owner" is not eligible.
    for (const userId of [people.ownerId, people.managerId]) {
      const notes = await inbox(userId);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        id: notificationId(eventId, "org"),
        type: "refund_failed",
        scope: organizationScope(s.organizationId),
        title: "Refund failed",
        body: "A refund failed and needs attention.",
        orderId: s.orderId,
      });
    }
    for (const userId of [people.staffId, people.revokedId, people.invitedId]) {
      expect(await inbox(userId)).toEqual([]);
    }
    expect(await notificationDocsFor(eventId)).toHaveLength(3);

    // Nothing sensitive in anything a client can read.
    for (const note of [...customerNotes, ...(await inbox(people.ownerId))]) {
      const visible = JSON.stringify(toNotificationResponse(note));
      for (const secret of [s.providerPaymentId, s.providerOrderId, providerRefundId, s.loc.refundId, s.organizationId, customerId]) {
        expect(visible).not.toContain(secret);
      }
    }
  });

  it("an organization cancellation event replayed through the trigger leaves one notification per recipient", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, false);
    await cancelOrder(db, {actor: {kind: "customer", userId: order.customerId}, orderId: order.id});
    const eventId = `${order.id}_order_cancelled_by_customer`;
    const first = await waitProcessed(eventId);
    const noteId = notificationId(eventId, "org");
    const readAt = Timestamp.fromDate(new Date("2026-10-06T13:00:00Z"));
    await markNotificationRead(db, org.managerId, organizationScope(org.organizationId), noteId, readAt);

    const ref = db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId);
    await ref.delete();
    await ref.set(pendingCopy(first));
    expect(await waitProcessed(eventId)).toMatchObject({attempts: 1}); // the trigger ran again on the re-created document
    await settle();

    expect(await notificationDocsFor(eventId)).toHaveLength(3);
    const managerNote = (await notificationsCollection(db, org.managerId).doc(noteId).get()).data();
    expect((managerNote?.readAt as Timestamp).isEqual(readAt)).toBe(true);
    expect((await inbox(org.staffId))[0].readAt).toBeNull();
  });
});

// ================================================================ G: a genuine failure, then success

describe("a genuine processing failure leaves the event retryable; a later delivery succeeds exactly once", () => {
  it("fails on an unusable recipient ID (event stays pending with attempts + lastError), then succeeds once the data is right", async () => {
    const org = await buildOrg();
    // A customer ID Firestore reserves (`__x__`): the order is real and matches its event, so the
    // processor gets as far as delivery, where writing under `users/__bad__/...` genuinely fails.
    const badCustomer = "__bad__";
    const order = await seedOrder(org, false, badCustomer);
    await cancelOrder(db, {actor: ownerActor(org), orderId: order.id, reason: "outlet_closed"});
    const eventId = `${order.id}_order_cancelled_by_outlet`;

    const failed = await waitFor("the trigger's failed first attempt to be recorded", async () => {
      const event = await eventDoc(eventId);
      return typeof event?.lastError === "string" ? event : undefined;
    });

    // Retryable, not terminal: still pending, the attempt counted, a bounded error noted, nothing delivered.
    expect(failed.status).toBe("pending");
    expect(failed.attempts).toBeGreaterThanOrEqual(1);
    expect((failed.lastError as string).length).toBeLessThanOrEqual(300);
    expect(failed.processedAt).toBeUndefined();
    expect(await notificationDocsFor(eventId)).toEqual([]);
    const attemptsSeen = failed.attempts as number;

    // The cause is fixed (a valid customer ID on the order and the event), as it would be between retries.
    const goodCustomer = `U-${randomUUID()}`;
    await order.ref.update({userId: goodCustomer});
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).delete();
    // The platform's retry re-invokes the function for the same pending event. The emulator does not
    // redeliver a failed invocation by itself, so the same delivery is reproduced by re-creating the
    // event exactly as it stood (attempts and error preserved), which is what a retry would find.
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).set({
      ...failed, customerUserId: goodCustomer,
    });

    const done = await waitProcessed(eventId);
    await settle();

    expect(done.attempts).toBe(attemptsSeen + 1);
    expect(done.lastError).toBeUndefined();
    expect(await notificationDocsFor(eventId)).toHaveLength(1);
    const notes = await inbox(goodCustomer);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(notificationId(eventId, "customer"));
  });
});

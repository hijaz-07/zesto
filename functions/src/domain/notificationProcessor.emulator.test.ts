// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole} from "../auth/membership";
import {inAppChannel, type NotificationChannel, type NotificationDelivery} from "./notificationChannels";
import {
  NOTIFICATION_EVENTS_COLLECTION,
  buildNotificationEvent,
  notificationEventId,
  type NotificationEvent,
  type NotificationEventType,
} from "./notificationEvents";
import {handleNotificationEventCreated} from "./notificationEventTrigger";
import {
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_RECIPIENT_CAP,
  processNotificationEvent,
} from "./notificationProcessor";
import {
  countUnreadNotifications,
  customerScope,
  markNotificationRead,
  notificationId,
  notificationsCollection,
  organizationScope,
  parseNotification,
} from "./notifications";
import type {Order, OrderStatus} from "./orders";
import {createOrganization} from "./organizations";

/**
 * The notification PROCESSOR against a REAL Firestore emulator: what each event
 * turns into, who gets it (recipients derived from real membership documents),
 * idempotent creation under duplicate and partial processing, the retry model,
 * and tenant isolation. Events are written directly here in the shape the
 * transitions write them (`notificationEvents.emulator.test.ts` proves the
 * transitions write them); the real Firestore trigger is exercised separately
 * against the Functions emulator.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own, so its large fan-out and cleanup
// cannot slow any other suite (see `orderFulfillment.emulator.test.ts`).
const PROJECT_ID = "demo-zesto-notification-processor";

let db: Firestore;

vi.setConfig({testTimeout: 20000});

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

// Every document a test creates, deleted after it.
const created: DocumentReference[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const refs = created.splice(0);
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
});

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

interface OrgFixture {
  organizationId: string;
  outletId: string;
  menuId: string;
  ownerId: string;
}

async function buildOrg(outletName = "Main Canteen"): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, {
    name: `Test Org ${randomUUID()}`, slug: `test-org-${randomUUID()}`,
  });
  created.push(db.collection("organizations").doc(organization.id).collection("members").doc(ownerId));
  const outletRef = db.collection("organizations").doc(organization.id).collection("outlets").doc();
  created.push(outletRef);
  await outletRef.set({id: outletRef.id, organizationId: organization.id, name: outletName});
  return {organizationId: organization.id, outletId: outletRef.id, menuId: `menu-${randomUUID()}`, ownerId};
}

async function addMember(
  org: OrgFixture,
  role: OrganizationMemberRole,
  status: "active" | "invited" | "revoked" = "active",
  userId = freshUserId(),
): Promise<string> {
  const ref = db.collection("organizations").doc(org.organizationId).collection("members").doc(userId);
  created.push(ref);
  await ref.set({userId, organizationId: org.organizationId, role, status, createdAt: Timestamp.now()});
  return userId;
}

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
  org: OrgFixture;
}

async function seedOrder(org: OrgFixture, status: OrderStatus, customerId = freshUserId()): Promise<SeededOrder> {
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(org.outletId)
    .collection("menus").doc(org.menuId)
    .collection("orders").doc();
  created.push(ref);
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId: org.menuId,
    status,
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: 10000,
    totalInPaise: 10000,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: 10000}],
    createdAt: Timestamp.fromDate(new Date("2026-09-01T06:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-01T06:00:00Z")),
  });
  return {id: ref.id, ref, customerId, org};
}

const OCCURRED_AT = Timestamp.fromDate(new Date("2026-10-05T10:00:00Z"));

/** Writes the pending event a transition would have written, and returns its ID. */
async function writeEvent(
  order: SeededOrder,
  type: NotificationEventType,
  overrides: Partial<NotificationEvent> = {},
): Promise<string> {
  const event = {
    ...buildNotificationEvent({
      id: order.id,
      userId: order.customerId,
      organizationId: order.org.organizationId,
      outletId: order.org.outletId,
      menuId: order.org.menuId,
    } as Order, type, OCCURRED_AT),
    ...overrides,
  };
  const ref = db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(event.id);
  created.push(ref);
  await ref.set(event);
  return event.id;
}

async function eventDoc(eventId: string): Promise<Record<string, unknown>> {
  return (await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).get()).data() ?? {};
}

/** Every notification in a user's inbox, by ID — and registers them for cleanup. */
async function inbox(userId: string) {
  const snapshot = await notificationsCollection(db, userId).get();
  created.push(...snapshot.docs.map((doc) => doc.ref));
  return snapshot.docs.map((doc) => parseNotification(doc.data(), doc.id));
}

/** Registers every inbox document a user could receive from `eventId` for cleanup. */
function expectInboxOf(userId: string, eventId: string) {
  for (const audience of ["customer", "org"] as const) {
    created.push(notificationsCollection(db, userId).doc(notificationId(eventId, audience)));
  }
}

/** A channel that hands the first `deliverFirst` deliveries to the real inbox, then fails. */
function channelFailingAfter(deliverFirst: number): NotificationChannel {
  return {
    name: "in_app",
    async deliver(database, deliveries: readonly NotificationDelivery[]) {
      await inAppChannel.deliver(database, deliveries.slice(0, deliverFirst));
      throw new Error("14 UNAVAILABLE: connection reset");
    },
  };
}

const alwaysFailing = channelFailingAfter(0);

describe("what each event becomes", () => {
  it("order_confirmed: one customer notification and one new_order notification per active member", async () => {
    const org = await buildOrg();
    const manager = await addMember(org, "manager");
    const staff = await addMember(org, "staff");
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_confirmed");

    const result = await processNotificationEvent(db, eventId);

    expect(result).toEqual({kind: "processed", delivered: 4});
    const customer = await inbox(order.customerId);
    expect(customer).toHaveLength(1);
    expect(customer[0]).toEqual({
      id: `${eventId}.customer`,
      type: "order_confirmed",
      scope: "customer",
      title: "Order confirmed",
      body: "Your order from Main Canteen has been confirmed.",
      orderId: order.id,
      organizationId: org.organizationId,
      outletId: org.outletId,
      eventId,
      createdAt: OCCURRED_AT,
      readAt: null,
      expiresAt: Timestamp.fromMillis(OCCURRED_AT.toMillis() + 90 * 24 * 60 * 60 * 1000),
    });
    for (const recipient of [org.ownerId, manager, staff]) {
      const notifications = await inbox(recipient);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        id: `${eventId}.org`,
        type: "new_order",
        scope: organizationScope(org.organizationId),
        title: "New order",
        body: "New order received from Main Canteen.",
        orderId: order.id,
        readAt: null,
      });
    }
    expect(await eventDoc(eventId)).toMatchObject({status: "processed", attempts: 1});
    expect((await eventDoc(eventId)).processedAt).toBeInstanceOf(Timestamp);
    expect((await eventDoc(eventId)).lastError).toBeUndefined();
  });

  it.each([
    ["order_preparing", "preparing", "Being prepared", "Your order from Main Canteen is being prepared."],
    ["order_ready", "ready", "Ready for pickup", "Your order from Main Canteen is ready for pickup."],
    ["order_picked_up", "picked_up", "Picked up", "Your order from Main Canteen has been picked up."],
  ] as const)("%s: one customer notification and NOTHING for the organization", async (type, status, title, body) => {
    const org = await buildOrg();
    const staff = await addMember(org, "staff");
    const order = await seedOrder(org, status);
    const eventId = await writeEvent(order, type);

    const result = await processNotificationEvent(db, eventId);

    expect(result).toEqual({kind: "processed", delivered: 1});
    expect(await inbox(order.customerId)).toEqual([
      expect.objectContaining({id: `${eventId}.customer`, type, scope: "customer", title, body, orderId: order.id}),
    ]);
    expect(await inbox(org.ownerId)).toEqual([]);
    expect(await inbox(staff)).toEqual([]);
  });

  it("order_completed is processed but produces NO notification for anyone — and needs no reads", async () => {
    const org = await buildOrg();
    const staff = await addMember(org, "staff");
    const order = await seedOrder(org, "completed");
    const eventId = await writeEvent(order, "order_completed");
    expectInboxOf(order.customerId, eventId);

    const result = await processNotificationEvent(db, eventId);

    expect(result).toEqual({kind: "processed", delivered: 0});
    expect(await inbox(order.customerId)).toEqual([]);
    expect(await inbox(org.ownerId)).toEqual([]);
    expect(await inbox(staff)).toEqual([]);
    expect(await eventDoc(eventId)).toMatchObject({status: "processed", attempts: 1});
  });

  it("without an outlet document, the copy is still a complete sentence", async () => {
    const org = await buildOrg();
    await db.collection("organizations").doc(org.organizationId).collection("outlets").doc(org.outletId).delete();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");

    await processNotificationEvent(db, eventId);

    expect((await inbox(order.customerId))[0].body).toBe("Your order is ready for pickup.");
  });
});

describe("recipients are derived server-side from real memberships", () => {
  it("17. an invited or revoked member receives nothing; neither does a member of another organization", async () => {
    const org = await buildOrg();
    const other = await buildOrg();
    const invited = await addMember(org, "staff", "invited");
    const revoked = await addMember(org, "manager", "revoked");
    const otherOwner = other.ownerId;
    const otherStaff = await addMember(other, "staff");
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_confirmed");

    await processNotificationEvent(db, eventId);

    expect(await inbox(invited)).toEqual([]);
    expect(await inbox(revoked)).toEqual([]);
    expect(await inbox(otherOwner)).toEqual([]);
    expect(await inbox(otherStaff)).toEqual([]);
    expect(await inbox(org.ownerId)).toHaveLength(1);
  });

  it("a member with an unknown role receives nothing", async () => {
    const org = await buildOrg();
    const odd = await addMember(org, "customer" as unknown as OrganizationMemberRole);
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_confirmed");

    await processNotificationEvent(db, eventId);

    expect(await inbox(odd)).toEqual([]);
  });

  it("a member whose membership was revoked BEFORE processing is not notified, while the rest are", async () => {
    const org = await buildOrg();
    const leaver = await addMember(org, "staff");
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_confirmed");
    await db.collection("organizations").doc(org.organizationId).collection("members").doc(leaver)
      .update({status: "revoked"});

    await processNotificationEvent(db, eventId);

    expect(await inbox(leaver)).toEqual([]);
    expect(await inbox(org.ownerId)).toHaveLength(1);
  });

  it("15. the customer's notification goes to the order's customer only — never to another customer", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const bystander = freshUserId();
    const eventId = await writeEvent(order, "order_ready");

    await processNotificationEvent(db, eventId);

    expect(await inbox(order.customerId)).toHaveLength(1);
    expect(await inbox(bystander)).toEqual([]);
    expect(await inbox(org.ownerId)).toEqual([]);
  });

  it("16. an organization's new_order is scoped to that organization, and a staff member of two organizations gets each separately", async () => {
    const orgA = await buildOrg("Canteen A");
    const orgB = await buildOrg("Canteen B");
    const both = freshUserId();
    await addMember(orgA, "staff", "active", both);
    await addMember(orgB, "staff", "active", both);
    const orderA = await seedOrder(orgA, "confirmed");
    const eventA = await writeEvent(orderA, "order_confirmed");

    await processNotificationEvent(db, eventA);

    const received = await inbox(both);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({scope: organizationScope(orgA.organizationId), orderId: orderA.id});
    expect(await inbox(orgB.ownerId)).toEqual([]);
  });

  it("someone who is both the customer and an owner gets two distinct notifications for one event", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "confirmed", org.ownerId);
    const eventId = await writeEvent(order, "order_confirmed");

    await processNotificationEvent(db, eventId);

    const received = await inbox(org.ownerId);
    expect(received.map((notification) => notification.id).sort()).toEqual([
      `${eventId}.customer`, `${eventId}.org`,
    ]);
    expect(received.map((notification) => notification.scope).sort()).toEqual(
      [customerScope(), organizationScope(org.organizationId)].sort(),
    );
  });
});

describe("idempotent, at-least-once processing", () => {
  it("a redelivered trigger for a processed event does nothing", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");
    await processNotificationEvent(db, eventId);

    const second = await processNotificationEvent(db, eventId);

    expect(second).toEqual({kind: "skipped", reason: "already_processed"});
    expect(await inbox(order.customerId)).toHaveLength(1);
    expect(await eventDoc(eventId)).toMatchObject({status: "processed", attempts: 1});
  });

  it("two processors running at the same moment still leave exactly one notification each", async () => {
    const org = await buildOrg();
    const staff = await addMember(org, "staff");
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_confirmed");

    await Promise.all([processNotificationEvent(db, eventId), processNotificationEvent(db, eventId)]);

    expect(await inbox(order.customerId)).toHaveLength(1);
    expect(await inbox(org.ownerId)).toHaveLength(1);
    expect(await inbox(staff)).toHaveLength(1);
  }, 30000);

  it("14. reprocessing after a crash (event back to pending) does not reset a notification already read", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");
    await processNotificationEvent(db, eventId);
    const readAt = Timestamp.fromDate(new Date("2026-10-05T11:00:00Z"));
    await markNotificationRead(db, order.customerId, customerScope(), `${eventId}.customer`, readAt);
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId)
      .update({status: "pending", attempts: 0, processedAt: Timestamp.now()});

    const again = await processNotificationEvent(db, eventId);

    expect(again).toEqual({kind: "processed", delivered: 1});
    const received = await inbox(order.customerId);
    expect(received).toHaveLength(1);
    expect(received[0].readAt).toEqual(readAt);
    expect(await countUnreadNotifications(db, order.customerId, customerScope())).toBe(0);
  });

  it("13. a partly delivered fan-out converges on retry: nobody is missed, nobody gets two", async () => {
    const org = await buildOrg();
    const manager = await addMember(org, "manager");
    const staff = await addMember(org, "staff");
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_confirmed");
    for (const userId of [order.customerId, org.ownerId, manager, staff]) {
      expectInboxOf(userId, eventId);
    }

    await expect(processNotificationEvent(db, eventId, {channels: [channelFailingAfter(2)]}))
      .rejects.toThrow("connection reset");

    const afterFailure = [order.customerId, org.ownerId, manager, staff];
    let delivered = 0;
    for (const userId of afterFailure) {
      delivered += (await inbox(userId)).length;
    }
    expect(delivered).toBe(2);
    expect(await eventDoc(eventId)).toMatchObject({status: "pending", attempts: 1});

    const retry = await processNotificationEvent(db, eventId);

    expect(retry).toEqual({kind: "processed", delivered: 4});
    for (const userId of afterFailure) {
      expect(await inbox(userId)).toHaveLength(1);
    }
    expect(await eventDoc(eventId)).toMatchObject({status: "processed", attempts: 2});
  });
});

describe("the retry model", () => {
  it("a transient failure counts the attempt, records a bounded error, and is rethrown for the trigger's retry", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");
    const noisy: NotificationChannel = {
      name: "in_app",
      async deliver() {
        throw new Error(`14 UNAVAILABLE ${"x".repeat(2000)}`);
      },
    };

    await expect(processNotificationEvent(db, eventId, {channels: [noisy]})).rejects.toThrow("14 UNAVAILABLE");

    const event = await eventDoc(eventId);
    expect(event).toMatchObject({status: "pending", attempts: 1});
    expect(event.lastAttemptAt).toBeInstanceOf(Timestamp);
    expect((event.lastError as string).length).toBeLessThanOrEqual(300);
    expect(event.lastError).toContain("14 UNAVAILABLE");
    expect(event.processedAt).toBeUndefined();
  });

  it("the fifth failed attempt marks the event failed and RETURNS — no rethrow, so no hot loop", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");

    for (let attempt = 1; attempt < MAX_NOTIFICATION_ATTEMPTS; attempt++) {
      await expect(processNotificationEvent(db, eventId, {channels: [alwaysFailing]})).rejects.toThrow();
      expect(await eventDoc(eventId)).toMatchObject({status: "pending", attempts: attempt});
    }
    const last = await processNotificationEvent(db, eventId, {channels: [alwaysFailing]});

    expect(last).toMatchObject({kind: "failed"});
    expect(await eventDoc(eventId)).toMatchObject({status: "failed", attempts: MAX_NOTIFICATION_ATTEMPTS});
    expect(await inbox(order.customerId)).toEqual([]);
  });

  it("a failed event is left alone by any later delivery, even with a working channel", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready", {status: "failed", attempts: MAX_NOTIFICATION_ATTEMPTS});

    const result = await processNotificationEvent(db, eventId);

    expect(result).toEqual({kind: "skipped", reason: "already_failed"});
    expect(await inbox(order.customerId)).toEqual([]);
    expect(await eventDoc(eventId)).toMatchObject({status: "failed", attempts: MAX_NOTIFICATION_ATTEMPTS});
  });

  it("a pending event that already used every attempt (earlier runs died) is failed without any work", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready", {attempts: MAX_NOTIFICATION_ATTEMPTS});

    const result = await processNotificationEvent(db, eventId);

    expect(result).toMatchObject({kind: "failed", reason: `Gave up after ${MAX_NOTIFICATION_ATTEMPTS} attempts.`});
    expect(await eventDoc(eventId)).toMatchObject({status: "failed", attempts: MAX_NOTIFICATION_ATTEMPTS});
    expect(await inbox(order.customerId)).toEqual([]);
  });

  it("a transient failure early on, then success, ends processed with the error cleared", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");
    await expect(processNotificationEvent(db, eventId, {channels: [alwaysFailing]})).rejects.toThrow();

    await processNotificationEvent(db, eventId);

    const event = await eventDoc(eventId);
    expect(event).toMatchObject({status: "processed", attempts: 2});
    expect(event.lastError).toBeUndefined();
  });
});

describe("permanent failures are failed at once, never retried, and never notify", () => {
  async function expectPermanentFailure(eventId: string, reason: RegExp, order: SeededOrder) {
    const result = await processNotificationEvent(db, eventId);

    expect(result.kind).toBe("failed");
    expect((result as {reason: string}).reason).toMatch(reason);
    expect(await eventDoc(eventId)).toMatchObject({status: "failed", attempts: 1});
    expect((await eventDoc(eventId)).lastError).toMatch(reason);
    expect(await inbox(order.customerId)).toEqual([]);
  }

  it("an event for an order that does not exist", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    await order.ref.delete();
    const eventId = await writeEvent(order, "order_ready");

    await expectPermanentFailure(eventId, /does not exist/, order);
  });

  it("an event whose order has not reached the status it reports", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_ready");

    await expectPermanentFailure(eventId, /has not reached/, order);
  });

  it("an event whose order belongs to a different customer", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready", {customerUserId: freshUserId()});
    const stranger = (await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).get()).data()?.customerUserId as string;
    expectInboxOf(stranger, eventId);

    const result = await processNotificationEvent(db, eventId);

    expect(result).toMatchObject({kind: "failed", reason: "The order does not match the event it produced."});
    expect(await inbox(stranger)).toEqual([]);
    expect(await inbox(order.customerId)).toEqual([]);
  });

  it("an event whose order has moved past it is still delivered (a late event for a real transition)", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "picked_up");
    const eventId = await writeEvent(order, "order_ready");

    const result = await processNotificationEvent(db, eventId);

    expect(result).toEqual({kind: "processed", delivered: 1});
  });

  it("a malformed event document", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = notificationEventId(order.id, "order_ready");
    const ref = db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId);
    created.push(ref);
    await ref.set({id: eventId, type: "order_ready", status: "pending"});

    const result = await processNotificationEvent(db, eventId);

    expect(result.kind).toBe("failed");
    expect(await eventDoc(eventId)).toMatchObject({status: "failed"});
    expect(await inbox(order.customerId)).toEqual([]);
  });

  it("an event that is not there", async () => {
    expect(await processNotificationEvent(db, `no-such-order_order_ready`))
      .toEqual({kind: "skipped", reason: "missing"});
  });
});

describe("the recipient cap", () => {
  it("delivers to the first 200, marks the event failed with the reason, and does not pretend everyone was told", async () => {
    const org = await buildOrg();
    for (let i = 0; i < NOTIFICATION_RECIPIENT_CAP + 1; i += 100) {
      const batch = db.batch();
      for (let j = i; j < Math.min(i + 100, NOTIFICATION_RECIPIENT_CAP + 1); j++) {
        const userId = `U-cap-${randomUUID()}`;
        const ref = db.collection("organizations").doc(org.organizationId).collection("members").doc(userId);
        created.push(ref);
        batch.set(ref, {userId, organizationId: org.organizationId, role: "staff", status: "active", createdAt: Timestamp.now()});
      }
      await batch.commit();
    }
    // 201 staff + the owner = 202 active members.
    const order = await seedOrder(org, "confirmed");
    const eventId = await writeEvent(order, "order_confirmed");

    const result = await processNotificationEvent(db, eventId);

    expect(result).toMatchObject({kind: "failed"});
    expect((result as {reason: string}).reason).toContain("More than 200 active members");
    expect(await eventDoc(eventId)).toMatchObject({status: "failed", attempts: 1});
    expect((await eventDoc(eventId)).lastError).toContain("first 200");

    const members = await db.collection("organizations").doc(org.organizationId).collection("members").get();
    let notified = 0;
    for (const member of members.docs) {
      const snapshot = await notificationsCollection(db, member.id).doc(`${eventId}.org`).get();
      if (snapshot.exists) {
        created.push(snapshot.ref);
        notified++;
      }
    }
    expect(notified).toBe(NOTIFICATION_RECIPIENT_CAP);
    expect(await inbox(order.customerId)).toHaveLength(1);
  }, 60000);
});

describe("the trigger body", () => {
  it("handleNotificationEventCreated processes exactly the event it is given", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const other = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");
    const untouchedEventId = await writeEvent(other, "order_ready");

    await handleNotificationEventCreated(db, eventId);

    expect(await inbox(order.customerId)).toHaveLength(1);
    expect(await inbox(other.customerId)).toEqual([]);
    expect(await eventDoc(untouchedEventId)).toMatchObject({status: "pending", attempts: 0});
  });

  it("lets a transient failure propagate so the platform retries", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "ready");
    const eventId = await writeEvent(order, "order_ready");
    const flaky = new Proxy(db, {
      get(target, property) {
        if (property === "collection") {
          return (name: string) => {
            if (name === "organizations") {
              throw new Error("14 UNAVAILABLE");
            }
            return target.collection(name);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(handleNotificationEventCreated(flaky, eventId)).rejects.toThrow("14 UNAVAILABLE");

    expect(await eventDoc(eventId)).toMatchObject({status: "pending", attempts: 1});
  });
});

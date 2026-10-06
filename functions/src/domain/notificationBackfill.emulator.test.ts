// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {backfillRefundNotifications} from "./notificationBackfill";
import {
  NOTIFICATION_EVENTS_COLLECTION,
  buildNotificationEvent,
  buildRefundNotificationEvent,
  type RefundNotificationEventType,
} from "./notificationEvents";
import {customerScope, markNotificationRead, notificationId, notificationsCollection} from "./notifications";
import type {Order} from "./orders";
import {cleanupScenarios, seedScenario, type Scenario} from "./refundScenario.fake";
import type {Refund} from "./refunds";

/**
 * The one-shot sweep for refund notification events created while nothing consumed them
 * (`notificationBackfill.ts`), against a REAL Firestore emulator: it picks up exactly the pending
 * refund events, in ID order and bounded; never touches order events, processed or failed events,
 * or excluded orders; is idempotent and a dry run writes nothing.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// Its own Firestore project: the sweep queries the whole `notificationEvents` collection, which
// must hold only this file's events.
const PROJECT_ID = "demo-zesto-notification-backfill";
let db: Firestore;

vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

const usersTouched = new Set<string>();
const created: DocumentReference[] = [];

afterEach(async () => {
  await cleanupScenarios(db);
  for (const userId of usersTouched) {
    await db.recursiveDelete(db.collection("users").doc(userId));
  }
  usersTouched.clear();
  await Promise.all(created.splice(0).map((ref) => ref.delete()));
  const events = await db.collection(NOTIFICATION_EVENTS_COLLECTION).get();
  await Promise.all(events.docs.map((doc) => doc.ref.delete()));
});

interface SeededRefundEvent {
  scenario: Scenario;
  eventId: string;
  customerId: string;
}

/** A refund in the state `type` reports, plus its pending outbox event, as 7.5 left them. */
async function seedRefundEvent(
  type: RefundNotificationEventType,
  event: Record<string, unknown> = {},
): Promise<SeededRefundEvent> {
  const scenario = await seedScenario(db, {
    refundStatus: type === "refund_failed" ? "failed" : type === "refund_completed" ? "processed" : "requested",
  });
  const outletRef = db.collection("organizations").doc(scenario.organizationId).collection("outlets").doc(scenario.loc.outletId);
  created.push(outletRef);
  await outletRef.set({id: scenario.loc.outletId, name: "Main Canteen"});
  const ownerRef = db.collection("organizations").doc(scenario.organizationId).collection("members").doc(`U-owner-${randomUUID().slice(0, 8)}`);
  created.push(ownerRef);
  await ownerRef.set({userId: ownerRef.id, organizationId: scenario.organizationId, role: "owner", status: "active", createdAt: Timestamp.now()});
  usersTouched.add(ownerRef.id);

  const refund = (await scenario.refundRef.get()).data() as Refund;
  const built = buildRefundNotificationEvent(refund, type, Timestamp.now());
  await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(built.id).set({...built, ...event});
  usersTouched.add(refund.userId);
  return {scenario, eventId: built.id, customerId: refund.userId};
}

async function statusOf(eventId: string): Promise<Record<string, unknown>> {
  return (await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).get()).data() ?? {};
}

async function notificationCount(eventId: string): Promise<number> {
  return (await db.collectionGroup("notifications").where("eventId", "==", eventId).get()).size;
}

describe("the sweep", () => {
  it("processes pending refund events of all three types, each exactly as the trigger would", async () => {
    const requested = await seedRefundEvent("refund_requested");
    const completed = await seedRefundEvent("refund_completed");
    const failed = await seedRefundEvent("refund_failed");

    const result = await backfillRefundNotifications(db);

    expect(result).toMatchObject({dryRun: false, scanned: 3, processed: 3, excluded: 0, failed: 0, notProcessed: 0, nextCursor: null});
    expect(result.eventIds).toEqual([requested.eventId, completed.eventId, failed.eventId].sort());
    for (const {eventId} of [requested, completed, failed]) {
      expect(await statusOf(eventId)).toMatchObject({status: "processed", attempts: 1});
    }
    expect(await notificationCount(requested.eventId)).toBe(0);
    expect(await notificationCount(completed.eventId)).toBe(1);
    expect(await notificationCount(failed.eventId)).toBe(2);
  });

  it("is idempotent: a second sweep finds nothing, and changes nothing", async () => {
    const completed = await seedRefundEvent("refund_completed");
    await backfillRefundNotifications(db);
    const before = await statusOf(completed.eventId);

    const again = await backfillRefundNotifications(db);

    expect(again).toMatchObject({scanned: 0, processed: 0, nextCursor: null, eventIds: []});
    expect(await statusOf(completed.eventId)).toEqual(before);
    expect(await notificationCount(completed.eventId)).toBe(1);
  });

  it("does not reprocess processed or failed events", async () => {
    const processed = await seedRefundEvent("refund_completed", {status: "processed", attempts: 1, processedAt: Timestamp.now()});
    const failed = await seedRefundEvent("refund_failed", {status: "failed", attempts: 2, lastError: "boom"});

    const result = await backfillRefundNotifications(db);

    expect(result).toMatchObject({scanned: 0, processed: 0});
    expect(await statusOf(processed.eventId)).toMatchObject({status: "processed", attempts: 1});
    expect(await statusOf(failed.eventId)).toMatchObject({status: "failed", attempts: 2, lastError: "boom"});
    expect(await notificationCount(processed.eventId)).toBe(0);
    expect(await notificationCount(failed.eventId)).toBe(0);
  });

  it("only pending events count towards a page: settled ones sorting ahead of a pending one cannot hide it", async () => {
    // Settled events whose IDs sort before any auto-generated one, one per refund type.
    for (const type of ["refund_requested", "refund_completed", "refund_failed"] as const) {
      const id = `0000-r1_${type}`;
      await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(id).set({
        id, type, orderId: "0000", organizationId: "o", outletId: "x", menuId: "m", customerUserId: "U-0",
        occurredAt: Timestamp.now(), status: "processed", attempts: 1, refundId: "0000-r1", paymentId: "0000",
      });
    }
    const pending = await seedRefundEvent("refund_completed");

    const result = await backfillRefundNotifications(db, {limit: 1});

    expect(result.eventIds).toEqual([pending.eventId]);
    expect(result).toMatchObject({scanned: 1, processed: 1});
  });

  it("never selects an order event, however pending", async () => {
    const orderEvent = buildNotificationEvent({id: "order-1", userId: "U-1", organizationId: "o", outletId: "x", menuId: "m"} as Order, "order_confirmed", Timestamp.now());
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(orderEvent.id).set(orderEvent);
    const refund = await seedRefundEvent("refund_completed");

    const result = await backfillRefundNotifications(db);

    expect(result.eventIds).toEqual([refund.eventId]);
    expect(await statusOf(orderEvent.id)).toMatchObject({status: "pending", attempts: 0});
  });

  it("a dry run lists what it would do and writes nothing", async () => {
    const completed = await seedRefundEvent("refund_completed");
    const before = await statusOf(completed.eventId);

    const result = await backfillRefundNotifications(db, {dryRun: true});

    expect(result).toMatchObject({dryRun: true, scanned: 1, processed: 0, eventIds: [completed.eventId]});
    expect(await statusOf(completed.eventId)).toEqual(before);
    expect(await notificationCount(completed.eventId)).toBe(0);
  });

  it("leaves excluded orders alone (they are counted, never processed)", async () => {
    const kept = await seedRefundEvent("refund_completed");
    const excluded = await seedRefundEvent("refund_completed");

    const result = await backfillRefundNotifications(db, {excludeOrderIds: [excluded.scenario.orderId]});

    expect(result).toMatchObject({scanned: 2, processed: 1, excluded: 1});
    expect(result.eventIds).toEqual([kept.eventId]);
    expect(await statusOf(kept.eventId)).toMatchObject({status: "processed"});
    expect(await statusOf(excluded.eventId)).toMatchObject({status: "pending", attempts: 0});
    expect(await notificationCount(excluded.eventId)).toBe(0);
  });

  it("is bounded and deterministic: pages in event-ID order, a cursor continues, and the pages together cover everything once", async () => {
    const seeded = [] as SeededRefundEvent[];
    for (const type of ["refund_completed", "refund_failed", "refund_requested", "refund_completed", "refund_failed"] as const) {
      seeded.push(await seedRefundEvent(type));
    }
    const allIds = seeded.map((s) => s.eventId).sort();

    const dry = await backfillRefundNotifications(db, {limit: 2, dryRun: true});
    expect(dry.eventIds).toEqual(allIds.slice(0, 2));
    expect(dry.nextCursor).toBe(allIds[1]);

    const pages: string[][] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await backfillRefundNotifications(db, {limit: 2, ...(after !== undefined ? {after} : {})});
      pages.push(result.eventIds);
      if (result.nextCursor === null) {
        break;
      }
      after = result.nextCursor;
    }

    expect(pages.flat()).toEqual(allIds);
    expect(pages.every((ids) => ids.length <= 2)).toBe(true);
    for (const {eventId} of seeded) {
      expect(await statusOf(eventId)).toMatchObject({status: "processed", attempts: 1});
    }
  });

  it("clamps the limit to its bounds", async () => {
    await seedRefundEvent("refund_completed");
    await seedRefundEvent("refund_completed");

    expect((await backfillRefundNotifications(db, {limit: 0, dryRun: true})).eventIds).toHaveLength(1);
    expect((await backfillRefundNotifications(db, {limit: -5, dryRun: true})).eventIds).toHaveLength(1);
    expect((await backfillRefundNotifications(db, {limit: 100000, dryRun: true})).eventIds).toHaveLength(2);
  });

  it("racing the live trigger, or a repeat, cannot duplicate a notification or reset a readAt", async () => {
    const completed = await seedRefundEvent("refund_completed");

    await Promise.all([backfillRefundNotifications(db), backfillRefundNotifications(db)]);
    expect(await notificationCount(completed.eventId)).toBe(1);

    const id = notificationId(completed.eventId, "customer");
    const readAt = Timestamp.fromDate(new Date("2026-10-06T12:00:00Z"));
    await markNotificationRead(db, completed.customerId, customerScope(), id, readAt);
    // Put the event back to pending (as a replay would) and sweep again.
    await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(completed.eventId).update({status: "pending", attempts: 0});
    await backfillRefundNotifications(db);

    const notification = (await notificationsCollection(db, completed.customerId).doc(id).get()).data();
    expect((notification?.readAt as Timestamp).isEqual(readAt)).toBe(true);
    expect(await notificationCount(completed.eventId)).toBe(1);
  });

  it("an event that cannot be delivered ends failed without stopping the rest of the sweep", async () => {
    const good = await seedRefundEvent("refund_completed");
    // A refund event whose refund does not exist: permanent failure.
    const orphan = await seedRefundEvent("refund_completed");
    await orphan.scenario.refundRef.delete();

    const result = await backfillRefundNotifications(db);

    expect(result).toMatchObject({scanned: 2, processed: 1, failed: 1});
    expect(await statusOf(good.eventId)).toMatchObject({status: "processed"});
    expect(await statusOf(orphan.eventId)).toMatchObject({status: "failed"});
  });
});

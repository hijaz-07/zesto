// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMembership} from "../auth/membership";
import {createFakeRefundGateway} from "../providers/refundGateway.fake";
import {handleNotificationEventCreated} from "./notificationEventTrigger";
import * as notificationEvents from "./notificationEvents";
import {NOTIFICATION_EVENTS_COLLECTION} from "./notificationEvents";
import {processNotificationEvent} from "./notificationProcessor";
import {notificationId} from "./notifications";
import {cancelOrder} from "./orderCancellation";
import {markPaymentSucceeded} from "./payments";
import {receiveRazorpayWebhook} from "./razorpayWebhooks";
import {createRefundRetry} from "./refundRetry";
import {
  AMOUNT,
  auditNames,
  cleanupScenarios,
  expectAccounting,
  loadRefund,
  loadState,
  manualClock,
  providerPaymentFor,
  seedScenario,
  type Scenario,
} from "./refundScenario.fake";
import {submitRefund} from "./refundSubmission";
import {applyRefundEvidence} from "./refundTransitions";

/**
 * The refund event boundary: the outbox events a later checkpoint consumes. Each logical
 * fact (a refund requested, completed, failed) produces exactly one deterministic
 * `notificationEvents/{refundId}_{type}` document, written in the SAME transaction as
 * the refund transition it reports — proved here by injecting a failure into the event
 * write and observing that the transition did not commit — and never twice, however
 * often a webhook or a retry repeats, or in whatever order events arrive.
 */

// Wraps (does not replace) the real recorder, so a test can make exactly one call throw.
vi.mock("./notificationEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notificationEvents")>();
  return {...actual, recordRefundNotificationEvent: vi.fn(actual.recordRefundNotificationEvent)};
});

const PROJECT_ID = "demo-zesto-refund-events";
let db: Firestore;

vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

afterEach(async () => {
  vi.mocked(notificationEvents.recordRefundNotificationEvent).mockClear();
  await cleanupScenarios(db);
  const events = await db.collection(NOTIFICATION_EVENTS_COLLECTION).get();
  await Promise.all(events.docs.map((doc) => doc.ref.delete()));
});

type EventDoc = Record<string, unknown>;

/** The order's REFUND events only: its cancellation events are covered by `cancellationNotifications.emulator.test.ts`. */
async function eventsOf(s: Scenario): Promise<Record<string, EventDoc>> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", s.orderId).get();
  return Object.fromEntries(
    snapshot.docs.filter((doc) => String(doc.data().type).startsWith("refund_")).map((doc) => [doc.id, doc.data()]),
  );
}

const idsOf = async (s: Scenario) => Object.keys(await eventsOf(s)).sort();

function gatewayFor(s: Scenario) {
  const gateway = createFakeRefundGateway();
  gateway.addPayment(providerPaymentFor(s));
  return gateway;
}

let seq = 0;
function webhook(type: string, s: Scenario, status: string, refundId = "rfnd_evt_1"): Buffer {
  return Buffer.from(JSON.stringify({
    entity: "event", event: type,
    payload: {refund: {entity: {
      id: refundId, payment_id: s.providerPaymentId, amount: s.amount, currency: "INR", status,
      receipt: s.loc.refundId, notes: {zestoRefundId: s.loc.refundId, zestoOrderId: s.orderId},
    }}},
  }));
}
const deliver = (body: Buffer, id = `evt_${++seq}_${randomUUID().slice(0, 6)}`) =>
  receiveRazorpayWebhook(db, {rawBody: body, eventIdHeader: id});

const owner = (organizationId: string): OrganizationMembership => ({
  userId: `U-${randomUUID().slice(0, 8)}`, organizationId, role: "owner", status: "active",
});

async function makeUncaptured(s: Scenario): Promise<void> {
  await s.orderRef.update({paymentStatus: "pending"});
  await s.paymentRef.update({
    status: "pending",
    providerPaymentId: FieldValue.delete(),
    capturedAmountInPaise: FieldValue.delete(),
    refundedAmountInPaise: FieldValue.delete(),
    refundPendingInPaise: FieldValue.delete(),
    refundSeq: FieldValue.delete(),
    refundState: FieldValue.delete(),
  });
}

describe("refund_requested", () => {
  it("a cancellation's refund produces exactly one event, with the right fields, and a repeated cancel adds none", async () => {
    const s = await seedScenario(db, {noRefund: true, orderStatus: "confirmed"});
    const actor = {kind: "organization" as const, membership: owner(s.organizationId)};

    await cancelOrder(db, {actor, orderId: s.orderId, reason: "outlet_closed"});
    const afterFirst = await eventsOf(s);
    await cancelOrder(db, {actor, orderId: s.orderId, reason: "outlet_closed"});

    expect(Object.keys(afterFirst)).toEqual([`${s.loc.refundId}_refund_requested`]);
    expect(await eventsOf(s)).toEqual(afterFirst);
    const refund = await loadRefund(s);
    expect(afterFirst[`${s.loc.refundId}_refund_requested`]).toMatchObject({
      id: `${s.loc.refundId}_refund_requested`,
      type: "refund_requested",
      refundId: s.loc.refundId,
      orderId: s.orderId,
      paymentId: s.orderId,
      organizationId: s.organizationId,
      outletId: s.loc.outletId,
      menuId: s.loc.menuId,
      customerUserId: refund.userId,
      providerPaymentId: s.providerPaymentId,
      amountInPaise: AMOUNT,
      status: "pending",
      attempts: 0,
    });
    expect(afterFirst[`${s.loc.refundId}_refund_requested`]).not.toHaveProperty("providerRefundId");
    // The event's time is the transition's own time: the refund's creation time, to the millisecond.
    expect((afterFirst[`${s.loc.refundId}_refund_requested`].occurredAt as Timestamp).isEqual(refund.createdAt as Timestamp)).toBe(true);
  });

  it("cancelling an UNPAID order creates no refund and so no refund event", async () => {
    const s = await seedScenario(db, {noRefund: true, orderStatus: "confirmed"});
    await makeUncaptured(s);
    await s.orderRef.update({status: "pending_payment"});

    await cancelOrder(db, {actor: {kind: "organization", membership: owner(s.organizationId)}, orderId: s.orderId, reason: "outlet_closed"});

    expect(await idsOf(s)).toEqual([]);
  });

  it("a payment captured after cancellation produces one event however often the capture is reported, and no order_confirmed", async () => {
    const s = await seedScenario(db, {noRefund: true, orderStatus: "cancelled"});
    await makeUncaptured(s);
    const input = {orderId: s.orderId, paymentId: s.orderId, amountInPaise: AMOUNT, currency: "INR", providerPaymentId: s.providerPaymentId};

    await Promise.all([markPaymentSucceeded(db, input), markPaymentSucceeded(db, input)]);
    await markPaymentSucceeded(db, input);

    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_requested`]);
    expect((await loadRefund(s)).reason).toBe("late_capture_after_cancel");
  });

  it("a retry after a failed refund produces its own event for the NEW refund and leaves the old refund's events alone", async () => {
    const s = await seedScenario(db);
    await applyRefundEvidence(db, s.loc, {kind: "definitive_rejection", code: "BAD_REQUEST_ERROR", message: "no", source: "submit"});
    const before = await eventsOf(s);

    const result = await createRefundRetry(db, {location: s.loc, initiatedBy: "U-mgr", initiatedByRole: "organization"});

    expect(result).toEqual({kind: "created", refundId: `${s.orderId}-r2`});
    const after = await eventsOf(s);
    expect(Object.keys(after).sort()).toEqual([`${s.orderId}-r1_refund_failed`, `${s.orderId}-r2_refund_requested`]);
    expect(after[`${s.orderId}-r1_refund_failed`]).toEqual(before[`${s.orderId}-r1_refund_failed`]);
  });

  it("an adopted external refund is flagged for a person and produces no event", async () => {
    const s = await seedScenario(db, {amount: 20000, refundStatus: "processed", refundedInPaise: 5000, refund: {amountInPaise: 5000}});

    await deliver(Buffer.from(JSON.stringify({
      entity: "event", event: "refund.processed",
      payload: {refund: {entity: {
        id: "rfnd_dashboard", payment_id: s.providerPaymentId, amount: 7000, currency: "INR", status: "processed",
        receipt: null, notes: [],
      }}},
    })));

    expect(Object.keys((await loadState(s)).refunds)).toHaveLength(2);
    expect(await idsOf(s)).toEqual([]);
  });
});

describe("refund_completed", () => {
  it("is produced once when the provider settles the refund through the submit driver, with the provider's refund ID", async () => {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    gateway.nextRefundStatus("processed");

    await submitRefund(db, gateway, s.loc, {now: manualClock().now});

    const events = await eventsOf(s);
    expect(Object.keys(events)).toEqual([`${s.loc.refundId}_refund_completed`]);
    const refund = await loadRefund(s);
    expect(events[`${s.loc.refundId}_refund_completed`]).toMatchObject({
      type: "refund_completed", refundId: s.loc.refundId, orderId: s.orderId, paymentId: s.orderId,
      organizationId: s.organizationId, outletId: s.loc.outletId, customerUserId: refund.userId,
      providerPaymentId: s.providerPaymentId, providerRefundId: "rfnd_fake_1", amountInPaise: AMOUNT,
      status: "pending", attempts: 0,
    });
    expect((events[`${s.loc.refundId}_refund_completed`].occurredAt as Timestamp).isEqual(refund.processedAt as Timestamp)).toBe(true);
  });

  it("moving to pending is internal progress and emits nothing; settling later emits exactly one", async () => {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    const clock = manualClock();
    await submitRefund(db, gateway, s.loc, {now: clock.now});
    expect(await idsOf(s)).toEqual([]);

    await deliver(webhook("refund.processed", s, "processed", (await loadRefund(s)).providerRefundId as string));

    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_completed`]);
    await expectAccounting(s);
  });

  it("a duplicate webhook, a redelivery under a new event ID and a concurrent pair all leave one unchanged event", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});
    const body = webhook("refund.processed", s, "processed");

    await deliver(body, "evt_same");
    const first = await eventsOf(s);
    const duplicate = await deliver(body, "evt_same");
    await deliver(body, "evt_other_id");
    await Promise.all([deliver(body, "evt_c1"), deliver(body, "evt_c2")]);

    expect(duplicate).toMatchObject({kind: "duplicate"});
    expect(Object.keys(first)).toEqual([`${s.loc.refundId}_refund_completed`]);
    expect(await eventsOf(s)).toEqual(first);
    expect((await expectAccounting(s)).payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0});
  });

  it("a webhook and the submit driver settling at the same moment produce one event", async () => {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    gateway.nextRefundStatus("processed");

    await Promise.all([
      submitRefund(db, gateway, s.loc, {now: manualClock().now}),
      deliver(webhook("refund.processed", s, "processed")),
    ]);

    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_completed`]);
    await expectAccounting(s);
  });
});

describe("refund_failed", () => {
  it("a definitive provider rejection produces one event with no provider refund ID", async () => {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    gateway.script("createRefund", {rejectWith: "BAD_REQUEST_ERROR"});

    await submitRefund(db, gateway, s.loc, {now: manualClock().now});

    const events = await eventsOf(s);
    expect(Object.keys(events)).toEqual([`${s.loc.refundId}_refund_failed`]);
    expect(events[`${s.loc.refundId}_refund_failed`]).toMatchObject({
      type: "refund_failed", refundId: s.loc.refundId, orderId: s.orderId, amountInPaise: AMOUNT, status: "pending",
    });
    expect(events[`${s.loc.refundId}_refund_failed`]).not.toHaveProperty("providerRefundId");
    const refund = await loadRefund(s);
    expect((events[`${s.loc.refundId}_refund_failed`].occurredAt as Timestamp).isEqual(refund.failedAt as Timestamp)).toBe(true);
  });

  it("a refund.failed webhook produces one event, however often it is repeated", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});
    const body = webhook("refund.failed", s, "failed");

    await deliver(body, "evt_f");
    await deliver(body, "evt_f");
    await deliver(body, "evt_f2");

    const events = await eventsOf(s);
    expect(Object.keys(events)).toEqual([`${s.loc.refundId}_refund_failed`]);
    expect(events[`${s.loc.refundId}_refund_failed`]).toMatchObject({providerRefundId: "rfnd_evt_1"});
  });

  it("an ambiguous or retryable provider outcome is not a failure: no event", async () => {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    gateway.script("createRefund", "unknown_after_apply");

    await submitRefund(db, gateway, s.loc, {now: manualClock().now});

    expect(await idsOf(s)).toEqual([]);
  });
});

describe("out-of-order and contradictory events never produce a second or conflicting event", () => {
  it("processed, then a late failed: only refund_completed exists", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});

    await deliver(webhook("refund.processed", s, "processed"));
    const result = await deliver(webhook("refund.failed", s, "failed"));

    expect(result).toMatchObject({outcome: "rejected_refund_contradicts_terminal_state"});
    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_completed`]);
  });

  it("failed, then a late processed: only refund_failed exists", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});

    await deliver(webhook("refund.failed", s, "failed"));
    await deliver(webhook("refund.processed", s, "processed"));

    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_failed`]);
  });

  it("a stale refund.created (pending) after the terminal event adds nothing", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});
    await deliver(webhook("refund.processed", s, "processed"));
    const before = await eventsOf(s);

    const result = await deliver(webhook("refund.created", s, "pending"));

    expect(result).toMatchObject({outcome: "refund_noop_stale_event"});
    expect(await eventsOf(s)).toEqual(before);
  });

  it("the terminal webhook arriving BEFORE the create response, then the response, yields one event", async () => {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    const original = gateway.createRefund.bind(gateway);
    gateway.createRefund = async (input) => {
      const created = await original(input);
      await deliver(webhook("refund.processed", s, "processed", created.id));
      return created;
    };

    await submitRefund(db, gateway, s.loc, {now: manualClock().now});

    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_completed`]);
    expect((await auditNames(s)).transitions).toEqual(["requested_to_processed"]);
  });
});

describe("atomicity with the transition", () => {
  const recorder = () => vi.mocked(notificationEvents.recordRefundNotificationEvent);

  it("if the event cannot be written, the refund, payment, order and audit record do not change either", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});
    const before = await loadState(s);
    recorder().mockImplementationOnce(() => {
      throw new Error("outbox unavailable");
    });

    await expect(applyRefundEvidence(db, s.loc, {
      kind: "provider_refund", source: "webhook", providerEventKey: "evt_x",
      providerRefund: {id: "rfnd_evt_1", providerPaymentId: s.providerPaymentId, amountInPaise: AMOUNT, currency: "INR", status: "processed"},
    })).rejects.toThrow("outbox unavailable");

    expect(await loadState(s)).toEqual(before);
    expect((await auditNames(s)).transitions).toEqual([]);
    expect(await idsOf(s)).toEqual([]);

    // The next attempt applies it, with exactly one event.
    await applyRefundEvidence(db, s.loc, {
      kind: "provider_refund", source: "webhook", providerEventKey: "evt_x",
      providerRefund: {id: "rfnd_evt_1", providerPaymentId: s.providerPaymentId, amountInPaise: AMOUNT, currency: "INR", status: "processed"},
    });
    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_completed`]);
    await expectAccounting(s);
  });

  it("a definitive rejection whose event cannot be written leaves the refund requested and its money reserved", async () => {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    gateway.script("createRefund", {rejectWith: "BAD_REQUEST_ERROR"});
    recorder().mockImplementationOnce(() => {
      throw new Error("outbox unavailable");
    });

    await expect(submitRefund(db, gateway, s.loc, {now: manualClock().now})).rejects.toThrow("outbox unavailable");

    expect(await loadRefund(s)).toMatchObject({status: "requested"});
    expect((await expectAccounting(s)).payment).toMatchObject({refundPendingInPaise: AMOUNT});
    expect(await idsOf(s)).toEqual([]);
  });

  it("a cancellation whose refund event cannot be written is not cancelled and reserves nothing", async () => {
    const s = await seedScenario(db, {noRefund: true, orderStatus: "confirmed"});
    const actor = {kind: "organization" as const, membership: owner(s.organizationId)};
    recorder().mockImplementationOnce(() => {
      throw new Error("outbox unavailable");
    });

    await expect(cancelOrder(db, {actor, orderId: s.orderId, reason: "outlet_closed"})).rejects.toThrow("outbox unavailable");

    const state = await loadState(s);
    expect(state.order.status).toBe("confirmed");
    expect(state.refunds).toEqual({});
    expect(state.payment.refundSeq).toBe(0);
    expect(await idsOf(s)).toEqual([]);

    await cancelOrder(db, {actor, orderId: s.orderId, reason: "outlet_closed"});
    expect(await idsOf(s)).toEqual([`${s.loc.refundId}_refund_requested`]);
    await expectAccounting(s);
  });

  it("when it does commit, the refund, the payment, the audit record and the event all carry the one transition time", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});

    await deliver(webhook("refund.processed", s, "processed"));

    const refund = await loadRefund(s);
    const state = await loadState(s);
    const events = await eventsOf(s);
    const audit = (await s.paymentRef.collection("refunds").doc(s.loc.refundId).collection("transitions").get()).docs[0].data();
    const at = refund.processedAt as Timestamp;
    expect((events[`${s.loc.refundId}_refund_completed`].occurredAt as Timestamp).isEqual(at)).toBe(true);
    expect((audit.at as Timestamp).isEqual(at)).toBe(true);
    expect((state.payment.updatedAt as Timestamp).isEqual(at)).toBe(true);
    expect((state.order.updatedAt as Timestamp).isEqual(at)).toBe(true);
  });
});

describe("the notification processor consumes refund events (Checkpoint 7.6 policy)", () => {
  it("a refund_completed event is processed once into one customer notification, and a repeat changes nothing", async () => {
    const s = await seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_evt_1"}});
    await deliver(webhook("refund.processed", s, "processed"));
    const id = `${s.loc.refundId}_refund_completed`;
    expect((await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(id).get()).data()).toMatchObject({
      status: "pending", attempts: 0,
    });

    const first = await processNotificationEvent(db, id);
    await handleNotificationEventCreated(db, id);

    expect(first).toEqual({kind: "processed", delivered: 1});
    expect((await db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(id).get()).data()).toMatchObject({
      status: "processed", attempts: 1,
    });
    const notifications = await db.collectionGroup("notifications").where("eventId", "==", id).get();
    const customerId = (await s.orderRef.get()).data()?.userId;
    expect(notifications.docs.map((doc) => [doc.ref.parent.parent?.id, doc.id])).toEqual([
      [customerId, notificationId(id, "customer")],
    ]);
  });
});

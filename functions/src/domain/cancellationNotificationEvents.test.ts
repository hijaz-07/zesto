// @vitest-environment node
import {Timestamp, type Firestore, type Transaction} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {
  CANCELLATION_NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPES,
  REFUND_NOTIFICATION_EVENT_TYPES,
  buildCancellationNotificationEvent,
  buildNotificationEvent,
  isCancellationNotificationEventType,
  isNotificationEventType,
  isRefundNotificationEventType,
  notificationEventId,
  parseNotificationEvent,
  recordCancellationNotificationEvent,
} from "./notificationEvents";
import type {Order} from "./orders";

const AT = Timestamp.fromDate(new Date("2026-10-06T10:00:00Z"));

const ORDER = {
  id: "order-1", userId: "U-customer", organizationId: "org-1", outletId: "outlet-1", menuId: "menu-1",
} as Order;

describe("the cancellation event types", () => {
  it("are exactly the three actors, and a separate family from the forward order events", () => {
    expect([...CANCELLATION_NOTIFICATION_EVENT_TYPES]).toEqual([
      "order_cancelled_by_customer", "order_cancelled_by_outlet", "order_cancelled_by_system",
    ]);
    expect([...NOTIFICATION_EVENT_TYPES]).toEqual([
      "order_confirmed", "order_preparing", "order_ready", "order_picked_up", "order_completed",
    ]);
    for (const type of CANCELLATION_NOTIFICATION_EVENT_TYPES) {
      expect(isCancellationNotificationEventType(type)).toBe(true);
      expect(isNotificationEventType(type)).toBe(false);
      expect(isRefundNotificationEventType(type)).toBe(false);
    }
  });

  it.each(["order_cancelled", "order_cancelled_by_staff", "refund_requested", "order_ready", "", undefined, 3])(
    "rejects %j", (value) => {
      expect(isCancellationNotificationEventType(value)).toBe(false);
    });

  it("never collide with each other, the forward events, or the refund events", () => {
    const ids = new Set<string>();
    for (const type of [...NOTIFICATION_EVENT_TYPES, ...CANCELLATION_NOTIFICATION_EVENT_TYPES]) {
      ids.add(notificationEventId("order-1", type));
    }
    expect(ids.size).toBe(NOTIFICATION_EVENT_TYPES.length + CANCELLATION_NOTIFICATION_EVENT_TYPES.length);
    expect(REFUND_NOTIFICATION_EVENT_TYPES).toHaveLength(3);
    expect(notificationEventId("order-1", "order_cancelled_by_customer")).toBe("order-1_order_cancelled_by_customer");
  });
});

describe("buildCancellationNotificationEvent", () => {
  it("is the order's coordinates and customer, pending, with the refund flag — and nothing else", () => {
    const event = buildCancellationNotificationEvent(ORDER, "order_cancelled_by_outlet", AT, true);

    expect(event).toEqual({
      id: "order-1_order_cancelled_by_outlet",
      type: "order_cancelled_by_outlet",
      orderId: "order-1",
      organizationId: "org-1",
      outletId: "outlet-1",
      menuId: "menu-1",
      customerUserId: "U-customer",
      occurredAt: AT,
      status: "pending",
      attempts: 0,
      refundInitiated: true,
    });
  });

  it("records an explicit false for an unpaid cancellation", () => {
    expect(buildCancellationNotificationEvent(ORDER, "order_cancelled_by_customer", AT, false).refundInitiated).toBe(false);
  });
});

describe("recordCancellationNotificationEvent", () => {
  it("buffers exactly one set on the deterministic document and reads nothing", () => {
    const writes: Array<{path: string; data: unknown}> = [];
    const db = {collection: (name: string) => ({doc: (id: string) => ({path: `${name}/${id}`})})} as unknown as Firestore;
    const tx = {
      set: (ref: {path: string}, data: unknown) => {
        writes.push({path: ref.path, data});
      },
      get: () => {
        throw new Error("recording an event must not read");
      },
    } as unknown as Transaction;

    recordCancellationNotificationEvent(db, tx, ORDER, "order_cancelled_by_customer", AT, false);

    expect(writes).toEqual([{
      path: "notificationEvents/order-1_order_cancelled_by_customer",
      data: buildCancellationNotificationEvent(ORDER, "order_cancelled_by_customer", AT, false),
    }]);
  });
});

describe("parseNotificationEvent — cancellation events", () => {
  const stored = () => buildCancellationNotificationEvent(ORDER, "order_cancelled_by_customer", AT, true);

  it("round-trips a cancellation event", () => {
    const event = stored();
    expect(parseNotificationEvent(event, event.id)).toEqual(event);
  });

  it("parses one without the flag (the field is optional on the wire)", () => {
    const rest: Record<string, unknown> = {...stored()};
    delete rest.refundInitiated;
    expect(parseNotificationEvent(rest, stored().id)).toEqual(rest);
  });

  it.each([
    ["an ID that is not order + type", {id: "order-1_order_cancelled_by_outlet"}],
    ["refund fields", {refundId: "order-1-r1"}],
    ["a payment ID", {paymentId: "order-1"}],
    ["an amount", {amountInPaise: 100}],
    ["a non-boolean flag", {refundInitiated: "yes"}],
  ])("rejects %s", (_name, override) => {
    expect(() => parseNotificationEvent({...stored(), ...override}, stored().id)).toThrow(/Malformed notification event/);
  });

  it("refuses the flag on a forward order event and on a refund event", () => {
    const forward = buildNotificationEvent(ORDER, "order_ready", AT);
    expect(() => parseNotificationEvent({...forward, refundInitiated: true}, forward.id)).toThrow(/Malformed/);
    const refund = {
      id: "order-1-r1_refund_failed", type: "refund_failed", orderId: "order-1", organizationId: "org-1", outletId: "outlet-1",
      menuId: "menu-1", customerUserId: "U-customer", occurredAt: AT, status: "pending", attempts: 0,
      refundId: "order-1-r1", paymentId: "order-1", refundInitiated: true,
    };
    expect(() => parseNotificationEvent(refund, refund.id)).toThrow(/Malformed/);
    expect(parseNotificationEvent({...refund, refundInitiated: undefined}, refund.id).type).toBe("refund_failed");
  });
});

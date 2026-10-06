// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {
  NOTIFICATION_EVENT_TYPES,
  REFUND_NOTIFICATION_EVENT_TYPES,
  buildNotificationEvent,
  buildRefundNotificationEvent,
  isRefundNotificationEventType,
  notificationEventId,
  parseNotificationEvent,
  refundNotificationEventId,
} from "./notificationEvents";
import type {Order} from "./orders";
import type {Refund} from "./refunds";

/**
 * The refund half of the notification outbox: the producer boundary a later checkpoint
 * consumes. Pure checks here (IDs, fields, parsing); the transactional behaviour — exactly
 * once, atomic with the transition — is in `refundNotificationEvents.emulator.test.ts`.
 */

const AT = Timestamp.fromDate(new Date("2026-09-24T10:00:00Z"));

const REFUND: Refund = {
  id: "ord1-r2",
  paymentId: "ord1",
  orderId: "ord1",
  organizationId: "org1",
  outletId: "out1",
  menuId: "menu1",
  userId: "U-customer",
  providerPaymentId: "pay_123",
  amountInPaise: 25000,
  currency: "INR",
  status: "processed",
  reason: "customer_cancelled",
  source: "cancellation",
  initiatedBy: "U-customer",
  initiatedByRole: "customer",
  idempotencyKey: "ord1-r2",
  providerRefundId: "rfnd_456",
  providerStatus: "processed",
  submitAttempts: 1,
  createdAt: AT,
  updatedAt: AT,
  processedAt: AT,
  attentionRequired: false,
};

describe("refund notification event types", () => {
  it("are exactly requested, completed and failed — and the order event types are unchanged", () => {
    expect([...REFUND_NOTIFICATION_EVENT_TYPES]).toEqual(["refund_requested", "refund_completed", "refund_failed"]);
    expect([...NOTIFICATION_EVENT_TYPES]).toEqual([
      "order_confirmed", "order_preparing", "order_ready", "order_picked_up", "order_completed",
    ]);
  });

  it("are recognised by their guard and no other string is", () => {
    for (const type of REFUND_NOTIFICATION_EVENT_TYPES) {
      expect(isRefundNotificationEventType(type)).toBe(true);
    }
    for (const value of ["order_confirmed", "refund_pending", "", undefined, 3]) {
      expect(isRefundNotificationEventType(value)).toBe(false);
    }
  });
});

describe("refundNotificationEventId", () => {
  it("is the refund's ID and the type: deterministic, one per refund per fact", () => {
    expect(refundNotificationEventId("ord1-r2", "refund_completed")).toBe("ord1-r2_refund_completed");
    expect(refundNotificationEventId("ord1-r2", "refund_completed")).toBe(refundNotificationEventId("ord1-r2", "refund_completed"));
  });

  it("never collides across refunds, types, or with an order event", () => {
    const ids = new Set<string>();
    for (const refundId of ["ord1-r1", "ord1-r2", "ord2-r1"]) {
      for (const type of REFUND_NOTIFICATION_EVENT_TYPES) {
        ids.add(refundNotificationEventId(refundId, type));
      }
    }
    for (const type of NOTIFICATION_EVENT_TYPES) {
      ids.add(notificationEventId("ord1", type));
    }
    expect(ids.size).toBe(3 * 3 + NOTIFICATION_EVENT_TYPES.length);
  });
});

describe("buildRefundNotificationEvent", () => {
  it("copies the refund's coordinates, customer and safe internal references, and starts pending", () => {
    expect(buildRefundNotificationEvent(REFUND, "refund_completed", AT)).toEqual({
      id: "ord1-r2_refund_completed",
      type: "refund_completed",
      orderId: "ord1",
      organizationId: "org1",
      outletId: "out1",
      menuId: "menu1",
      customerUserId: "U-customer",
      occurredAt: AT,
      status: "pending",
      attempts: 0,
      refundId: "ord1-r2",
      paymentId: "ord1",
      providerPaymentId: "pay_123",
      providerRefundId: "rfnd_456",
      amountInPaise: 25000,
    });
  });

  it("omits the provider refund ID while the provider has none (a refund that was just requested)", () => {
    const requested: Refund = {...REFUND, status: "requested"};
    delete requested.providerRefundId;

    const event = buildRefundNotificationEvent(requested, "refund_requested", AT);

    expect(event).not.toHaveProperty("providerRefundId");
    expect(event).toMatchObject({refundId: "ord1-r2", paymentId: "ord1", providerPaymentId: "pay_123"});
  });

  it("carries nothing about the customer beyond their user ID, and no idempotency key, reason, failure or audit data", () => {
    const keys = Object.keys(buildRefundNotificationEvent({...REFUND, failureCode: "x", failureMessage: "y"}, "refund_failed", AT));

    expect(keys.sort()).toEqual([
      "amountInPaise", "attempts", "customerUserId", "id", "menuId", "occurredAt", "orderId", "organizationId",
      "outletId", "paymentId", "providerPaymentId", "providerRefundId", "refundId", "status", "type",
    ]);
  });
});

describe("parseNotificationEvent — refund events", () => {
  const stored = () => buildRefundNotificationEvent(REFUND, "refund_failed", AT);

  it("round-trips a refund event", () => {
    const event = stored();
    expect(parseNotificationEvent(event, event.id)).toEqual(event);
  });

  it.each([
    ["an ID that is not the refund's deterministic ID", {id: "ord1-r2_refund_completed"}],
    ["a missing refund ID", {refundId: undefined}],
    ["a missing payment ID", {paymentId: undefined}],
    ["a refund ID that does not match the document ID", {refundId: "ord1-r9"}],
    ["a zero amount", {amountInPaise: 0}],
    ["a fractional amount", {amountInPaise: 10.5}],
  ])("rejects %s", (_name, override) => {
    const event = {...stored(), ...override};
    expect(() => parseNotificationEvent(event, stored().id)).toThrow(/Malformed notification event/);
  });

  it("still parses an order event exactly as before, and refuses one that carries refund fields", () => {
    const order = {id: "ord1", organizationId: "org1", outletId: "out1", menuId: "menu1", userId: "U-customer"} as Order;
    const event = buildNotificationEvent(order, "order_ready", AT);
    expect(parseNotificationEvent(event, event.id)).toEqual(event);
    expect(() => parseNotificationEvent({...event, refundId: "ord1-r1"}, event.id)).toThrow(/Malformed/);
    expect(() => parseNotificationEvent({...event, amountInPaise: 100}, event.id)).toThrow(/Malformed/);
  });
});

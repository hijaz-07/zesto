// @vitest-environment node
import {Timestamp, type Firestore, type Transaction} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {
  NOTIFICATION_EVENT_TYPES,
  buildNotificationEvent,
  isNotificationEventType,
  notificationEventId,
  parseNotificationEvent,
  recordNotificationEvent,
} from "./notificationEvents";
import type {Order} from "./orders";

const AT = Timestamp.fromDate(new Date("2026-10-05T10:00:00Z"));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    userId: "U-customer",
    organizationId: "org-1",
    outletId: "outlet-1",
    menuId: "menu-1",
    status: "confirmed",
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: 24000,
    totalInPaise: 24000,
    items: [{itemId: "item-1", name: "Chicken Biriyani", priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000}],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("notificationEventId", () => {
  it("is `${orderId}_${eventType}`", () => {
    expect(notificationEventId("order-1", "order_ready")).toBe("order-1_order_ready");
  });

  it("is deterministic and distinct per order and per type", () => {
    const ids = new Set<string>();
    for (const orderId of ["a", "b"]) {
      for (const type of NOTIFICATION_EVENT_TYPES) {
        ids.add(notificationEventId(orderId, type));
        expect(notificationEventId(orderId, type)).toBe(notificationEventId(orderId, type));
      }
    }
    expect(ids.size).toBe(2 * NOTIFICATION_EVENT_TYPES.length);
  });
});

describe("NOTIFICATION_EVENT_TYPES", () => {
  it("is exactly the five order lifecycle events — no cancellation/refund types yet", () => {
    expect([...NOTIFICATION_EVENT_TYPES]).toEqual([
      "order_confirmed", "order_preparing", "order_ready", "order_picked_up", "order_completed",
    ]);
  });

  it.each(["order_cancelled", "refund_requested", "", "ORDER_READY", "__proto__", 5, undefined])(
    "rejects %j as an event type", (value) => {
      expect(isNotificationEventType(value)).toBe(false);
    });
});

describe("buildNotificationEvent", () => {
  it("copies only the order's coordinates and customer, as a pending event with no attempts", () => {
    expect(buildNotificationEvent(order(), "order_confirmed", AT)).toEqual({
      id: "order-1_order_confirmed",
      type: "order_confirmed",
      orderId: "order-1",
      organizationId: "org-1",
      outletId: "outlet-1",
      menuId: "menu-1",
      customerUserId: "U-customer",
      occurredAt: AT,
      status: "pending",
      attempts: 0,
    });
  });

  it("carries no item, price, payment or credential data", () => {
    const keys = Object.keys(buildNotificationEvent(order(), "order_ready", AT)).sort();

    expect(keys).toEqual([
      "attempts", "customerUserId", "id", "menuId", "occurredAt", "orderId", "organizationId", "outletId",
      "status", "type",
    ]);
  });
});

describe("recordNotificationEvent", () => {
  it("buffers exactly one `set` on the deterministic event document, and reads nothing", () => {
    const writes: Array<{path: string; data: unknown}> = [];
    const db = {
      collection: (name: string) => ({doc: (id: string) => ({path: `${name}/${id}`})}),
    } as unknown as Firestore;
    const tx = {
      set: (ref: {path: string}, data: unknown) => {
        writes.push({path: ref.path, data});
      },
      get: () => {
        throw new Error("recording an event must not read");
      },
    } as unknown as Transaction;

    recordNotificationEvent(db, tx, order(), "order_confirmed", AT);

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("notificationEvents/order-1_order_confirmed");
    expect(writes[0].data).toEqual(buildNotificationEvent(order(), "order_confirmed", AT));
  });
});

describe("parseNotificationEvent", () => {
  const stored = () => buildNotificationEvent(order(), "order_ready", AT);

  it("parses a stored event", () => {
    expect(parseNotificationEvent(stored(), "order-1_order_ready")).toEqual(stored());
  });

  it("parses the bookkeeping fields a processed event carries", () => {
    const processed = {...stored(), status: "processed", attempts: 2, lastAttemptAt: AT, processedAt: AT};

    expect(parseNotificationEvent(processed, "order-1_order_ready").status).toBe("processed");
  });

  it.each([
    ["an id that is not the document id", {...stored(), id: "other"}],
    ["a type that does not match the document id", {...stored(), type: "order_confirmed"}],
    ["an order that does not match the document id", {...stored(), orderId: "order-2"}],
    ["an unknown type", {...stored(), type: "order_cancelled"}],
    ["an unknown status", {...stored(), status: "done"}],
    ["negative attempts", {...stored(), attempts: -1}],
    ["a missing customer", {...stored(), customerUserId: undefined}],
    ["an over-long lastError", {...stored(), lastError: "x".repeat(301)}],
    ["a non-object", "nope"],
  ])("rejects %s", (_label, data) => {
    expect(() => parseNotificationEvent(data, "order-1_order_ready")).toThrow(/Malformed notification event/);
  });
});

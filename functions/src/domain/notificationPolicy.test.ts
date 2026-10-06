// @vitest-environment node
import {describe, expect, it} from "vitest";
import {
  CANCELLATION_NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPES,
  REFUND_NOTIFICATION_EVENT_TYPES,
  type AnyNotificationEventType,
  type NotificationEventType,
} from "./notificationEvents";
import {
  CUSTOMER_NOTIFICATION_TYPES,
  NOTIFICATION_ORG_ROLES,
  NOTIFICATION_TYPES,
  notificationsForEvent,
  type NotificationCopyContext,
} from "./notificationPolicy";

const CONTEXT: NotificationCopyContext = {outletName: "Main Canteen"};

function customerDrafts(type: NotificationEventType) {
  return notificationsForEvent(type, CONTEXT).filter((draft) => draft.audience === "customer");
}

function orgDrafts(type: NotificationEventType) {
  return notificationsForEvent(type, CONTEXT).filter((draft) => draft.audience === "org");
}

describe("customer policy", () => {
  it.each([
    ["order_confirmed", "order_confirmed", "Order confirmed", "Your order from Main Canteen has been confirmed."],
    ["order_preparing", "order_preparing", "Being prepared", "Your order from Main Canteen is being prepared."],
    ["order_ready", "order_ready", "Ready for pickup", "Your order from Main Canteen is ready for pickup."],
    ["order_picked_up", "order_picked_up", "Picked up", "Your order from Main Canteen has been picked up."],
  ] as const)("%s produces exactly one customer notification", (event, type, title, body) => {
    expect(customerDrafts(event)).toEqual([{audience: "customer", type, title, body}]);
  });

  it("records order_completed but produces NO visible customer notification", () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain("order_completed");
    expect(customerDrafts("order_completed")).toEqual([]);
    expect(notificationsForEvent("order_completed", CONTEXT)).toEqual([]);
  });

  it("has no customer notification type for completed", () => {
    expect([...CUSTOMER_NOTIFICATION_TYPES]).not.toContain("order_completed");
    expect(NOTIFICATION_TYPES).not.toContain("order_completed");
  });
});

describe("organization policy", () => {
  it("order_confirmed produces exactly one new_order notification", () => {
    expect(orgDrafts("order_confirmed")).toEqual([
      {audience: "org", type: "new_order", title: "New order", body: "New order received from Main Canteen."},
    ]);
  });

  it.each(["order_preparing", "order_ready", "order_picked_up", "order_completed"] as const)(
    "%s produces no organization notification", (event) => {
      expect(orgDrafts(event)).toEqual([]);
    });

  it("notifies owners, managers and staff — and no other role", () => {
    expect([...NOTIFICATION_ORG_ROLES].sort()).toEqual(["manager", "owner", "staff"]);
  });
});

describe("copy", () => {
  it("degrades to complete sentences when the outlet's name is unknown", () => {
    expect(notificationsForEvent("order_ready", {})[0].body).toBe("Your order is ready for pickup.");
    expect(notificationsForEvent("order_confirmed", {}).map((draft) => draft.body)).toEqual([
      "Your order has been confirmed.",
      "New order received.",
    ]);
  });

  it("never carries an ID, an email, a payment reference or an order number", () => {
    for (const event of NOTIFICATION_EVENT_TYPES) {
      for (const draft of notificationsForEvent(event, CONTEXT)) {
        const text = `${draft.title} ${draft.body}`;
        expect(text).not.toMatch(/@|\d{5,}|order_|pay_|#/i);
        expect(draft.body.length).toBeLessThan(80);
      }
    }
  });

  it("is a pure function of its inputs", () => {
    expect(notificationsForEvent("order_ready", CONTEXT)).toEqual(notificationsForEvent("order_ready", CONTEXT));
  });
});

// ---------------------------------------------------------------------------
// Checkpoint 7.6: cancellation and refund notifications
// ---------------------------------------------------------------------------

const ALL_EVENT_TYPES: readonly AnyNotificationEventType[] = [
  ...NOTIFICATION_EVENT_TYPES, ...CANCELLATION_NOTIFICATION_EVENT_TYPES, ...REFUND_NOTIFICATION_EVENT_TYPES,
];

function draftsFor(type: AnyNotificationEventType, context = CONTEXT) {
  return notificationsForEvent(type, context);
}

describe("a customer's cancellation tells the organization only", () => {
  it("one organization notification, none for the customer who did it", () => {
    expect(draftsFor("order_cancelled_by_customer")).toEqual([{
      audience: "org",
      type: "order_cancelled_by_customer",
      title: "Order cancelled",
      body: "An order from Main Canteen was cancelled by the customer.",
    }]);
  });

  it("is addressed to every notifying role (no `roles` narrowing), so owners, managers and staff all get it", () => {
    expect(draftsFor("order_cancelled_by_customer")[0]).not.toHaveProperty("roles");
  });

  it("does not change with the refund flag: the organization is not told about money here", () => {
    expect(draftsFor("order_cancelled_by_customer", {...CONTEXT, refundInitiated: true}))
      .toEqual(draftsFor("order_cancelled_by_customer", {...CONTEXT, refundInitiated: false}));
  });
});

describe("an outlet's or the system's cancellation tells the customer only", () => {
  it("outlet, with no refund", () => {
    expect(draftsFor("order_cancelled_by_outlet")).toEqual([{
      audience: "customer",
      type: "order_cancelled_by_outlet",
      title: "Order cancelled",
      body: "Your order from Main Canteen was cancelled by the outlet.",
    }]);
  });

  it("outlet, with a refund started: the same copy plus one safe sentence", () => {
    expect(draftsFor("order_cancelled_by_outlet", {...CONTEXT, refundInitiated: true})[0].body)
      .toBe("Your order from Main Canteen was cancelled by the outlet. A refund has been initiated.");
  });

  it("system, with and without a refund", () => {
    expect(draftsFor("order_cancelled_by_system")).toEqual([{
      audience: "customer",
      type: "order_cancelled_by_system",
      title: "Order cancelled",
      body: "Your order from Main Canteen was cancelled.",
    }]);
    expect(draftsFor("order_cancelled_by_system", {...CONTEXT, refundInitiated: true})[0].body)
      .toBe("Your order from Main Canteen was cancelled. A refund has been initiated.");
  });

  it("degrades to complete sentences when the outlet is unknown", () => {
    expect(draftsFor("order_cancelled_by_outlet", {})[0].body).toBe("Your order was cancelled by the outlet.");
    expect(draftsFor("order_cancelled_by_customer", {})[0].body).toBe("An order was cancelled by the customer.");
  });

  it.each(["order_cancelled_by_outlet", "order_cancelled_by_system"] as const)("%s has no organization notification", (type) => {
    expect(orgDraftsAny(type)).toEqual([]);
  });
});

function orgDraftsAny(type: AnyNotificationEventType) {
  return draftsFor(type).filter((draft) => draft.audience === "org");
}

describe("refund events", () => {
  it("refund_requested produces NO visible notification for anyone", () => {
    expect(draftsFor("refund_requested")).toEqual([]);
    expect(draftsFor("refund_requested", {...CONTEXT, refundInitiated: true})).toEqual([]);
  });

  it("refund_completed: the customer only, with safe timing language and no promise of a date", () => {
    expect(draftsFor("refund_completed")).toEqual([{
      audience: "customer",
      type: "refund_completed",
      title: "Refund processed",
      body: "Your refund has been processed. It may take a few business days to appear in your account.",
    }]);
    expect(orgDraftsAny("refund_completed")).toEqual([]);
  });

  it("refund_failed: the customer, and the organization's owners and managers — not staff", () => {
    expect(draftsFor("refund_failed")).toEqual([
      {
        audience: "customer",
        type: "refund_failed",
        title: "Refund issue",
        body: "We couldn't complete your refund automatically. We're looking into it. Please contact support with your order ID.",
      },
      {
        audience: "org",
        type: "refund_failed",
        title: "Refund failed",
        body: "A refund failed and needs attention.",
        roles: ["owner", "manager"],
      },
    ]);
    for (const role of draftsFor("refund_failed")[1].roles ?? []) {
      expect(NOTIFICATION_ORG_ROLES).toContain(role);
    }
    expect(draftsFor("refund_failed")[1].roles).not.toContain("staff");
  });
});

describe("the whole policy table", () => {
  it("has a rule (possibly empty) for every event type, in every family", () => {
    for (const type of ALL_EVENT_TYPES) {
      expect(Array.isArray(draftsFor(type))).toBe(true);
    }
  });

  it("only ever produces known notification types", () => {
    for (const type of ALL_EVENT_TYPES) {
      for (const draft of draftsFor(type, {...CONTEXT, refundInitiated: true})) {
        expect(NOTIFICATION_TYPES).toContain(draft.type);
      }
    }
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
  });

  it("the existing order events produce exactly what they always did, with or without the new context", () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(draftsFor(type, {...CONTEXT, refundInitiated: true})).toEqual(draftsFor(type));
      for (const draft of draftsFor(type)) {
        expect(draft).not.toHaveProperty("roles");
      }
    }
  });

  it("no copy carries a provider ID, an amount, an internal ID, an email or an error", () => {
    for (const type of [...CANCELLATION_NOTIFICATION_EVENT_TYPES, ...REFUND_NOTIFICATION_EVENT_TYPES]) {
      for (const draft of draftsFor(type, {...CONTEXT, refundInitiated: true})) {
        const text = `${draft.title} ${draft.body}`;
        expect(text).not.toMatch(/@|\d|rfnd|pay_|razorpay|webhook|₹|\bINR\b|\bU-|error|exception/i);
      }
    }
  });
});

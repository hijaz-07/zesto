// @vitest-environment node
import {describe, expect, it} from "vitest";
import {NOTIFICATION_EVENT_TYPES, type NotificationEventType} from "./notificationEvents";
import {
  CUSTOMER_NOTIFICATION_TYPES,
  NOTIFICATION_ORG_ROLES,
  NOTIFICATION_TYPES,
  notificationsForEvent,
} from "./notificationPolicy";

const CONTEXT = {outletName: "Main Canteen"};

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

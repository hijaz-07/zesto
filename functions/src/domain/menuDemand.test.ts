import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {aggregateMenuDemand, countsAsDemand} from "./menuDemand";
import type {MenuItemResponse} from "./menuItems";
import type {Order, OrderStatus} from "./orders";

const NOW = Timestamp.fromDate(new Date("2026-10-10T08:00:00Z"));

function item(id: string, name: string, enabled = true): MenuItemResponse {
  return {
    id, menuId: "menu-1", name, priceInPaise: 2000, enabled, displayOrder: 0,
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", createdBy: "U-owner",
  };
}

function order(
  id: string,
  status: OrderStatus,
  paymentStatus: "pending" | "paid",
  lines: Array<[string, string, number]>,
): Order {
  const items = lines.map(([itemId, name, quantity]) => ({
    itemId, name, priceInPaise: 2000, quantity, lineTotalInPaise: 2000 * quantity,
  }));
  const total = items.reduce((sum, line) => sum + line.lineTotalInPaise, 0);
  return {
    id, userId: "U-customer", organizationId: "org-1", outletId: "outlet-1", menuId: "menu-1",
    status, paymentStatus, currency: "INR", subtotalInPaise: total, totalInPaise: total, items,
    createdAt: NOW, updatedAt: NOW,
  };
}

describe("countsAsDemand", () => {
  it.each<[OrderStatus, "pending" | "paid", boolean]>([
    ["confirmed", "paid", true],
    ["preparing", "paid", true],
    ["ready", "paid", true],
    ["picked_up", "paid", true],
    ["completed", "paid", true],
    ["cancelled", "paid", false],
    ["pending_payment", "pending", false],
    ["cancelled", "pending", false],
  ])("%s / %s -> %s", (status, paymentStatus, expected) => {
    expect(countsAsDemand(order("o", status, paymentStatus, [["a", "A", 1]]))).toBe(expected);
  });
});

describe("aggregateMenuDemand", () => {
  it("adds up paid, not-cancelled orders per item and ignores unpaid and cancelled ones", () => {
    const result = aggregateMenuDemand(
      [item("biriyani", "Chicken Biriyani"), item("meals", "Veg Meals")],
      [
        order("o1", "confirmed", "paid", [["biriyani", "Chicken Biriyani", 3]]),
        order("o2", "ready", "paid", [["biriyani", "Chicken Biriyani", 2], ["meals", "Veg Meals", 1]]),
        order("o3", "completed", "paid", [["biriyani", "Chicken Biriyani", 10]]),
        order("o4", "pending_payment", "pending", [["meals", "Veg Meals", 50]]),
        order("o5", "cancelled", "paid", [["meals", "Veg Meals", 40]]),
      ],
    );
    expect(result).toEqual({
      paidOrders: 3,
      totalPortions: 16,
      items: [
        {itemId: "biriyani", name: "Chicken Biriyani", portions: 15},
        {itemId: "meals", name: "Veg Meals", portions: 1},
      ],
    });
  });

  it("lists every enabled item, with 0 when nobody ordered it, in menu order", () => {
    const result = aggregateMenuDemand([item("b", "B"), item("a", "A")], []);
    expect(result).toEqual({
      paidOrders: 0, totalPortions: 0,
      items: [{itemId: "b", name: "B", portions: 0}, {itemId: "a", name: "A", portions: 0}],
    });
  });

  it("hides a disabled item without demand but keeps one that already has demand", () => {
    const result = aggregateMenuDemand(
      [item("off-empty", "Off, nobody", false), item("off-ordered", "Off, ordered", false)],
      [order("o1", "confirmed", "paid", [["off-ordered", "Off, ordered", 2]])],
    );
    expect(result.items).toEqual([{itemId: "off-ordered", name: "Off, ordered", portions: 2}]);
  });

  it("keeps demand for a deleted item under its name at order time, after the current items", () => {
    const result = aggregateMenuDemand(
      [item("kept", "Kept")],
      [order("o1", "preparing", "paid", [["gone", "Old Name", 4], ["kept", "Kept", 1]])],
    );
    expect(result.items).toEqual([
      {itemId: "kept", name: "Kept", portions: 1},
      {itemId: "gone", name: "Old Name", portions: 4},
    ]);
  });

  it("uses the current item name, not the order snapshot, for an item still on the menu", () => {
    const result = aggregateMenuDemand(
      [item("x", "New Name")],
      [order("o1", "confirmed", "paid", [["x", "Old Name", 1]])],
    );
    expect(result.items).toEqual([{itemId: "x", name: "New Name", portions: 1}]);
  });
});

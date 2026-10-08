// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it} from "vitest";
import type {Menu} from "./menus";
import {encodeOrderHistoryCursor} from "./orderHistory";
import {
  ORGANIZATION_ORDER_MAX_ITEM_LINES,
  listOrganizationOrders,
  listOrganizationOrdersQuerySchema,
  toOrganizationOrderSummary,
} from "./organizationOrders";
import type {Order, OrderItemSnapshot} from "./orders";
import type {Outlet} from "./outlets";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";

/**
 * A Firestore stand-in that throws on any property access, proving a call was
 * rejected before it ever read or queried anything.
 */
function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

function line(index: number, quantity = 1): OrderItemSnapshot {
  return {
    itemId: `item-${index}`,
    name: `Dish ${index}`,
    priceInPaise: 1000 * index,
    quantity,
    lineTotalInPaise: 1000 * index * quantity,
  };
}

function validOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    userId: "U-customer",
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuId: "menu-1",
    status: "confirmed",
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: 30000,
    totalInPaise: 30000,
    items: [line(1, 2), line(2, 1)],
    createdAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-27T04:05:00Z")),
    ...overrides,
  };
}

const outlet = {id: OUTLET_ID, organizationId: ORG_ID, name: "Main Canteen"} as Outlet;
const menu = {
  id: "menu-1", organizationId: ORG_ID, outletId: OUTLET_ID, title: "Tuesday Menu", menuDate: "2026-09-29",
} as Menu;

describe("listOrganizationOrdersQuerySchema", () => {
  it("accepts an empty query, with no outlet filter", () => {
    expect(listOrganizationOrdersQuerySchema.parse({})).toEqual({});
  });

  it("accepts an outletId alongside limit and cursor", () => {
    expect(listOrganizationOrdersQuerySchema.parse({outletId: "outlet-1", limit: "5", cursor: "abc"}))
      .toEqual({outletId: "outlet-1", limit: 5, cursor: "abc"});
  });

  it("shares the customer history's limit bounds: positive integers only", () => {
    expect(listOrganizationOrdersQuerySchema.safeParse({limit: "0"}).success).toBe(false);
    expect(listOrganizationOrdersQuerySchema.safeParse({limit: "abc"}).success).toBe(false);
    expect(listOrganizationOrdersQuerySchema.parse({limit: "100000"})).toEqual({limit: 100000});
  });

  it.each(["", "a/b", ".", "..", "__id__", "a".repeat(1501)])(
    "rejects outletId %j rather than treating it as no filter",
    (outletId) => {
      expect(listOrganizationOrdersQuerySchema.safeParse({outletId}).success).toBe(false);
    },
  );

  it("rejects a repeated (array) outletId", () => {
    expect(listOrganizationOrdersQuerySchema.safeParse({outletId: ["a", "b"]}).success).toBe(false);
  });

  it("strips an organizationId or userId in the query string so it is never read", () => {
    const parsed = listOrganizationOrdersQuerySchema.parse({
      organizationId: "org-attacker",
      userId: "U-attacker",
      status: "confirmed",
      limit: "3",
    });

    expect(parsed).toEqual({limit: 3});
    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed).not.toHaveProperty("userId");
  });
});

describe("toOrganizationOrderSummary", () => {
  it("maps an order to the organization list shape, using the order's own snapshots", () => {
    const summary = toOrganizationOrderSummary(validOrder(), outlet, menu);

    expect(summary).toEqual({
      id: "order-1",
      outletId: OUTLET_ID,
      menuId: "menu-1",
      outlet: {name: "Main Canteen"},
      menu: {title: "Tuesday Menu", menuDate: "2026-09-29"},
      status: "confirmed",
      paymentStatus: "paid",
      currency: "INR",
      subtotalInPaise: 30000,
      totalInPaise: 30000,
      itemCount: 3,
      items: [{name: "Dish 1", quantity: 2}, {name: "Dish 2", quantity: 1}],
      moreItemLines: 0,
      createdAt: "2026-09-27T04:00:00.000Z",
      updatedAt: "2026-09-27T04:05:00.000Z",
    });
  });

  it("never carries customer identity, the organization id, per-line prices or item ids", () => {
    const summary = toOrganizationOrderSummary(validOrder(), outlet, menu);
    const serialized = JSON.stringify(summary);

    expect(summary).not.toHaveProperty("userId");
    expect(summary).not.toHaveProperty("organizationId");
    expect(serialized).not.toContain("U-customer");
    expect(serialized).not.toContain("priceInPaise");
    expect(serialized).not.toContain("lineTotalInPaise");
    expect(serialized).not.toContain("itemId");
    for (const item of summary.items) {
      expect(Object.keys(item).sort()).toEqual(["name", "quantity"]);
    }
  });

  it("lists up to 10 lines and counts the omitted ones in moreItemLines", () => {
    expect(ORGANIZATION_ORDER_MAX_ITEM_LINES).toBe(10);

    const exactlyTen = toOrganizationOrderSummary(
      validOrder({items: Array.from({length: 10}, (_unused, i) => line(i + 1))}), outlet, menu,
    );
    expect(exactlyTen.items).toHaveLength(10);
    expect(exactlyTen.moreItemLines).toBe(0);

    const fourteen = toOrganizationOrderSummary(
      validOrder({items: Array.from({length: 14}, (_unused, i) => line(i + 1))}), outlet, menu,
    );
    expect(fourteen.items.map((item) => item.name)).toEqual(
      Array.from({length: 10}, (_unused, i) => `Dish ${i + 1}`),
    );
    expect(fourteen.moreItemLines).toBe(4);
  });

  it("counts portions across every line, including the omitted ones", () => {
    const summary = toOrganizationOrderSummary(
      validOrder({items: Array.from({length: 12}, (_unused, i) => line(i + 1, 2))}), outlet, menu,
    );

    expect(summary.itemCount).toBe(24);
    expect(summary.items).toHaveLength(10);
  });

  it("omits the outlet/menu names, rather than failing, when those documents no longer exist", () => {
    const summary = toOrganizationOrderSummary(validOrder(), undefined, undefined);

    expect(summary).not.toHaveProperty("outlet");
    expect(summary).not.toHaveProperty("menu");
    expect(summary.id).toBe("order-1");
  });

  describe("cancellation and refund blocks", () => {
    const cancelledAt = Timestamp.fromDate(new Date("2026-09-27T05:00:00Z"));

    it("carries neither block on an order that was never cancelled or refunded", () => {
      const summary = toOrganizationOrderSummary(validOrder(), outlet, menu);

      expect(summary).not.toHaveProperty("cancellation");
      expect(summary).not.toHaveProperty("refund");
    });

    it("shows who cancelled (a role) and when, and nothing else of the audit", () => {
      const summary = toOrganizationOrderSummary(validOrder({
        status: "cancelled",
        cancelledAt,
        cancelledBy: "U-manager-secret",
        cancelledByRole: "organization",
        cancellationReason: "item_unavailable",
        cancelledFromStatus: "confirmed",
      }), outlet, menu);

      expect(summary.cancellation).toEqual({cancelledBy: "organization", cancelledAt: "2026-09-27T05:00:00.000Z"});
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("U-manager-secret");
      expect(serialized).not.toContain("item_unavailable");
      expect(serialized).not.toContain("cancelledFromStatus");
    });

    it("omits the cancellation block for a cancelled order with no recorded audit, and for a non-cancelled order that has one", () => {
      expect(toOrganizationOrderSummary(validOrder({status: "cancelled"}), outlet, menu)).not.toHaveProperty("cancellation");
      expect(
        toOrganizationOrderSummary(validOrder({cancelledAt, cancelledByRole: "customer"}), outlet, menu),
      ).not.toHaveProperty("cancellation");
    });

    it("maps the order's refund mirror to the refund block, with only the state and the amount refunded", () => {
      const summary = toOrganizationOrderSummary(
        validOrder({refundStatus: "attention_required", refundedInPaise: 0}), outlet, menu,
      );

      expect(summary.refund).toEqual({state: "attention_required", refundedInPaise: 0});
    });

    it("leaves the refund block out for state none, or a half-written mirror", () => {
      expect(toOrganizationOrderSummary(validOrder({refundStatus: "none", refundedInPaise: 0}), outlet, menu))
        .not.toHaveProperty("refund");
      expect(toOrganizationOrderSummary(validOrder({refundStatus: "refunded"}), outlet, menu))
        .not.toHaveProperty("refund");
    });
  });
});

describe("listOrganizationOrders — cursor scope (no Firestore access)", () => {
  const at = Timestamp.fromMillis(Date.UTC(2026, 8, 1, 6, 0, 0));
  const otherOrg = "organizations/org-2/outlets/outlet-9/menus/menu-9/orders/order-9";
  const otherOutletSameOrg = `organizations/${ORG_ID}/outlets/outlet-2/menus/menu-2/orders/order-2`;

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error("expected a rejection");
      },
      (error: unknown) => error,
    );
  }

  it("rejects a cursor that points into another organization with a 400, before any read", async () => {
    const cursor = encodeOrderHistoryCursor(at, otherOrg);

    const error = await rejection(listOrganizationOrders(untouchedDb(), ORG_ID, {cursor}));

    expect(error).toBeInstanceOf(HttpsError);
    expect(error).toMatchObject({code: "invalid-argument", message: "Invalid cursor."});
  });

  it("rejects a cursor from a different outlet when an outlet filter is active, before any read", async () => {
    const cursor = encodeOrderHistoryCursor(at, otherOutletSameOrg);

    const error = await rejection(
      listOrganizationOrders(untouchedDb(), ORG_ID, {outletId: OUTLET_ID, cursor}),
    );

    expect(error).toMatchObject({code: "invalid-argument", message: "Invalid cursor."});
  });

  it("rejects an organization prefix that merely starts the same (org-1 vs org-10)", async () => {
    const cursor = encodeOrderHistoryCursor(at, "organizations/org-10/outlets/o/menus/m/orders/x");

    const error = await rejection(listOrganizationOrders(untouchedDb(), ORG_ID, {cursor}));

    expect(error).toMatchObject({code: "invalid-argument"});
  });

  it("rejects an outlet prefix that merely starts the same (outlet-1 vs outlet-10)", async () => {
    const cursor = encodeOrderHistoryCursor(at, `organizations/${ORG_ID}/outlets/outlet-10/menus/m/orders/x`);

    const error = await rejection(
      listOrganizationOrders(untouchedDb(), ORG_ID, {outletId: OUTLET_ID, cursor}),
    );

    expect(error).toMatchObject({code: "invalid-argument"});
  });

  it("rejects a cursor that is not one the endpoint could have issued", async () => {
    for (const cursor of ["not a cursor!", "e30", Buffer.from("{\"s\":1}").toString("base64url")]) {
      const error = await rejection(listOrganizationOrders(untouchedDb(), ORG_ID, {cursor}));
      expect(error).toMatchObject({code: "invalid-argument", message: "Invalid cursor."});
    }
  });
});

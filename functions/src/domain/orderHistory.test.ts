// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it} from "vitest";
import type {Menu} from "./menus";
import {
  ORDER_HISTORY_DEFAULT_PAGE_SIZE,
  ORDER_HISTORY_MAX_PAGE_SIZE,
  decodeOrderHistoryCursor,
  encodeOrderHistoryCursor,
  listOrdersQuerySchema,
  toOrderSummaryResponse,
} from "./orderHistory";
import type {Order} from "./orders";
import type {Outlet} from "./outlets";

const ORDER_PATH = "organizations/org-1/outlets/outlet-1/menus/menu-1/orders/order-1";

function validOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    userId: "U-customer",
    organizationId: "org-1",
    outletId: "outlet-1",
    menuId: "menu-1",
    status: "confirmed",
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: 30000,
    totalInPaise: 30000,
    items: [
      {itemId: "item-1", name: "Chicken Biriyani", priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000},
      {itemId: "item-2", name: "Veg Meals", priceInPaise: 6000, quantity: 1, lineTotalInPaise: 6000},
    ],
    createdAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-27T04:05:00Z")),
    ...overrides,
  };
}

const outlet = {id: "outlet-1", organizationId: "org-1", name: "Main Canteen"} as Outlet;
const menu = {
  id: "menu-1", organizationId: "org-1", outletId: "outlet-1", title: "Tuesday Menu", menuDate: "2026-09-29",
} as Menu;

describe("listOrdersQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(listOrdersQuerySchema.parse({})).toEqual({});
  });

  it("parses limit as a number", () => {
    expect(listOrdersQuerySchema.parse({limit: "7"})).toEqual({limit: 7});
  });

  it("does not itself cap limit: the page-size ceiling is enforced by listOwnedOrders", () => {
    expect(listOrdersQuerySchema.parse({limit: "100000"})).toEqual({limit: 100000});
  });

  it.each(["0", "-1", "1.5", "abc", "", " 5", "05", "1e3", "9999999999"])(
    "rejects limit %j",
    (limit) => {
      expect(listOrdersQuerySchema.safeParse({limit}).success).toBe(false);
    },
  );

  it("rejects a repeated (array) limit or cursor", () => {
    expect(listOrdersQuerySchema.safeParse({limit: ["1", "2"]}).success).toBe(false);
    expect(listOrdersQuerySchema.safeParse({cursor: ["a", "b"]}).success).toBe(false);
  });

  it("rejects an empty or oversized cursor", () => {
    expect(listOrdersQuerySchema.safeParse({cursor: ""}).success).toBe(false);
    expect(listOrdersQuerySchema.safeParse({cursor: "a".repeat(1025)}).success).toBe(false);
  });

  it("strips any other query parameter — in particular a userId — so it is never read", () => {
    const parsed = listOrdersQuerySchema.parse({userId: "U-attacker", status: "confirmed", limit: "3"});

    expect(parsed).toEqual({limit: 3});
    expect(parsed).not.toHaveProperty("userId");
  });

  it("has a default page size within the maximum", () => {
    expect(ORDER_HISTORY_DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(ORDER_HISTORY_MAX_PAGE_SIZE);
    expect(ORDER_HISTORY_MAX_PAGE_SIZE).toBe(50);
  });
});

describe("order history cursor", () => {
  it("round-trips createdAt (to the nanosecond) and the order's document path", () => {
    const createdAt = new Timestamp(1_790_000_000, 123_456_000);

    const decoded = decodeOrderHistoryCursor(encodeOrderHistoryCursor(createdAt, ORDER_PATH));

    expect(decoded.createdAt.seconds).toBe(1_790_000_000);
    expect(decoded.createdAt.nanoseconds).toBe(123_456_000);
    expect(decoded.path).toBe(ORDER_PATH);
  });

  it("is URL-safe", () => {
    expect(encodeOrderHistoryCursor(Timestamp.now(), ORDER_PATH)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  function encodeRaw(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  it.each([
    ["not base64url", "not a cursor!"],
    ["base64url of non-JSON", Buffer.from("hello", "utf8").toString("base64url")],
    ["a JSON string, not an object", encodeRaw("hello")],
    ["missing fields", encodeRaw({s: 1})],
    ["a non-integer seconds value", encodeRaw({s: 1.5, n: 0, p: ORDER_PATH})],
    ["negative seconds", encodeRaw({s: -1, n: 0, p: ORDER_PATH})],
    ["out-of-range seconds", encodeRaw({s: 253_402_300_800, n: 0, p: ORDER_PATH})],
    ["out-of-range nanoseconds", encodeRaw({s: 1, n: 1_000_000_000, p: ORDER_PATH})],
    ["a path that is not an order document", encodeRaw({s: 1, n: 0, p: "organizations/org-1"})],
    ["a path to a different collection", encodeRaw({
      s: 1, n: 0, p: "organizations/org-1/outlets/outlet-1/menus/menu-1/items/item-1",
    })],
    ["a path with an empty segment", encodeRaw({
      s: 1, n: 0, p: "organizations//outlets/outlet-1/menus/menu-1/orders/order-1",
    })],
    ["a path with a reserved segment", encodeRaw({
      s: 1, n: 0, p: "organizations/__x__/outlets/outlet-1/menus/menu-1/orders/order-1",
    })],
    ["a path with a trailing segment", encodeRaw({s: 1, n: 0, p: `${ORDER_PATH}/payments/order-1`})],
  ])("rejects a cursor that is %s as invalid-argument", (_label, raw) => {
    expect(() => decodeOrderHistoryCursor(raw)).toThrow(HttpsError);
    expect(() => decodeOrderHistoryCursor(raw)).toThrow(expect.objectContaining({code: "invalid-argument"}));
  });
});

describe("toOrderSummaryResponse", () => {
  it("maps an order to the customer-safe list shape", () => {
    expect(toOrderSummaryResponse(validOrder(), outlet, menu)).toEqual({
      id: "order-1",
      outletId: "outlet-1",
      menuId: "menu-1",
      outlet: {name: "Main Canteen"},
      menu: {title: "Tuesday Menu", menuDate: "2026-09-29"},
      status: "confirmed",
      paymentStatus: "paid",
      currency: "INR",
      subtotalInPaise: 30000,
      totalInPaise: 30000,
      itemCount: 3,
      items: [
        {name: "Chicken Biriyani", quantity: 2},
        {name: "Veg Meals", quantity: 1},
      ],
      moreItemLines: 0,
      createdAt: "2026-09-27T04:00:00.000Z",
      updatedAt: "2026-09-27T04:05:00.000Z",
    });
  });

  it("never includes userId, organizationId, or per-line prices/ids", () => {
    const summary = toOrderSummaryResponse(validOrder(), outlet, menu);
    const serialized = JSON.stringify(summary);

    expect(summary).not.toHaveProperty("userId");
    expect(summary).not.toHaveProperty("organizationId");
    expect(serialized).not.toContain("U-customer");
    expect(serialized).not.toContain("org-1");
    expect(serialized).not.toContain("item-1");
    expect(summary.items[0]).toEqual({name: "Chicken Biriyani", quantity: 2});
  });

  it("omits the outlet and menu context, rather than inventing it, when those documents are gone", () => {
    const summary = toOrderSummaryResponse(validOrder(), undefined, undefined);

    expect(summary).not.toHaveProperty("outlet");
    expect(summary).not.toHaveProperty("menu");
    expect(summary.outletId).toBe("outlet-1");
    expect(summary.menuId).toBe("menu-1");
  });

  it("summarizes only the first 3 lines and counts the rest, while itemCount covers every line", () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({
      itemId: `item-${n}`, name: `Dish ${n}`, priceInPaise: 1000, quantity: n, lineTotalInPaise: 1000 * n,
    }));

    const summary = toOrderSummaryResponse(validOrder({items}), outlet, menu);

    expect(summary.items.map((i) => i.name)).toEqual(["Dish 1", "Dish 2", "Dish 3"]);
    expect(summary.moreItemLines).toBe(2);
    expect(summary.itemCount).toBe(15);
  });

  it("carries the order's own snapshot names and quantities, whatever the live menu now says", () => {
    const renamed = {...menu, title: "Renamed Menu"} as Menu;

    const summary = toOrderSummaryResponse(validOrder(), outlet, renamed);

    expect(summary.items[0].name).toBe("Chicken Biriyani");
    expect(summary.totalInPaise).toBe(30000);
  });

  it("reports each status exactly as stored", () => {
    expect(toOrderSummaryResponse(
      validOrder({status: "pending_payment", paymentStatus: "pending"}), outlet, menu,
    )).toMatchObject({status: "pending_payment", paymentStatus: "pending"});
    expect(toOrderSummaryResponse(
      validOrder({status: "cancelled", paymentStatus: "pending"}), outlet, menu,
    )).toMatchObject({status: "cancelled", paymentStatus: "pending"});
  });
});

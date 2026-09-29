// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {
  computeOrderRequestFingerprint,
  createOrderBodySchema,
  parseOrder,
  toOrderResponse,
  type Order,
} from "./orders";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
const MENU_ID = "menu-1";
const ORDER_ID = "order-1";
const USER_ID = "U-customer";

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: OUTLET_ID,
    menuId: MENU_ID,
    items: [{itemId: "item-1", quantity: 2}],
    idempotencyKey: "idem-key-1",
    ...overrides,
  };
}

function validOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    userId: USER_ID,
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuId: MENU_ID,
    status: "pending_payment",
    paymentStatus: "pending",
    currency: "INR",
    subtotalInPaise: 24000,
    totalInPaise: 24000,
    items: [
      {itemId: "item-1", name: "Chicken Biriyani", priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000},
    ],
    createdAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    ...overrides,
  };
}

describe("createOrderBodySchema", () => {
  it("accepts a valid, minimal body", () => {
    expect(createOrderBodySchema.safeParse(validCreateBody()).success).toBe(true);
  });

  it("strips unknown/client-supplied authoritative fields rather than rejecting them", () => {
    const result = createOrderBodySchema.safeParse(validCreateBody({
      organizationId: "org-attacker",
      userId: "U-attacker",
      currency: "USD",
      subtotalInPaise: 1,
      totalInPaise: 1,
      status: "confirmed",
      paymentStatus: "paid",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("organizationId");
      expect(result.data).not.toHaveProperty("userId");
      expect(result.data).not.toHaveProperty("currency");
      expect(result.data).not.toHaveProperty("subtotalInPaise");
      expect(result.data).not.toHaveProperty("totalInPaise");
      expect(result.data).not.toHaveProperty("status");
      expect(result.data).not.toHaveProperty("paymentStatus");
    }
  });

  it("rejects a missing outletId/menuId/idempotencyKey", () => {
    expect(createOrderBodySchema.safeParse(validCreateBody({outletId: undefined})).success).toBe(false);
    expect(createOrderBodySchema.safeParse(validCreateBody({menuId: undefined})).success).toBe(false);
    expect(createOrderBodySchema.safeParse(validCreateBody({idempotencyKey: undefined})).success).toBe(false);
  });

  it("rejects an empty idempotencyKey and one over the length bound", () => {
    expect(createOrderBodySchema.safeParse(validCreateBody({idempotencyKey: ""})).success).toBe(false);
    expect(createOrderBodySchema.safeParse(validCreateBody({idempotencyKey: "x".repeat(201)})).success).toBe(false);
    expect(createOrderBodySchema.safeParse(validCreateBody({idempotencyKey: "x".repeat(200)})).success).toBe(true);
  });

  it("rejects empty items", () => {
    expect(createOrderBodySchema.safeParse(validCreateBody({items: []})).success).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive-integer quantity: %s",
    (quantity) => {
      const result = createOrderBodySchema.safeParse(
        validCreateBody({items: [{itemId: "item-1", quantity}]}),
      );
      expect(result.success).toBe(false);
    },
  );

  it("accepts a positive integer quantity", () => {
    const result = createOrderBodySchema.safeParse(
      validCreateBody({items: [{itemId: "item-1", quantity: 3}]}),
    );
    expect(result.success).toBe(true);
  });

  it("rejects duplicate itemId entries rather than silently combining them", () => {
    const result = createOrderBodySchema.safeParse(validCreateBody({
      items: [{itemId: "item-1", quantity: 1}, {itemId: "item-1", quantity: 2}],
    }));
    expect(result.success).toBe(false);
  });

  it("accepts multiple distinct items", () => {
    const result = createOrderBodySchema.safeParse(validCreateBody({
      items: [{itemId: "item-1", quantity: 1}, {itemId: "item-2", quantity: 2}],
    }));
    expect(result.success).toBe(true);
  });
});

describe("computeOrderRequestFingerprint", () => {
  it("is stable for the same logical request", () => {
    const a = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [{itemId: "item-1", quantity: 2}]);
    const b = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [{itemId: "item-1", quantity: 2}]);
    expect(a).toBe(b);
  });

  it("is independent of item order in the request", () => {
    const a = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [
      {itemId: "item-1", quantity: 1}, {itemId: "item-2", quantity: 2},
    ]);
    const b = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [
      {itemId: "item-2", quantity: 2}, {itemId: "item-1", quantity: 1},
    ]);
    expect(a).toBe(b);
  });

  it("differs when the quantity differs", () => {
    const a = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [{itemId: "item-1", quantity: 1}]);
    const b = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [{itemId: "item-1", quantity: 2}]);
    expect(a).not.toBe(b);
  });

  it("differs when the item set differs", () => {
    const a = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [{itemId: "item-1", quantity: 1}]);
    const b = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [{itemId: "item-2", quantity: 1}]);
    expect(a).not.toBe(b);
  });

  it("differs when the outlet or menu differs", () => {
    const base = computeOrderRequestFingerprint(OUTLET_ID, MENU_ID, [{itemId: "item-1", quantity: 1}]);
    expect(computeOrderRequestFingerprint("outlet-2", MENU_ID, [{itemId: "item-1", quantity: 1}]))
      .not.toBe(base);
    expect(computeOrderRequestFingerprint(OUTLET_ID, "menu-2", [{itemId: "item-1", quantity: 1}]))
      .not.toBe(base);
  });
});

describe("parseOrder", () => {
  it("parses a well-formed stored order matching its path", () => {
    const order = validOrder();
    const parsed = parseOrder(order, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);
    expect(parsed).toEqual(order);
  });

  it.each([
    ["id", "order-attacker"],
    ["organizationId", "org-attacker"],
    ["outletId", "outlet-attacker"],
    ["menuId", "menu-attacker"],
  ])("throws when the stored %s doesn't match the path it was read from", (field) => {
    const order = validOrder({[field]: "mismatched"} as Partial<Order>);
    expect(() => parseOrder(order, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });

  it("throws for a malformed document", () => {
    expect(() => parseOrder({not: "an order"}, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });

  it("throws when items is empty", () => {
    const order = validOrder({items: []});
    expect(() => parseOrder(order, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });
});

describe("toOrderResponse", () => {
  it("maps fields to their response shape, excluding userId, with ISO timestamps", () => {
    const order = validOrder();
    const response = toOrderResponse(order);

    expect(response).not.toHaveProperty("userId");
    expect(response).toEqual({
      id: order.id,
      organizationId: order.organizationId,
      outletId: order.outletId,
      menuId: order.menuId,
      status: order.status,
      paymentStatus: order.paymentStatus,
      currency: order.currency,
      subtotalInPaise: order.subtotalInPaise,
      totalInPaise: order.totalInPaise,
      items: order.items,
      createdAt: order.createdAt.toDate().toISOString(),
      updatedAt: order.updatedAt.toDate().toISOString(),
    });
  });
});

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

describe("parseOrder: cancellation fields (legacy compatible)", () => {
  const CANCELLED_AT = Timestamp.fromDate(new Date("2026-09-27T09:00:00Z"));

  function cancelledOrder(overrides: Partial<Order> = {}): Order {
    return validOrder({
      status: "cancelled",
      paymentStatus: "paid",
      cancelledAt: CANCELLED_AT,
      cancelledBy: USER_ID,
      cancelledByRole: "customer",
      cancelledFromStatus: "confirmed",
      cancellationReason: "changed_my_mind",
      ...overrides,
    });
  }

  function parse(order: unknown): Order {
    return parseOrder(order, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);
  }

  it("still parses every status of an order that has no cancellation fields at all", () => {
    for (const status of ["pending_payment", "confirmed", "preparing", "ready", "picked_up", "completed", "cancelled"] as const) {
      const order = validOrder({status, paymentStatus: status === "pending_payment" ? "pending" : "paid"});
      expect(parse(order)).toEqual(order);
    }
  });

  it("parses an old `cancelled` order that predates the audit fields", () => {
    expect(parse(validOrder({status: "cancelled"})).cancelledAt).toBeUndefined();
  });

  it("does not add cancellation keys to an order that has none", () => {
    const parsed = parse(validOrder({status: "confirmed", paymentStatus: "paid"}));
    for (const key of ["cancelledAt", "cancelledBy", "cancelledByRole", "cancellationReason", "cancelledFromStatus"]) {
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it("parses a customer cancellation with a reason", () => {
    const parsed = parse(cancelledOrder());
    expect(parsed).toMatchObject({
      cancelledBy: USER_ID, cancelledByRole: "customer", cancelledFromStatus: "confirmed", cancellationReason: "changed_my_mind",
    });
    expect(parsed.cancelledAt).toEqual(CANCELLED_AT);
  });

  it("parses a customer cancellation with no reason", () => {
    const withoutReason: Record<string, unknown> = {...cancelledOrder()};
    delete withoutReason.cancellationReason;
    expect(parse(withoutReason).cancellationReason).toBeUndefined();
  });

  it("parses an organization cancellation from any cancellable status", () => {
    for (const cancelledFromStatus of ["pending_payment", "confirmed", "preparing", "ready"] as const) {
      const order = cancelledOrder({
        cancelledBy: "U-owner", cancelledByRole: "organization", cancellationReason: "item_unavailable", cancelledFromStatus,
      });
      expect(parse(order).cancelledFromStatus).toBe(cancelledFromStatus);
    }
  });

  it("accepts 'other' for either audience", () => {
    expect(parse(cancelledOrder({cancellationReason: "other"})).cancellationReason).toBe("other");
    expect(parse(cancelledOrder({cancelledByRole: "organization", cancellationReason: "other"})).cancellationReason).toBe("other");
  });

  it("rejects an organization cancellation with no reason", () => {
    const withoutReason: Record<string, unknown> = {...cancelledOrder({cancelledByRole: "organization"})};
    delete withoutReason.cancellationReason;
    expect(() => parse(withoutReason)).toThrow();
  });

  it("rejects a reason that does not belong to whoever cancelled", () => {
    expect(() => parse(cancelledOrder({cancelledByRole: "customer", cancellationReason: "item_unavailable"}))).toThrow();
    expect(() => parse(cancelledOrder({cancelledByRole: "organization", cancellationReason: "changed_my_mind"}))).toThrow();
  });

  it("rejects cancellation fields on an order that is not cancelled", () => {
    expect(() => parse(cancelledOrder({status: "confirmed"}))).toThrow();
    expect(() => parse(validOrder({status: "confirmed", paymentStatus: "paid", cancelledAt: CANCELLED_AT}))).toThrow();
  });

  it("rejects a partly written audit group", () => {
    for (const missing of ["cancelledAt", "cancelledBy", "cancelledByRole", "cancelledFromStatus"] as const) {
      const partial: Record<string, unknown> = {...cancelledOrder()};
      delete partial[missing];
      expect(() => parse(partial), `without ${missing}`).toThrow();
    }
  });

  it("rejects a reason with no cancellation behind it", () => {
    expect(() => parse(validOrder({status: "cancelled", cancellationReason: "other"}))).toThrow();
  });

  it("rejects unknown values and the statuses an order can never be cancelled from", () => {
    expect(() => parse({...cancelledOrder(), cancelledByRole: "system"})).toThrow();
    expect(() => parse({...cancelledOrder(), cancelledByRole: "staff"})).toThrow();
    expect(() => parse({...cancelledOrder(), cancellationReason: "free text"})).toThrow();
    for (const status of ["picked_up", "completed", "cancelled", "bogus"]) {
      expect(() => parse({...cancelledOrder(), cancelledFromStatus: status}), status).toThrow();
    }
    expect(() => parse({...cancelledOrder(), cancelledAt: "2026-09-27"})).toThrow();
    expect(() => parse({...cancelledOrder(), cancelledBy: ""})).toThrow();
  });

  it("still validates the path coordinates of a cancelled order", () => {
    expect(() => parseOrder(cancelledOrder(), ORDER_ID, "org-other", OUTLET_ID, MENU_ID)).toThrow();
  });

  it("never leaks cancellation audit fields into the customer response", () => {
    const response = toOrderResponse(cancelledOrder());
    for (const key of ["cancelledAt", "cancelledBy", "cancelledByRole", "cancellationReason", "cancelledFromStatus", "userId"]) {
      expect(response).not.toHaveProperty(key);
    }
    expect(response.status).toBe("cancelled");
    expect(JSON.stringify(response)).not.toContain(USER_ID);
  });
});

describe("parseOrder: refund mirror (legacy compatible)", () => {
  function parse(order: unknown): Order {
    return parseOrder(order, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);
  }

  it("parses an order with no mirror at all, and adds none", () => {
    const parsed = parse(validOrder({status: "cancelled", paymentStatus: "paid"}));

    expect(parsed).not.toHaveProperty("refundStatus");
    expect(parsed).not.toHaveProperty("refundedInPaise");
  });

  it.each(["none", "in_progress", "partially_refunded", "refunded", "attention_required"] as const)(
    "parses the mirror state %s with the processed total",
    (refundStatus) => {
      expect(parse(validOrder({refundStatus, refundedInPaise: 0}))).toMatchObject({refundStatus, refundedInPaise: 0});
    },
  );

  it("requires the two mirror fields together", () => {
    expect(() => parse(validOrder({refundStatus: "in_progress"}))).toThrow();
    expect(() => parse(validOrder({refundedInPaise: 0}))).toThrow();
  });

  it("rejects an unknown state and an amount that is not whole non-negative paise", () => {
    expect(() => parse({...validOrder(), refundStatus: "queued", refundedInPaise: 0})).toThrow();
    for (const refundedInPaise of [-1, 1.5, "0", Number.NaN]) {
      expect(() => parse({...validOrder(), refundStatus: "in_progress", refundedInPaise}), String(refundedInPaise)).toThrow();
    }
  });

  it("never leaks the mirror into the customer response", () => {
    const response = toOrderResponse(validOrder({refundStatus: "in_progress", refundedInPaise: 0}));

    expect(response).not.toHaveProperty("refundStatus");
    expect(response).not.toHaveProperty("refundedInPaise");
  });
});

// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it} from "vitest";
import type {OrganizationMembership} from "../auth/membership";
import {
  ORDER_FULFILLMENT_ROLES,
  decideFulfillmentTransition,
  isFulfillmentTarget,
  transitionOrderStatus,
  type FulfillmentTarget,
} from "./orderFulfillment";
import {parseOrder, toOrderResponse, type Order, type OrderStatus} from "./orders";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
const MENU_ID = "menu-1";
const ORDER_ID = "order-1";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    userId: "U-customer",
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuId: MENU_ID,
    status: "confirmed",
    paymentStatus: "paid",
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

function membership(overrides: Partial<OrganizationMembership> = {}): OrganizationMembership {
  return {userId: "U-staff", organizationId: ORG_ID, role: "staff", status: "active", ...overrides};
}

/** A Firestore stand-in that throws on any property access. */
function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

/** Runs `fn`, returning the `HttpsError` it threw (failing the test if it threw anything else or nothing). */
function httpsErrorOf(fn: () => unknown): HttpsError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an HttpsError, but nothing was thrown");
}

describe("isFulfillmentTarget", () => {
  it.each(["preparing", "ready"])("accepts %s", (value) => {
    expect(isFulfillmentTarget(value)).toBe(true);
  });

  it.each([
    "pending_payment", "confirmed", "cancelled", "picked_up", "completed", "bogus", "", "PREPARING",
    "__proto__", "constructor", "toString", "hasOwnProperty",
  ])("rejects the string %j", (value) => {
    expect(isFulfillmentTarget(value)).toBe(false);
  });

  it.each([undefined, null, 5, {}, ["ready"], true])("rejects the non-string %j", (value) => {
    expect(isFulfillmentTarget(value)).toBe(false);
  });
});

describe("ORDER_FULFILLMENT_ROLES", () => {
  it("is exactly owner, manager and staff", () => {
    expect([...ORDER_FULFILLMENT_ROLES].sort()).toEqual(["manager", "owner", "staff"]);
  });
});

describe("decideFulfillmentTransition", () => {
  it("applies confirmed -> preparing for a paid order", () => {
    expect(decideFulfillmentTransition(order({status: "confirmed"}), "preparing")).toBe("apply");
  });

  it("applies preparing -> ready for a paid order", () => {
    expect(decideFulfillmentTransition(order({status: "preparing"}), "ready")).toBe("apply");
  });

  it.each<[OrderStatus, FulfillmentTarget]>([
    ["preparing", "preparing"],
    ["ready", "ready"],
  ])("treats %s -> %s as an already-done no-op", (status, to) => {
    expect(decideFulfillmentTransition(order({status}), to)).toBe("noop");
  });

  it("does not look at payment for a repeat: nothing is written, so nothing can be fulfilled by it", () => {
    expect(decideFulfillmentTransition(order({status: "ready", paymentStatus: "pending"}), "ready")).toBe("noop");
  });

  it.each<[OrderStatus, FulfillmentTarget]>([
    ["confirmed", "ready"],
    ["pending_payment", "preparing"],
    ["pending_payment", "ready"],
    ["cancelled", "preparing"],
    ["cancelled", "ready"],
    ["ready", "preparing"],
  ])("refuses %s -> %s with a 409 conflict", (status, to) => {
    const error = httpsErrorOf(() => decideFulfillmentTransition(order({status}), to));

    expect(error.code).toBe("aborted");
    expect(error.httpErrorCode.status).toBe(409);
  });

  it("explains that an order awaiting payment has not been paid", () => {
    const error = httpsErrorOf(() => decideFulfillmentTransition(
      order({status: "pending_payment", paymentStatus: "pending"}), "preparing",
    ));

    expect(error.message).toBe("This order has not been paid yet.");
  });

  it("names the current and requested statuses for any other refusal", () => {
    const error = httpsErrorOf(() => decideFulfillmentTransition(order({status: "ready"}), "preparing"));

    expect(error.message).toBe("This order is ready, so it can't be moved to preparing.");
  });

  it.each<[OrderStatus, FulfillmentTarget]>([
    ["confirmed", "preparing"],
    ["preparing", "ready"],
  ])("refuses %s -> %s when the order is not paid, even though the status fits", (status, to) => {
    const error = httpsErrorOf(() => decideFulfillmentTransition(order({status, paymentStatus: "pending"}), to));

    expect(error.code).toBe("aborted");
    expect(error.message).toBe("This order has not been paid yet.");
  });

  it.each(["confirmed", "pending_payment", "cancelled", "picked_up", "completed", "bogus", "", undefined, null, 7])(
    "rejects the unsupported target %j as an invalid argument (400), whatever the order's state",
    (to) => {
      for (const status of ["confirmed", "preparing", "ready"] as const) {
        const error = httpsErrorOf(() => decideFulfillmentTransition(order({status}), to));

        expect(error.code).toBe("invalid-argument");
        expect(error.httpErrorCode.status).toBe(400);
      }
    },
  );
});

describe("transitionOrderStatus — refused before any Firestore access", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    membership: membership(),
    orderId: ORDER_ID,
    to: "preparing" as FulfillmentTarget,
    ...overrides,
  });

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpsError) {
        return error.code;
      }
      throw error;
    }
    throw new Error("expected the call to be refused");
  }

  it.each(["invited", "revoked"] as const)("refuses a %s membership (403)", async (status) => {
    const code = await codeOf(transitionOrderStatus(untouchedDb(), input({membership: membership({status})})));

    expect(code).toBe("permission-denied");
  });

  it("refuses a role outside the fulfillment roles (403), even on an active membership", async () => {
    const unknownRole = "superadmin" as unknown as OrganizationMembership["role"];
    const code = await codeOf(
      transitionOrderStatus(untouchedDb(), input({membership: membership({role: unknownRole})})),
    );

    expect(code).toBe("permission-denied");
  });

  it.each(["", "a/b", "..", ".", "__x__", 5, undefined, null])("refuses the malformed order id %j (400)", async (orderId) => {
    const code = await codeOf(transitionOrderStatus(untouchedDb(), input({orderId})));

    expect(code).toBe("invalid-argument");
  });

  it.each(["confirmed", "cancelled", "picked_up", "bogus"])("refuses the unsupported target %j (400)", async (to) => {
    const code = await codeOf(transitionOrderStatus(untouchedDb(), input({to})));

    expect(code).toBe("invalid-argument");
  });
});

describe("transitionOrderStatus — a transaction Firestore gives up on", () => {
  /** A Firestore whose transaction fails with `error`, as when contention outlasts Firestore's own retries. */
  function dbFailingWith(error: unknown): Firestore {
    return {runTransaction: async () => {
      throw error;
    }} as unknown as Firestore;
  }

  const input = {membership: membership(), orderId: ORDER_ID, to: "preparing" as FulfillmentTarget};

  it.each([
    ["the numeric gRPC ABORTED code", Object.assign(new Error("10 ABORTED: Too much contention on these documents."), {code: 10})],
    ["the string code", Object.assign(new Error("aborted"), {code: "aborted"})],
  ])("is reported as a 409 conflict (not a 500) for %s", async (_label, error) => {
    const result = await transitionOrderStatus(dbFailingWith(error), input).catch((caught: unknown) => caught);

    expect(result).toBeInstanceOf(HttpsError);
    expect((result as HttpsError).code).toBe("aborted");
    expect((result as HttpsError).httpErrorCode.status).toBe(409);
    expect((result as HttpsError).message).toBe("This order was just changed by someone else. Refresh and try again.");
  });

  it.each([
    ["an unrelated Firestore failure", Object.assign(new Error("14 UNAVAILABLE"), {code: 14})],
    ["a plain error", new Error("boom")],
    ["a non-error", "boom"],
  ])("lets %s through untouched, so it is still a 500 rather than a misleading conflict", async (_label, error) => {
    await expect(transitionOrderStatus(dbFailingWith(error), input)).rejects.toBe(error);
  });

  it("lets a refusal the transaction itself threw (an HttpsError) through unchanged", async () => {
    const refusal = new HttpsError("not-found", "Order not found.");

    await expect(transitionOrderStatus(dbFailingWith(refusal), input)).rejects.toBe(refusal);
  });
});

describe("Order documents with fulfillment states", () => {
  const stored = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({...order(), ...overrides});

  it.each(["preparing", "ready"])("parses a stored %s order", (status) => {
    expect(parseOrder(stored({status}), ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID).status).toBe(status);
  });

  it("still parses an order that has none of the audit fields", () => {
    const parsed = parseOrder(stored(), ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);

    expect(parsed.preparingStartedAt).toBeUndefined();
    expect(parsed.preparingStartedBy).toBeUndefined();
    expect(parsed.readyAt).toBeUndefined();
    expect(parsed.readyBy).toBeUndefined();
  });

  it("round-trips the four audit fields", () => {
    const preparingStartedAt = Timestamp.fromDate(new Date("2026-09-27T05:00:00Z"));
    const readyAt = Timestamp.fromDate(new Date("2026-09-27T05:30:00Z"));

    const parsed = parseOrder(
      stored({status: "ready", preparingStartedAt, preparingStartedBy: "U-a", readyAt, readyBy: "U-b"}),
      ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID,
    );

    expect(parsed).toMatchObject({preparingStartedBy: "U-a", readyBy: "U-b"});
    expect(parsed.preparingStartedAt?.toMillis()).toBe(preparingStartedAt.toMillis());
    expect(parsed.readyAt?.toMillis()).toBe(readyAt.toMillis());
  });

  it.each([
    [{status: "picked_up"}],
    [{status: "completed"}],
    [{status: "PREPARING"}],
    [{preparingStartedBy: ""}],
    [{preparingStartedBy: 7}],
    [{preparingStartedAt: "2026-09-27T05:00:00Z"}],
    [{readyAt: 1}],
    [{readyBy: ""}],
  ])("still rejects the malformed document %j", (overrides) => {
    expect(() => parseOrder(stored(overrides), ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow(/Malformed order document/);
  });

  it("never puts the audit fields (or the customer's id) into the customer-safe response", () => {
    const response = toOrderResponse(order({
      status: "ready",
      preparingStartedAt: Timestamp.fromDate(new Date("2026-09-27T05:00:00Z")),
      preparingStartedBy: "U-secret-actor",
      readyAt: Timestamp.fromDate(new Date("2026-09-27T05:30:00Z")),
      readyBy: "U-secret-actor",
    }));

    expect(response.status).toBe("ready");
    expect(Object.keys(response).sort()).toEqual([
      "createdAt", "currency", "id", "items", "menuId", "organizationId", "outletId", "paymentStatus",
      "status", "subtotalInPaise", "totalInPaise", "updatedAt",
    ]);
    expect(JSON.stringify(response)).not.toContain("U-secret-actor");
    expect(JSON.stringify(response)).not.toContain("U-customer");
  });
});

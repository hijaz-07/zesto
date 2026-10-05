// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {Order} from "../domain/orders";
import {derivePickupCredentials} from "../domain/pickupCredential";
import {toResponseBody} from "../http/envelope";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {createOrderRoutes} from "./orders";

/**
 * `GET /orders/:orderId/pickup-credential` — the customer's own QR payload and
 * backup code. Authorization here is the order's CUSTOMER, so these tests are
 * mostly about who is refused. The same behavior against the real emulator,
 * with real documents, is in `orderPickup.emulator.test.ts`.
 */

const SECRET = "test-pickup-secret-0123456789-abcdefghij";
const CUSTOMER_ID = "U-customer";
const ORDER_ID = "order-1";
const PATH = `/orders/${ORDER_ID}/pickup-credential`;

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    userId: CUSTOMER_ID,
    organizationId: "org-1",
    outletId: "outlet-1",
    menuId: "menu-1",
    status: "ready",
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: 24000,
    totalInPaise: 24000,
    items: [{itemId: "item-1", name: "Chicken Biriyani", priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000}],
    createdAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    // Fields that must never reach the response:
    readyAt: Timestamp.fromDate(new Date("2026-09-27T05:00:00Z")),
    readyBy: "U-secret-actor",
    ...overrides,
  };
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({
      jwt: "irrelevant",
      token: {sub: userId, aud: ["P-test"]},
    })),
  };
}

function rejectingValidator(): SessionValidator {
  return {
    validateSession: vi.fn(async () => {
      throw new HttpsError("unauthenticated", "The session is invalid or has expired.");
    }),
  };
}

function unavailableValidator(): SessionValidator {
  return {
    validateSession: vi.fn(async () => {
      throw new HttpsError("unavailable", "The session could not be validated right now. Please try again.");
    }),
  };
}

function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

/** A Firestore whose `orders.id` collection-group lookup returns `stored` (or nothing). */
function dbFinding(stored: Order | undefined): Firestore {
  const doc = stored && {
    id: stored.id,
    ref: {
      path: `organizations/${stored.organizationId}/outlets/${stored.outletId}/menus/${stored.menuId}/orders/${stored.id}`,
      parent: {
        parent: {
          id: stored.menuId,
          parent: {parent: {id: stored.outletId, parent: {parent: {id: stored.organizationId}}}},
        },
      },
    },
    data: () => ({...stored}),
  };
  const query = {where: () => query, limit: () => query, get: async () => ({size: doc ? 1 : 0, docs: doc ? [doc] : []})};
  return {collectionGroup: () => query} as unknown as Firestore;
}

function get(
  deps: Parameters<typeof createOrderRoutes>[0],
  overrides: Partial<NormalizedRequest> = {},
  onError: (error: unknown) => void = () => {},
): Promise<ApiResult> {
  return handleRequest(
    createOrderRoutes(deps),
    {method: "GET", path: PATH, headers: {authorization: "Bearer token"}, query: {}, body: undefined, ...overrides},
    onError,
  );
}

describe("GET /orders/:orderId/pickup-credential — before any order is read", () => {
  it("rejects an unauthenticated caller (401) without touching Firestore", async () => {
    const result = await get({db: untouchedDb(), validator: rejectingValidator(), pickupSecret: () => SECRET}, {headers: {}});

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("rejects a rejected session (401, with WWW-Authenticate) without touching Firestore", async () => {
    const result = await get({db: untouchedDb(), validator: rejectingValidator(), pickupSecret: () => SECRET});

    expect(result).toMatchObject({kind: "error", status: 401, headers: {"WWW-Authenticate": "Bearer"}});
  });

  it("surfaces an identity-provider outage as 503, not as a denial", async () => {
    const result = await get({db: untouchedDb(), validator: unavailableValidator(), pickupSecret: () => SECRET});

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it.each(["..", ".", "__x__"])("rejects the malformed order ID %j (400) without touching Firestore", async (orderId) => {
    const result = await get(
      {db: untouchedDb(), validator: acceptingValidator(CUSTOMER_ID), pickupSecret: () => SECRET},
      {path: `/orders/${orderId}/pickup-credential`},
    );

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("does not answer %s (405, Allow: GET)", async (method) => {
    const result = await get(
      {db: untouchedDb(), validator: acceptingValidator(CUSTOMER_ID), pickupSecret: () => SECRET},
      {method},
    );

    expect(result).toMatchObject({kind: "error", status: 405, code: "method_not_allowed", headers: {Allow: "GET"}});
  });
});

describe("GET /orders/:orderId/pickup-credential — ownership", () => {
  it("gives the order's own customer exactly {pickup: {qrPayload, code}} — nothing else", async () => {
    const result = await get({db: dbFinding(order()), validator: acceptingValidator(CUSTOMER_ID), pickupSecret: () => SECRET});

    expect(result).toMatchObject({kind: "success", status: 200, userId: CUSTOMER_ID});
    const body = toResponseBody(result, "request-id");
    const expected = derivePickupCredentials(SECRET, ORDER_ID);
    expect(body).toEqual({data: {pickup: {qrPayload: expected.qrPayload, code: expected.code}}});
  });

  it("never exposes the customer, the audit fields, the organization, outlet or menu, or the secret", async () => {
    const result = await get({db: dbFinding(order()), validator: acceptingValidator(CUSTOMER_ID), pickupSecret: () => SECRET});

    const text = JSON.stringify(toResponseBody(result, "request-id"));
    for (const forbidden of [CUSTOMER_ID, "U-secret-actor", "org-1", "outlet-1", "menu-1", SECRET, "readyAt", "readyBy", "userId", "razorpay"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("answers an unrelated customer with the SAME 404 as an order that does not exist — knowing the ID is not enough", async () => {
    const getSecret = vi.fn(() => SECRET);

    const stranger = await get({db: dbFinding(order()), validator: acceptingValidator("U-stranger"), pickupSecret: getSecret});
    const missing = await get({db: dbFinding(undefined), validator: acceptingValidator("U-stranger"), pickupSecret: getSecret});

    expect(stranger).toMatchObject({kind: "error", status: 404, code: "not_found"});
    expect(toResponseBody(stranger, "request-id")).toEqual(toResponseBody(missing, "request-id"));
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("takes the caller from the verified session only: a userId in the query or headers changes nothing", async () => {
    const result = await get(
      {db: dbFinding(order()), validator: acceptingValidator("U-stranger"), pickupSecret: () => SECRET},
      {query: {userId: CUSTOMER_ID}, headers: {"authorization": "Bearer token", "x-user-id": CUSTOMER_ID}},
    );

    expect(result).toMatchObject({kind: "error", status: 404});
  });

  it.each([
    ["pending_payment", "pending"],
    ["confirmed", "paid"],
    ["preparing", "paid"],
    ["picked_up", "paid"],
    ["completed", "paid"],
    ["cancelled", "paid"],
  ] as const)("answers the customer's own %s (%s) order with 409 `conflict` — not this file's `already_exists`", async (status, paymentStatus) => {
    const result = await get({
      db: dbFinding(order({status, paymentStatus})),
      validator: acceptingValidator(CUSTOMER_ID),
      pickupSecret: () => SECRET,
    });

    expect(result).toMatchObject({kind: "error", status: 409, code: "conflict", message: "This order isn't ready for pickup."});
  });

  it("answers a missing secret as a generic 500 — only to the customer who owns a ready order, and without the detail", async () => {
    const onError = vi.fn();
    const pickupSecret = () => {
      throw new Error("PICKUP_CREDENTIAL_SECRET is not configured.");
    };

    const owner = await get({db: dbFinding(order()), validator: acceptingValidator(CUSTOMER_ID), pickupSecret}, {}, onError);
    const stranger = await get({db: dbFinding(order()), validator: acceptingValidator("U-stranger"), pickupSecret}, {}, onError);

    expect(owner).toMatchObject({kind: "error", status: 500, message: "An unexpected error occurred."});
    expect(JSON.stringify(owner)).not.toContain("PICKUP_CREDENTIAL_SECRET");
    expect(stranger).toMatchObject({kind: "error", status: 404});
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

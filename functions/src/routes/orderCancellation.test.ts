// @vitest-environment node
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {createOrderRoutes} from "./orders";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * The cancellation routes' behavior up to the point an order is read, against
 * fakes that cannot read one: a request that gets as far as the order
 * transaction makes the fake throw. What cancelling does to the order, the
 * payment and the refund is proven against the Firestore emulator
 * (`orderCancellation.emulator.test.ts` for the domain,
 * `orderCancellation.routes.emulator.test.ts` for the HTTP mapping).
 */

const ORG_ID = "org-1";
const ORDER_ID = "order-1";

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

/**
 * A fake that supports ONLY the membership read `requireOrganizationRole`
 * performs; the order lookup (a transaction) throws, so a test proves a request
 * stopped at or before the order.
 *
 * @param {{role: string, status: string} | undefined} membership What the
 *   member document holds; undefined means "no such document".
 * @return {Firestore} The fake.
 */
function membershipOnlyDb(membership?: {role: string; status: string}): Firestore {
  const transactions = membershipOnlyDb.transactions;
  return {
    collection: (rootName: string) => ({
      doc: (organizationId: string) => ({
        collection: (name: string) => {
          if (rootName !== "organizations" || name !== "members") {
            throw new Error(`Unexpected read of ${rootName}/${organizationId}/${name}.`);
          }
          return {
            doc: () => ({get: async () => ({exists: membership !== undefined, data: () => membership})}),
          };
        },
      }),
    }),
    runTransaction: () => {
      transactions.count += 1;
      throw new Error("The order transaction was reached.");
    },
    collectionGroup: () => {
      throw new Error("The order lookup was reached.");
    },
  } as unknown as Firestore;
}

membershipOnlyDb.transactions = {count: 0};

function customerCancel(
  deps: Parameters<typeof createOrderRoutes>[0],
  overrides: Partial<NormalizedRequest> = {},
): Promise<ApiResult> {
  return handleRequest(createOrderRoutes(deps), {
    method: "POST",
    path: `/orders/${ORDER_ID}/cancel`,
    headers: {authorization: "Bearer token"},
    query: {},
    body: undefined,
    ...overrides,
  }, () => {});
}

function orgCancel(
  deps: Parameters<typeof createOrganizationOrderRoutes>[0],
  overrides: Partial<NormalizedRequest> = {},
): Promise<ApiResult> {
  return handleRequest(createOrganizationOrderRoutes(deps), {
    method: "POST",
    path: `/organizations/${ORG_ID}/orders/${ORDER_ID}/cancel`,
    headers: {authorization: "Bearer token"},
    query: {},
    body: {reason: "outlet_closed"},
    ...overrides,
  }, () => {});
}

describe("POST /orders/:orderId/cancel — before any order is read", () => {
  it("rejects an unauthenticated caller (401) without touching Firestore", async () => {
    const result = await customerCancel({db: untouchedDb(), validator: rejectingValidator()}, {headers: {}});

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it.each([["a string", "changed_my_mind"], ["an array", ["other"]], ["a number", 7]])(
    "rejects a body that is %s (400) without touching Firestore",
    async (_name, body) => {
      const result = await customerCancel({db: untouchedDb(), validator: acceptingValidator("U-1")}, {body});

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    },
  );

  it("rejects a malformed order ID (400) without touching Firestore", async () => {
    const routes = createOrderRoutes({db: untouchedDb(), validator: acceptingValidator("U-1")});
    const route = routes.find((r) => r.path === "/orders/:orderId/cancel");

    const result = await route?.handler({
      request: {method: "POST", path: "/orders/../cancel", headers: {authorization: "Bearer t"}, query: {}, body: {}},
      params: {orderId: ".."},
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument", message: "Invalid order ID."});
  });

  it("answers 405 with Allow: POST to a GET", async () => {
    const result = await customerCancel({db: untouchedDb(), validator: acceptingValidator("U-1")}, {method: "GET"});

    expect(result).toMatchObject({kind: "error", status: 405, code: "method_not_allowed", headers: {Allow: "POST"}});
  });
});

describe("POST /organizations/:organizationId/orders/:orderId/cancel — before any order is read", () => {
  it("rejects an unauthenticated caller (401) without touching Firestore", async () => {
    const result = await orgCancel({db: untouchedDb(), validator: rejectingValidator()}, {headers: {}});

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("refuses staff (403): cancelling starts a refund, which is money", async () => {
    const result = await orgCancel({
      db: membershipOnlyDb({role: "staff", status: "active"}),
      validator: acceptingValidator("U-staff"),
    });

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each([
    ["not a member at all", undefined],
    ["a revoked owner", {role: "owner", status: "revoked"}],
    ["an invited manager", {role: "manager", status: "invited"}],
  ])("refuses %s (403)", async (_name, membership) => {
    const result = await orgCancel({db: membershipOnlyDb(membership), validator: acceptingValidator("U-x")});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager"])("lets an active %s through to the order lookup", async (role) => {
    membershipOnlyDb.transactions.count = 0;

    const result = await orgCancel({
      db: membershipOnlyDb({role, status: "active"}),
      validator: acceptingValidator("U-ok"),
    });

    // The fake's order transaction throws (a 500 here): past authorization, the request went for the order.
    expect(membershipOnlyDb.transactions.count).toBe(1);
    expect(result).toMatchObject({kind: "error", status: 500});
  });

  it("rejects a body that is not an object (400) after authorizing, without reading an order", async () => {
    const result = await orgCancel({
      db: membershipOnlyDb({role: "owner", status: "active"}),
      validator: acceptingValidator("U-owner"),
    }, {body: "outlet_closed"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("answers 405 with Allow: POST to a GET", async () => {
    const result = await orgCancel({db: untouchedDb(), validator: acceptingValidator("U-1")}, {method: "GET"});

    expect(result).toMatchObject({kind: "error", status: 405, code: "method_not_allowed", headers: {Allow: "POST"}});
  });
});

// @vitest-environment node
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * The fulfillment routes' behavior up to (and including) the authorization
 * boundary, against fakes that cannot read an order: a request that gets as far
 * as the orders query makes the fake throw. What happens to the order itself is
 * proven against the Firestore emulator
 * (`organizationOrderFulfillment.emulator.test.ts`).
 */

const ORG_ID = "org-1";
const ORDER_ID = "order-1";

const ACTIONS = [
  {name: "start-preparing", to: "preparing"},
  {name: "mark-ready", to: "ready"},
  {name: "complete", to: "completed"},
] as const;

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(action: string, overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "POST",
    path: `/organizations/${ORG_ID}/orders/${ORDER_ID}/${action}`,
    headers: {authorization: "Bearer token"},
    query: {},
    body: undefined,
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

/** A Firestore stand-in that throws on any property access. */
function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

interface FakeDb {
  db: Firestore;
  /** Every `organizations/{org}/members/{user}` path the route read. */
  memberReads: string[];
}

/**
 * A fake Admin Firestore that supports ONLY the membership read
 * `requireOrganizationRole` performs. Reaching the order lookup (a
 * collection-group query, inside a transaction) throws, so a test proves a
 * request was stopped at or before the authorization boundary.
 *
 * @param {{role: string, status: string} | undefined} membership What the
 *   member document holds; undefined means "no such document".
 * @return {FakeDb} The fake and the member reads it saw.
 */
function fakeDb(membership?: {role: string; status: string}): FakeDb {
  const memberReads: string[] = [];
  const db = {
    collection: (rootName: string) => ({
      doc: (organizationId: string) => ({
        collection: (name: string) => {
          if (rootName !== "organizations" || name !== "members") {
            throw new Error(`Unexpected read of ${rootName}/${organizationId}/${name}.`);
          }
          return {
            doc: (userId: string) => ({
              get: async () => {
                memberReads.push(`organizations/${organizationId}/members/${userId}`);
                return {exists: membership !== undefined, data: () => membership};
              },
            }),
          };
        },
      }),
    }),
    runTransaction: () => {
      throw new Error("The order transaction should not have been reached.");
    },
    collectionGroup: () => {
      throw new Error("The order lookup should not have been reached.");
    },
  } as unknown as Firestore;
  return {db, memberReads};
}

function post(
  deps: Parameters<typeof createOrganizationOrderRoutes>[0],
  action: string,
  overrides: Partial<NormalizedRequest> = {},
): Promise<ApiResult> {
  return handleRequest(createOrganizationOrderRoutes(deps), request(action, overrides), () => {});
}

describe.each(ACTIONS)("POST .../orders/:orderId/$name — before any order is read", ({name}) => {
  it("rejects an unauthenticated caller (401) without touching Firestore", async () => {
    const result = await post({db: untouchedDb(), validator: rejectingValidator()}, name, {headers: {}});

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("rejects a rejected session (401, with WWW-Authenticate) without touching Firestore", async () => {
    const result = await post({db: untouchedDb(), validator: rejectingValidator()}, name);

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("surfaces an identity-provider outage as 503, not as a denial", async () => {
    const result = await post({db: untouchedDb(), validator: unavailableValidator()}, name);

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("rejects a malformed organization ID (400) without touching Firestore", async () => {
    for (const organizationId of ["..", ".", "__x__"]) {
      const result = await post(
        {db: untouchedDb(), validator: acceptingValidator("U-1")},
        name,
        {path: `/organizations/${organizationId}/orders/${ORDER_ID}/${name}`},
      );

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    }
  });

  it("reads the membership of the VERIFIED user, in the path's organization — never one named in the request", async () => {
    const {db, memberReads} = fakeDb(undefined);

    await post(
      {db, validator: acceptingValidator("U-verified")},
      name,
      {
        query: {userId: "U-attacker", organizationId: "org-attacker"},
        body: {userId: "U-attacker", organizationId: "org-attacker", status: "ready"},
      },
    );

    expect(memberReads).toEqual([`organizations/${ORG_ID}/members/U-verified`]);
  });

  it("denies a caller with no membership document (403): a customer-only account", async () => {
    const {db} = fakeDb(undefined);

    const result = await post({db, validator: acceptingValidator("U-customer")}, name);

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager", "staff"])("denies an %s whose membership is invited (403)", async (role) => {
    const {db} = fakeDb({role, status: "invited"});

    const result = await post({db, validator: acceptingValidator("U-1")}, name);

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager", "staff"])("denies an %s whose membership is revoked (403)", async (role) => {
    const {db} = fakeDb({role, status: "revoked"});

    const result = await post({db, validator: acceptingValidator("U-1")}, name);

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("denies a member document with an unknown role (403)", async () => {
    const {db} = fakeDb({role: "superadmin", status: "active"});

    const result = await post({db, validator: acceptingValidator("U-1")}, name);

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager", "staff"])(
    "lets an active %s past authorization: a malformed order ID is then a 400, never reaching an order lookup",
    async (role) => {
      const {db} = fakeDb({role, status: "active"});

      const result = await post(
        {db, validator: acceptingValidator("U-1")},
        name,
        {path: `/organizations/${ORG_ID}/orders/__x__/${name}`},
      );

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    },
  );

  it("authorizes before it validates the order ID: a non-member never learns whether it was well formed", async () => {
    const {db} = fakeDb(undefined);

    const result = await post(
      {db, validator: acceptingValidator("U-1")},
      name,
      {path: `/organizations/${ORG_ID}/orders/__x__/${name}`},
    );

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("does not answer GET (405, Allow: POST)", async () => {
    const result = await post({db: untouchedDb(), validator: acceptingValidator("U-1")}, name, {method: "GET"});

    expect(result).toMatchObject({kind: "error", status: 405, code: "method_not_allowed", headers: {Allow: "POST"}});
  });

  it.each(["PATCH", "PUT", "DELETE"])("does not answer %s (405)", async (method) => {
    const result = await post({db: untouchedDb(), validator: acceptingValidator("U-1")}, name, {method});

    expect(result).toMatchObject({kind: "error", status: 405, code: "method_not_allowed"});
  });
});

describe("there is no generic way to set an order's status", () => {
  // In particular nothing under an order's own ID can hand it over: pickup needs
  // a credential, so it is `POST .../pickups` (organizationOrderPickup.test.ts).
  // Cancellation is deliberately absent from this list: `POST .../orders/:orderId/cancel`
  // exists, but as its own money-handling action with its own role set and tests
  // (orderCancellation.test.ts), not as a way to set a status.
  it.each([
    "status", "fulfillment", "transition", "ready", "preparing", "completed", "picked-up", "picked_up",
    "pickup", "pickups", "collect", "redeem", "redeem-pickup", "handover",
  ])(
    "has no POST .../orders/:orderId/%s route",
    async (action) => {
      const result = await post({db: untouchedDb(), validator: acceptingValidator("U-1")}, action);

      expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
    },
  );

  it("does not accept a write to the order list itself", async () => {
    const result = await post(
      {db: untouchedDb(), validator: acceptingValidator("U-1")},
      "",
      {path: `/organizations/${ORG_ID}/orders`, body: {status: "ready"}},
    );

    expect(result).toMatchObject({kind: "error", status: 405, code: "method_not_allowed"});
  });
});

// @vitest-environment node
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {NormalizedRequest, RouteContext} from "../http/types";
import {createOrganizationOrderRoutes} from "./organizationOrders";

const ORG_ID = "org-1";

// verifyDescopeSession reads the expected audience from DESCOPE_PROJECT_ID
// even when a fake SessionValidator is injected, so every test needs it set.
beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "GET",
    path: `/organizations/${ORG_ID}/orders`,
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
 * `requireOrganizationRole` performs. Reaching a collection-group query (or
 * any other read) throws, so a test proves a request was stopped at or before
 * the authorization boundary.
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
    collectionGroup: () => {
      throw new Error("The orders query should not have been reached.");
    },
  } as unknown as Firestore;
  return {db, memberReads};
}

function call(deps: Parameters<typeof createOrganizationOrderRoutes>[0], ctx: RouteContext) {
  return createOrganizationOrderRoutes(deps)[0].handler(ctx);
}

function ctxFor(organizationId: string, query: Record<string, unknown> = {}, headers?: NormalizedRequest["headers"]) {
  return {
    request: request({query, ...(headers ? {headers} : {})}),
    params: {organizationId},
  };
}

describe("createOrganizationOrderRoutes", () => {
  it("registers the order list, the three fulfillment actions and pickup — and nothing else", () => {
    const routes = createOrganizationOrderRoutes({db: untouchedDb()});

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /organizations/:organizationId/orders",
      "POST /organizations/:organizationId/orders/:orderId/start-preparing",
      "POST /organizations/:organizationId/orders/:orderId/mark-ready",
      "POST /organizations/:organizationId/orders/:orderId/complete",
      "POST /organizations/:organizationId/pickups",
    ]);
  });
});

describe("GET /organizations/:organizationId/orders — before any query", () => {
  it("rejects an unauthenticated caller (401) without touching Firestore", async () => {
    const result = await call(
      {db: untouchedDb(), validator: rejectingValidator()},
      ctxFor(ORG_ID, {}, {}),
    );

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("rejects a request with a rejected session (401) without touching Firestore", async () => {
    const result = await call({db: untouchedDb(), validator: rejectingValidator()}, ctxFor(ORG_ID));

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("surfaces an identity-provider outage as 503, not as a denial", async () => {
    const result = await call({db: untouchedDb(), validator: unavailableValidator()}, ctxFor(ORG_ID));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("rejects a malformed organization ID (400) without touching Firestore", async () => {
    for (const organizationId of ["..", ".", "__x__"]) {
      const result = await call(
        {db: untouchedDb(), validator: acceptingValidator("U-1")},
        ctxFor(organizationId),
      );

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    }
  });

  it("reads the membership of the VERIFIED user, in the path's organization — never a user from the request", async () => {
    const {db, memberReads} = fakeDb(undefined);

    await call(
      {db, validator: acceptingValidator("U-verified")},
      ctxFor(ORG_ID, {userId: "U-attacker", organizationId: "org-attacker"}),
    );

    expect(memberReads).toEqual([`organizations/${ORG_ID}/members/U-verified`]);
  });

  it("denies a caller with no membership document (403): a customer-only account", async () => {
    const {db} = fakeDb(undefined);

    const result = await call({db, validator: acceptingValidator("U-customer")}, ctxFor(ORG_ID));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["invited", "revoked"])("denies a member whose status is %s (403)", async (status) => {
    const {db} = fakeDb({role: "owner", status});

    const result = await call({db, validator: acceptingValidator("U-1")}, ctxFor(ORG_ID));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("denies a member document with an unknown role (403)", async () => {
    const {db} = fakeDb({role: "superadmin", status: "active"});

    const result = await call({db, validator: acceptingValidator("U-1")}, ctxFor(ORG_ID));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("authorizes before it validates the query: a non-member never learns whether the query was valid", async () => {
    const {db} = fakeDb(undefined);

    const result = await call(
      {db, validator: acceptingValidator("U-1")},
      ctxFor(ORG_ID, {limit: "not-a-number", outletId: "a/b", cursor: ""}),
    );

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager", "staff"])(
    "lets an active %s past authorization: an invalid query is then a 400, not a 403",
    async (role) => {
      const {db} = fakeDb({role, status: "active"});

      const result = await call(
        {db, validator: acceptingValidator("U-1")},
        ctxFor(ORG_ID, {limit: "0"}),
      );

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    },
  );

  it.each([
    [{outletId: ""}],
    [{outletId: "a/b"}],
    [{outletId: ".."}],
    [{limit: "abc"}],
    [{cursor: ""}],
  ])("rejects the invalid query %j with a 400 rather than widening it", async (query) => {
    const {db} = fakeDb({role: "owner", status: "active"});

    const result = await call({db, validator: acceptingValidator("U-1")}, ctxFor(ORG_ID, query));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects a cursor outside the organization (400) before reading any orders", async () => {
    const {db} = fakeDb({role: "staff", status: "active"});
    // A syntactically valid cursor naming another organization's order.
    const payload = {s: 1, n: 0, p: "organizations/org-2/outlets/o/menus/m/orders/x"};
    const cursor = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    const result = await call({db, validator: acceptingValidator("U-1")}, ctxFor(ORG_ID, {cursor}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument", message: "Invalid cursor."});
  });
});

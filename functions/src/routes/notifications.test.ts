// @vitest-environment node
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {handleRequest} from "../http/handleRequest";
import {matchRoute} from "../http/router";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {createNotificationRoutes} from "./notifications";

/**
 * The notification routes' behavior up to (and including) the authorization
 * boundary, against fakes that cannot read an inbox: a request that gets as far
 * as the inbox makes the fake throw. What the routes do to inboxes is proven
 * against the Firestore emulator (`notifications.emulator.test.ts`).
 */

const ORG_ID = "org-1";

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(method: string, path: string, overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {method, path, headers: {authorization: "Bearer token"}, query: {}, body: undefined, ...overrides};
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({jwt: "irrelevant", token: {sub: userId, aud: ["P-test"]}})),
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

/**
 * A fake that supports ONLY the membership read `requireOrganizationRole`
 * performs; reaching an inbox read throws.
 *
 * @param {{role: string, status: string} | undefined} membership What the
 *   member document holds; undefined means "no such document".
 * @return {{db: Firestore, memberReads: string[]}} The fake and the reads it saw.
 */
function fakeDb(membership?: {role: string; status: string}): {db: Firestore; memberReads: string[]} {
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
  } as unknown as Firestore;
  return {db, memberReads};
}

function call(
  deps: Parameters<typeof createNotificationRoutes>[0],
  req: NormalizedRequest,
): Promise<ApiResult> {
  return handleRequest(createNotificationRoutes(deps), req, () => {});
}

const CUSTOMER_ROUTES: Array<[string, string]> = [
  ["GET", "/notifications"],
  ["GET", "/notifications/unread-count"],
  ["POST", "/notifications/read-all"],
  ["POST", "/notifications/order-1_order_ready.customer/read"],
];

const ORG_ROUTES: Array<[string, string]> = CUSTOMER_ROUTES.map(([method, path]) => [
  method,
  `/organizations/${ORG_ID}${path}`,
]);

describe("route table", () => {
  const routes = createNotificationRoutes({db: untouchedDb()});

  it("registers the four customer and four organization routes", () => {
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /notifications",
      "GET /notifications/unread-count",
      "GET /organizations/:organizationId/notifications",
      "GET /organizations/:organizationId/notifications/unread-count",
      "POST /notifications/:notificationId/read",
      "POST /notifications/read-all",
      "POST /organizations/:organizationId/notifications/:notificationId/read",
      "POST /organizations/:organizationId/notifications/read-all",
    ]);
  });

  it("routes `read-all` to read-all, never to a notification named read-all", () => {
    const customer = matchRoute(routes, "POST", "/notifications/read-all");

    expect(customer).toMatchObject({kind: "found", route: {path: "/notifications/read-all"}});
  });

  it("captures the notification id", () => {
    const match = matchRoute(routes, "POST", "/notifications/abc.customer/read");

    expect(match).toMatchObject({kind: "found", params: {notificationId: "abc.customer"}});
  });
});

describe.each([...CUSTOMER_ROUTES, ...ORG_ROUTES])("%s %s — authentication", (method, path) => {
  it("rejects a request with no credentials (401) without touching Firestore", async () => {
    const result = await call({db: untouchedDb(), validator: rejectingValidator()}, request(method, path, {headers: {}}));

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("rejects a rejected session (401, with WWW-Authenticate)", async () => {
    const result = await call({db: untouchedDb(), validator: rejectingValidator()}, request(method, path));

    expect(result).toMatchObject({kind: "error", status: 401, headers: {"WWW-Authenticate": "Bearer"}});
  });

  it("surfaces an identity-provider outage as 503, not as a denial", async () => {
    const result = await call({db: untouchedDb(), validator: unavailableValidator()}, request(method, path));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });
});

describe.each(ORG_ROUTES)("%s %s — organization authorization", (method, path) => {
  it.each([
    ["no membership", undefined],
    ["an invited member", {role: "staff", status: "invited"}],
    ["a revoked owner", {role: "owner", status: "revoked"}],
    ["an unknown role", {role: "customer", status: "active"}],
  ])("refuses %s (403) before any inbox is read", async (_label, membership) => {
    const {db} = fakeDb(membership);

    const result = await call({db, validator: acceptingValidator("U-1")}, request(method, path));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("reads the membership of the VERIFIED user, in the path's organization — never one named in the request", async () => {
    const {db, memberReads} = fakeDb(undefined);

    await call(
      {db, validator: acceptingValidator("U-verified")},
      request(method, path, {query: {userId: "U-other", organizationId: "org-other"}, body: {userId: "U-other"}}),
    );

    expect(memberReads).toEqual([`organizations/${ORG_ID}/members/U-verified`]);
  });

  it("refuses a malformed organization ID (400) without touching Firestore", async () => {
    for (const organizationId of ["..", ".", "__x__"]) {
      const result = await call(
        {db: untouchedDb(), validator: acceptingValidator("U-1")},
        request(method, path.replace(ORG_ID, organizationId)),
      );

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    }
  });
});

describe("GET /notifications — query validation", () => {
  it.each([
    {limit: "0"}, {limit: "abc"}, {unread: "maybe"}, {cursor: ""},
  ])("rejects %j (400) for an authenticated caller, without touching Firestore", async (query) => {
    const result = await call({db: untouchedDb(), validator: acceptingValidator("U-1")}, request("GET", "/notifications", {query}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects a malformed cursor (400) before reading anything", async () => {
    const result = await call(
      {db: untouchedDb(), validator: acceptingValidator("U-1")},
      request("GET", "/notifications", {query: {cursor: "not a cursor!"}}),
    );

    expect(result).toMatchObject({kind: "error", status: 400, message: "Invalid cursor."});
  });

  it("does not validate the query for a caller who is not an authorized member (403 first)", async () => {
    const {db} = fakeDb(undefined);

    const result = await call(
      {db, validator: acceptingValidator("U-1")},
      request("GET", `/organizations/${ORG_ID}/notifications`, {query: {limit: "abc"}}),
    );

    expect(result).toMatchObject({kind: "error", status: 403});
  });
});

describe("POST .../read — path validation", () => {
  it.each(["__x__", ".."])("refuses the notification id %j (400) for an authenticated caller", async (id) => {
    const result = await call(
      {db: untouchedDb(), validator: acceptingValidator("U-1")},
      request("POST", `/notifications/${id}/read`),
    );

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });
});

// @vitest-environment node
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {derivePickupCredentials} from "../domain/pickupCredential";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * `POST /organizations/:organizationId/pickups` up to (and including) the
 * authorization boundary and the request body, against fakes that cannot read
 * an order: a request that reaches the order lookup or the transaction makes
 * the fake throw. What happens to the order itself is proven against the
 * Firestore emulator (`orderPickup.emulator.test.ts`, in `routes/`).
 */

const ORG_ID = "org-1";
const SECRET = "test-pickup-secret-0123456789-abcdefghij";
const QR = derivePickupCredentials(SECRET, "order-1").qrPayload;
const PATH = `/organizations/${ORG_ID}/pickups`;

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "POST",
    path: PATH,
    headers: {authorization: "Bearer token"},
    query: {},
    body: {credential: QR},
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
 * `requireOrganizationRole` performs; reaching an order lookup or a
 * transaction throws, so a test proves a request stopped before them.
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
      throw new Error("The pickup transaction should not have been reached.");
    },
    collectionGroup: () => {
      throw new Error("The order lookup should not have been reached.");
    },
  } as unknown as Firestore;
  return {db, memberReads};
}

function post(
  deps: Parameters<typeof createOrganizationOrderRoutes>[0],
  overrides: Partial<NormalizedRequest> = {},
  onError: (error: unknown) => void = () => {},
): Promise<ApiResult> {
  return handleRequest(createOrganizationOrderRoutes(deps), request(overrides), onError);
}

describe("POST .../pickups — before any order is read", () => {
  it("rejects an unauthenticated caller (401) without touching Firestore", async () => {
    const result = await post({db: untouchedDb(), validator: rejectingValidator()}, {headers: {}});

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("rejects a rejected session (401, with WWW-Authenticate) without touching Firestore", async () => {
    const result = await post({db: untouchedDb(), validator: rejectingValidator()});

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("surfaces an identity-provider outage as 503, not as a denial", async () => {
    const result = await post({db: untouchedDb(), validator: unavailableValidator()});

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("rejects a malformed organization ID (400) without touching Firestore", async () => {
    for (const organizationId of ["..", ".", "__x__"]) {
      const result = await post(
        {db: untouchedDb(), validator: acceptingValidator("U-1")},
        {path: `/organizations/${organizationId}/pickups`},
      );

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    }
  });

  it("reads the membership of the VERIFIED user, in the path's organization — never one named in the request", async () => {
    const {db, memberReads} = fakeDb(undefined);

    await post(
      {db, validator: acceptingValidator("U-verified")},
      {
        query: {userId: "U-attacker", organizationId: "org-attacker"},
        body: {credential: QR, userId: "U-attacker", organizationId: "org-attacker", status: "picked_up"},
      },
    );

    expect(memberReads).toEqual([`organizations/${ORG_ID}/members/U-verified`]);
  });

  it("denies a caller with no membership document (403): a customer-only account", async () => {
    const {db} = fakeDb(undefined);

    const result = await post({db, validator: acceptingValidator("U-customer")});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager", "staff"])("denies an %s whose membership is invited (403)", async (role) => {
    const {db} = fakeDb({role, status: "invited"});

    const result = await post({db, validator: acceptingValidator("U-1")});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager", "staff"])("denies an %s whose membership is revoked (403)", async (role) => {
    const {db} = fakeDb({role, status: "revoked"});

    const result = await post({db, validator: acceptingValidator("U-1")});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("denies a member document with an unknown role (403)", async () => {
    const {db} = fakeDb({role: "superadmin", status: "active"});

    const result = await post({db, validator: acceptingValidator("U-1")});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("authorizes before it reads the body: a non-member never learns whether theirs was well formed", async () => {
    const {db} = fakeDb(undefined);

    const result = await post({db, validator: acceptingValidator("U-1")}, {body: {credential: 12345}});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("does not call for the secret until the caller is authorized", async () => {
    const pickupSecret = vi.fn(() => SECRET);
    const {db} = fakeDb(undefined);

    await post({db, validator: acceptingValidator("U-1"), pickupSecret});

    expect(pickupSecret).not.toHaveBeenCalled();
  });
});

describe("POST .../pickups — the body, once authorized", () => {
  const authorized = () => ({db: fakeDb({role: "staff", status: "active"}).db, validator: acceptingValidator("U-staff")});

  it.each([
    ["no body", undefined],
    ["an empty object", {}],
    ["a string body", QR],
    ["a missing credential", {outletId: "outlet-1"}],
    ["an empty credential", {credential: ""}],
    ["a blank credential", {credential: "   "}],
    ["a numeric credential", {credential: 12345678}],
    ["an over-long credential", {credential: "A".repeat(500)}],
    ["a non-string outletId", {credential: QR, outletId: 7}],
  ])("answers 400 for %s, before any order is read", async (_label, body) => {
    const result = await post(authorized(), {body});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["nope", "ABCD-EFG", "ZP1.", "ZP1.a.b"])(
    "answers 400 for the badly-shaped credential %j, before any order is read",
    async (credential) => {
      const result = await post(authorized(), {body: {credential}});

      expect(result).toMatchObject({
        kind: "error", status: 400, code: "invalid_argument", message: "That doesn't look like a Zesto pickup code.",
      });
    },
  );

  it.each(["", "a/b", "..", "__x__"])("answers 400 for the malformed outletId %j, before any order is read", async (outletId) => {
    const result = await post(authorized(), {body: {credential: QR, outletId}});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("never echoes the credential in an error message or the log context", async () => {
    const secretLooking = "ZP1.SUPER-SECRET-ORDER-ID-leak-check";

    const result = await post(authorized(), {body: {credential: secretLooking}});

    expect(JSON.stringify(result)).not.toContain("SUPER-SECRET");
    expect(JSON.stringify(result)).not.toContain(secretLooking);
  });

  it("answers a missing secret as a generic 500 — never as a bad credential, and without the detail", async () => {
    const onError = vi.fn();
    const pickupSecret = () => {
      throw new Error("PICKUP_CREDENTIAL_SECRET is not configured.");
    };

    const result = await post({...authorized(), pickupSecret}, {}, onError);

    expect(result).toMatchObject({kind: "error", status: 500, code: "internal", message: "An unexpected error occurred."});
    expect(JSON.stringify(result)).not.toContain("PICKUP_CREDENTIAL_SECRET");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("POST .../pickups — method handling", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE"])("does not answer %s (405, Allow: POST)", async (method) => {
    const result = await post({db: untouchedDb(), validator: acceptingValidator("U-1")}, {method});

    expect(result).toMatchObject({kind: "error", status: 405, code: "method_not_allowed", headers: {Allow: "POST"}});
  });
});

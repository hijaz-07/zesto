// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {NormalizedRequest} from "../http/types";
import {createMeRoutes} from "./me";

// verifyDescopeSession reads the expected audience from DESCOPE_PROJECT_ID
// even when a fake SessionValidator is injected, so every test needs it set.
beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fake Admin Firestore serving `users/{userId}` through `runTransaction`. */
function fakeDb(existing?: Record<string, unknown>) {
  let stored = existing;
  const create = vi.fn((_ref: unknown, data: Record<string, unknown>) => {
    stored = data;
  });
  const tx = {
    get: vi.fn(async () => ({exists: stored !== undefined, data: () => stored})),
    create,
  };
  const db = {
    collection: () => ({doc: () => ({})}),
    runTransaction: vi.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };
  return {db: db as unknown as Firestore, create};
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "GET",
    path: "/me",
    headers: {},
    query: {},
    body: undefined,
    ...overrides,
  };
}

function getMeHandler(validator: SessionValidator, db: Firestore) {
  const routes = createMeRoutes({db, validator});
  const route = routes.find((r) => r.method === "GET" && r.path === "/me");
  if (!route) throw new Error("GET /me route not registered");
  return route.handler;
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({
      jwt: "irrelevant",
      token: {sub: userId, aud: ["P-test"]},
    })),
  };
}

describe("GET /me", () => {
  it("returns 200 with the caller's profile when authenticated", async () => {
    const {db} = fakeDb(undefined);
    const handler = getMeHandler(acceptingValidator("U-1"), db);

    const result = await handler({
      request: request({headers: {authorization: "Bearer token"}}),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({id: "U-1"});
      expect(result.userId).toBe("U-1");
    }
  });

  it("maps a rejected session to 401 with WWW-Authenticate: Bearer", async () => {
    const validator: SessionValidator = {
      validateSession: vi.fn(async () => {
        throw new HttpsError("unauthenticated", "The session is invalid or has expired.");
      }),
    };
    const {db} = fakeDb();
    const handler = getMeHandler(validator, db);

    const result = await handler({
      request: request({headers: {authorization: "Bearer token"}}),
    });

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure to 503, without WWW-Authenticate", async () => {
    const validator: SessionValidator = {
      validateSession: vi.fn(async () => {
        throw new HttpsError("unavailable", "The session could not be validated right now. Please try again.");
      }),
    };
    const {db} = fakeDb();
    const handler = getMeHandler(validator, db);

    const result = await handler({
      request: request({headers: {authorization: "Bearer token"}}),
    });

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
    if (result.kind === "error") {
      expect(result.headers?.["WWW-Authenticate"]).toBeUndefined();
    }
  });

  it("takes the caller's identity only from the verified session, " +
    "ignoring a forged userId in the query, body, or X-User-Id header",
  async () => {
    const {db, create} = fakeDb(undefined);
    const handler = getMeHandler(acceptingValidator("U-real"), db);

    const result = await handler({
      request: request({
        headers: {
          authorization: "Bearer token",
          "x-user-id": "U-attacker",
        },
        query: {userId: "U-attacker"},
        body: {userId: "U-attacker"},
      }),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toMatchObject({id: "U-real"});
    }
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({id: "U-real"}),
    );
  });

  it("on second call, returns the existing profile without a new write", async () => {
    const existingCreatedAt = Timestamp.now();
    const {db, create} = fakeDb({id: "U-1", createdAt: existingCreatedAt});
    const handler = getMeHandler(acceptingValidator("U-1"), db);

    const result = await handler({request: request({headers: {authorization: "Bearer token"}})});

    expect(create).not.toHaveBeenCalled();
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toMatchObject({
        id: "U-1",
        createdAt: existingCreatedAt.toDate().toISOString(),
      });
    }
  });
});

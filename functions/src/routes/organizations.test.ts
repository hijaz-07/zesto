// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {NormalizedRequest} from "../http/types";
import {createOrganizationRoutes} from "./organizations";

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
    method: "POST",
    path: "/organizations",
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

/** A fake Admin Firestore for `POST /organizations`, mirroring the calls `createOrganization` makes. */
function fakeCreateDb(slugExists = false) {
  const orgAutoId = "org-auto-1";
  const orgRef = {
    id: orgAutoId,
    collection: () => ({doc: () => ({})}),
  };
  const tx = {
    get: vi.fn(async () => ({exists: slugExists})),
    create: vi.fn(),
  };
  const db = {
    collection: (name: string) => ({
      doc: () => (name === "organizations" ? orgRef : {id: "slug-ref"}),
    }),
    runTransaction: vi.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };
  return {db: db as unknown as Firestore, orgAutoId};
}

/** The chainable query surface `listOrganizationsForUser` calls on the collection-group query. */
interface FakeQuery {
  where: () => FakeQuery;
  orderBy: () => FakeQuery;
  get: () => Promise<{empty: boolean; docs: unknown[]}>;
}

/** A fake Admin Firestore for `GET /organizations`. */
function fakeListDb(memberships: Array<{orgId: string; role: string}>) {
  const docs = memberships.map((m) => ({
    data: () => ({
      userId: "U-1",
      organizationId: m.orgId,
      role: m.role,
      status: "active",
      createdAt: Timestamp.now(),
    }),
    ref: {parent: {parent: {id: m.orgId}}},
  }));
  const query: FakeQuery = {
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    get: vi.fn(async () => ({empty: docs.length === 0, docs})),
  };
  const db = {
    collectionGroup: vi.fn(() => query),
    getAll: vi.fn(async (...refs: Array<{id: string}>) => refs.map((ref) => ({
      exists: true,
      id: ref.id,
      data: () => ({
        id: ref.id,
        name: "Test Canteen",
        slug: `slug-${ref.id}`,
        createdAt: Timestamp.now(),
        createdBy: "U-owner",
      }),
    }))),
  };
  return {db: db as unknown as Firestore};
}

function routeFor(method: string, db: Firestore, validator: SessionValidator) {
  const routes = createOrganizationRoutes({db, validator});
  const route = routes.find((r) => r.method === method && r.path === "/organizations");
  if (!route) throw new Error(`${method} /organizations route not registered`);
  return route.handler;
}

describe("POST /organizations", () => {
  it("creates the organization and returns 201 with the organization and membership", async () => {
    const {db, orgAutoId} = fakeCreateDb();
    const handler = routeFor("POST", db, acceptingValidator("U-1"));

    const result = await handler({
      request: request({body: {name: "Test Canteen", slug: "test-canteen"}}),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.status).toBe(201);
      expect(result.data).toMatchObject({
        organization: {id: orgAutoId, name: "Test Canteen", slug: "test-canteen", createdBy: "U-1"},
        membership: {userId: "U-1", organizationId: orgAutoId, role: "owner", status: "active"},
      });
      expect(typeof (result.data as {organization: {createdAt: string}}).organization.createdAt).toBe("string");
    }
  });

  it("maps a rejected session to 401 with WWW-Authenticate: Bearer", async () => {
    const {db} = fakeCreateDb();
    const handler = routeFor("POST", db, rejectingValidator());

    const result = await handler({
      request: request({body: {name: "Test Canteen", slug: "test-canteen"}}),
    });

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure to 503", async () => {
    const {db} = fakeCreateDb();
    const handler = routeFor("POST", db, unavailableValidator());

    const result = await handler({
      request: request({body: {name: "Test Canteen", slug: "test-canteen"}}),
    });

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it.each([
    {name: "", slug: "test-canteen"},
    {name: "x".repeat(101), slug: "test-canteen"},
    {name: "Test Canteen", slug: "ab"},
    {name: "Test Canteen", slug: "Has-Uppercase"},
    {name: "Test Canteen", slug: "-leading-hyphen"},
    {name: "Test Canteen"},
    {slug: "test-canteen"},
    {},
    undefined,
  ])("rejects an invalid request body (%j) with 400 invalid_argument", async (body) => {
    const {db} = fakeCreateDb();
    const handler = routeFor("POST", db, acceptingValidator("U-1"));

    const result = await handler({request: request({body})});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("ignores extra authority fields and always makes the session user the owner", async () => {
    const {db} = fakeCreateDb();
    const handler = routeFor("POST", db, acceptingValidator("U-real"));

    const result = await handler({
      request: request({
        body: {
          name: "Test Canteen",
          slug: "test-canteen",
          ownerId: "U-attacker",
          userId: "U-attacker",
          createdBy: "U-attacker",
          role: "manager",
          status: "revoked",
          id: "org-attacker",
        },
      }),
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as {
        organization: {id: string; createdBy: string};
        membership: {userId: string; role: string; status: string};
      };
      expect(data.organization.createdBy).toBe("U-real");
      expect(data.organization.id).not.toBe("org-attacker");
      expect(data.membership.userId).toBe("U-real");
      expect(data.membership.role).toBe("owner");
      expect(data.membership.status).toBe("active");
    }
  });

  it("maps a slug conflict to 409 already_exists", async () => {
    const {db} = fakeCreateDb(true);
    const handler = routeFor("POST", db, acceptingValidator("U-1"));

    const result = await handler({
      request: request({body: {name: "Test Canteen", slug: "test-canteen"}}),
    });

    expect(result).toMatchObject({kind: "error", status: 409, code: "already_exists"});
  });
});

describe("GET /organizations", () => {
  it("returns 200 with the caller's organizations and roles", async () => {
    const {db} = fakeListDb([{orgId: "org-a", role: "owner"}, {orgId: "org-b", role: "manager"}]);
    const handler = routeFor("GET", db, acceptingValidator("U-1"));

    const result = await handler({request: request({method: "GET", body: undefined})});

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.status).toBe(200);
      const data = result.data as {organizations: Array<{id: string; role: string}>};
      expect(data.organizations).toHaveLength(2);
      expect(data.organizations[0]).toMatchObject({id: "org-a", role: "owner"});
      expect(data.organizations[1]).toMatchObject({id: "org-b", role: "manager"});
    }
  });

  it("returns 200 with an empty array when the caller has no organizations", async () => {
    const {db} = fakeListDb([]);
    const handler = routeFor("GET", db, acceptingValidator("U-1"));

    const result = await handler({request: request({method: "GET", body: undefined})});

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toEqual({organizations: []});
    }
  });

  it("maps a rejected session to 401", async () => {
    const {db} = fakeListDb([]);
    const handler = routeFor("GET", db, rejectingValidator());

    const result = await handler({request: request({method: "GET", body: undefined})});

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("maps an infrastructure failure to 503", async () => {
    const {db} = fakeListDb([]);
    const handler = routeFor("GET", db, unavailableValidator());

    const result = await handler({request: request({method: "GET", body: undefined})});

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });
});

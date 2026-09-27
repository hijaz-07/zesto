// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {NormalizedRequest, RouteContext} from "../http/types";
import {createOutletRoutes} from "./outlets";

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
    method: "POST",
    path: `/organizations/${ORG_ID}/outlets`,
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

interface FakeDbOptions {
  /** Undefined simulates "no membership document" (never joined this org). */
  membership?: {role: string; status: string};
  slugExists?: boolean;
  existingOutlet?: Record<string, unknown>;
  outletsSeed?: Array<Record<string, unknown>>;
}

/**
 * A fake Admin Firestore covering every call the outlet routes make: the
 * membership read `requireOrganizationRole` performs directly (not inside a
 * transaction), and the outlet/outletSlugs transaction reads/creates/updates
 * `createOutlet`/`listOutletsForOrganization`/`updateOutlet` perform.
 *
 * @param {FakeDbOptions} opts What the fake should report.
 * @return {{db: Firestore, creates: Array<{path: string, data: unknown}>, updates: Array<{path: string, data: unknown}>}}
 *   The fake and the writes it recorded.
 */
function fakeDb(opts: FakeDbOptions = {}) {
  const outletAutoId = "outlet-auto-1";
  const creates: Array<{path: string; data: unknown}> = [];
  const updates: Array<{path: string; data: unknown}> = [];

  const tx = {
    get: vi.fn(async (ref: {path: string}) => {
      if (ref.path.includes("/outletSlugs/")) {
        return {exists: opts.slugExists === true};
      }
      if (ref.path.endsWith("/outlets/outlet-1")) {
        return {exists: opts.existingOutlet !== undefined, data: () => opts.existingOutlet};
      }
      return {exists: false};
    }),
    create: vi.fn((ref: {path: string}, data: unknown) => creates.push({path: ref.path, data})),
    update: vi.fn((ref: {path: string}, data: unknown) => updates.push({path: ref.path, data})),
  };

  const orgRef = {
    collection: (name: string) => {
      if (name === "members") {
        return {
          doc: () => ({
            get: async () => ({
              exists: opts.membership !== undefined,
              data: () => opts.membership,
            }),
          }),
        };
      }
      if (name === "outlets") {
        return {
          doc: (id?: string) => ({
            id: id ?? outletAutoId,
            path: `organizations/${ORG_ID}/outlets/${id ?? outletAutoId}`,
          }),
          orderBy: () => ({
            get: async () => ({
              docs: (opts.outletsSeed ?? []).map((data) => ({id: data.id as string, data: () => data})),
            }),
          }),
        };
      }
      if (name === "outletSlugs") {
        return {doc: (slug: string) => ({path: `organizations/${ORG_ID}/outletSlugs/${slug}`})};
      }
      throw new Error(`unexpected subcollection: ${name}`);
    },
  };

  const db = {
    collection: (name: string) => {
      if (name !== "organizations") throw new Error(`unexpected collection: ${name}`);
      return {doc: () => orgRef};
    },
    runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return {db: db as unknown as Firestore, creates, updates};
}

function routeFor(method: string, path: string, db: Firestore, validator: SessionValidator) {
  const routes = createOutletRoutes({db, validator});
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} route not registered`);
  return route.handler;
}

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {request: request(), params: {organizationId: ORG_ID}, ...overrides};
}

describe("POST /organizations/:organizationId/outlets", () => {
  const handlerPath = "/organizations/:organizationId/outlets";

  it("maps a missing/rejected session to 401 with WWW-Authenticate: Bearer", async () => {
    const {db} = fakeDb();
    const handler = routeFor("POST", handlerPath, db, rejectingValidator());

    const result = await handler(ctx({request: request({body: {name: "Main Canteen", slug: "main-canteen"}})}));

    expect(result).toMatchObject({
      kind: "error", status: 401, code: "unauthenticated", headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure validating the session to 503", async () => {
    const {db} = fakeDb();
    const handler = routeFor("POST", handlerPath, db, unavailableValidator());

    const result = await handler(ctx({request: request({body: {name: "Main Canteen", slug: "main-canteen"}})}));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("denies a caller with no membership in the organization (403)", async () => {
    const {db} = fakeDb({membership: undefined});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: {name: "Main Canteen", slug: "main-canteen"}})}));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("denies staff (403) — staff can view but not create", async () => {
    const {db} = fakeDb({membership: {role: "staff", status: "active"}});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: {name: "Main Canteen", slug: "main-canteen"}})}));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager"])("allows an active %s to create an outlet (201)", async (role) => {
    const {db} = fakeDb({membership: {role, status: "active"}});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: {name: "Main Canteen", slug: "main-canteen"}})}));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.status).toBe(201);
      const data = result.data as {outlet: {name: string; slug: string; status: string; organizationId: string}};
      expect(data.outlet).toMatchObject({
        name: "Main Canteen", slug: "main-canteen", status: "active", organizationId: ORG_ID,
      });
    }
  });

  it("ignores extra authority fields in the body", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-real"));

    const result = await handler(ctx({
      request: request({
        body: {
          name: "Main Canteen",
          slug: "main-canteen",
          status: "inactive",
          id: "outlet-attacker",
          organizationId: "org-attacker",
          createdBy: "U-attacker",
        },
      }),
    }));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as {outlet: {status: string; id: string; organizationId: string; createdBy: string}};
      expect(data.outlet.status).toBe("active");
      expect(data.outlet.id).not.toBe("outlet-attacker");
      expect(data.outlet.organizationId).toBe(ORG_ID);
      expect(data.outlet.createdBy).toBe("U-real");
    }
  });

  it.each([
    {slug: "main-canteen"},
    {name: "Main Canteen"},
    {name: "", slug: "main-canteen"},
    {name: "Main Canteen", slug: "AB"},
    {name: "Main Canteen", slug: "main-canteen", location: {latitude: 999, longitude: 0}},
    undefined,
  ])("rejects an invalid request body (%j) with 400 invalid_argument", async (body) => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a slug conflict to 409 already_exists", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, slugExists: true});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: {name: "Main Canteen", slug: "main-canteen"}})}));

    expect(result).toMatchObject({kind: "error", status: 409, code: "already_exists"});
  });

  it("never leaks HttpsError detail through an unexpected status (defaults to internal)", async () => {
    const validator: SessionValidator = {
      validateSession: vi.fn(async () => {
        throw new HttpsError("internal", "boom");
      }),
    };
    const {db} = fakeDb();
    const handler = routeFor("POST", handlerPath, db, validator);

    const result = await handler(ctx({request: request({body: {name: "Main Canteen", slug: "main-canteen"}})}));

    expect(result).toMatchObject({kind: "error", status: 500, code: "internal"});
  });
});

describe("GET /organizations/:organizationId/outlets", () => {
  const handlerPath = "/organizations/:organizationId/outlets";

  function getCtx() {
    return ctx({request: request({method: "GET", body: undefined})});
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb();
    const handler = routeFor("GET", handlerPath, db, rejectingValidator());

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies a non-member (403)", async () => {
    const {db} = fakeDb({membership: undefined});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager", "staff"])("allows an active %s to list outlets (200)", async (role) => {
    const {db} = fakeDb({
      membership: {role, status: "active"},
      outletsSeed: [{
        id: "outlet-a", organizationId: ORG_ID, name: "Main Canteen", slug: "main-canteen",
        status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
        createdBy: "U-owner",
      }],
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.status).toBe(200);
      const data = result.data as {outlets: unknown[]};
      expect(data.outlets).toHaveLength(1);
    }
  });

  it("returns an empty array for an organization with no outlets", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outletsSeed: []});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toEqual({outlets: []});
    }
  });

  it("includes an inactive outlet rather than hiding it", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outletsSeed: [{
        id: "outlet-a", organizationId: ORG_ID, name: "Old Canteen", slug: "old-canteen",
        status: "inactive", createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
        createdBy: "U-owner",
      }],
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as {outlets: Array<{status: string}>};
      expect(data.outlets).toHaveLength(1);
      expect(data.outlets[0].status).toBe("inactive");
    }
  });
});

describe("PATCH /organizations/:organizationId/outlets/:outletId", () => {
  const handlerPath = "/organizations/:organizationId/outlets/:outletId";
  const existingOutlet = {
    id: "outlet-1", organizationId: ORG_ID, name: "Main Canteen", slug: "main-canteen",
    status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    createdBy: "U-owner",
  };

  function patchCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "PATCH", body: {name: "New Name"}}),
      params: {organizationId: ORG_ID, outletId: "outlet-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb({existingOutlet});
    const handler = routeFor("PATCH", handlerPath, db, rejectingValidator());

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies staff (403) — staff can view but not update", async () => {
    const {db} = fakeDb({membership: {role: "staff", status: "active"}, existingOutlet});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each(["owner", "manager"])("allows an active %s to update an outlet (200)", async (role) => {
    const {db, updates} = fakeDb({membership: {role, status: "active"}, existingOutlet});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
    expect(updates).toHaveLength(1);
    if (result.kind === "success") {
      const data = result.data as {outlet: {name: string}};
      expect(data.outlet.name).toBe("New Name");
    }
  });

  it("ignores an attempt to change slug/organizationId/createdBy/createdAt", async () => {
    const {db, updates} = fakeDb({membership: {role: "owner", status: "active"}, existingOutlet});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    await handler(patchCtx({
      request: request({
        method: "PATCH",
        body: {
          name: "New Name",
          slug: "new-slug",
          organizationId: "org-attacker",
          createdBy: "U-attacker",
          createdAt: "2020-01-01T00:00:00Z",
        },
      }),
    }));

    expect(updates[0].data).not.toHaveProperty("slug");
    expect(updates[0].data).not.toHaveProperty("organizationId");
    expect(updates[0].data).not.toHaveProperty("createdBy");
    expect(updates[0].data).not.toHaveProperty("createdAt");
  });

  it("rejects an empty body with 400 invalid_argument", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, existingOutlet});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx({request: request({method: "PATCH", body: {}})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects an invalid status with 400 invalid_argument", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, existingOutlet});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx({request: request({method: "PATCH", body: {status: "closed"}})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a nonexistent outlet to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, existingOutlet: undefined});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx());

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

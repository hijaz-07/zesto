// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {NormalizedRequest, RouteContext} from "../http/types";
import {createMenuRoutes} from "./menus";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
/** A concrete path, only ever used for the request object's own `.path` field. */
const MENU_PATH = `/organizations/${ORG_ID}/outlets/${OUTLET_ID}/menus`;
/** The registered route PATTERN (literal `:param` segments) — routes are
 * looked up by exact match against this, never against a resolved path;
 * `ctx.params` (not `ctx.request.path`) is what carries the real values. */
const MENU_ROUTE_PATTERN = "/organizations/:organizationId/outlets/:outletId/menus";

// "Now" is pinned so the create schema's not-in-the-past check is
// deterministic regardless of when this suite actually runs.
const FIXED_NOW = new Date("2026-09-27T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    menuDate: "2026-09-28",
    title: "Tuesday Special Menu",
    orderingOpensAt: "2026-09-27T04:00:00Z",
    orderingClosesAt: "2026-09-27T10:00:00Z",
    pickupStartsAt: "2026-09-28T06:00:00Z",
    pickupEndsAt: "2026-09-28T10:00:00Z",
    ...overrides,
  };
}

function validOutletDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: OUTLET_ID,
    organizationId: ORG_ID,
    name: "Main Canteen",
    slug: "main-canteen",
    status: "active",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: "U-owner",
    ...overrides,
  };
}

function validMenuDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "menu-1",
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuDate: "2026-09-28",
    title: "Tuesday Special Menu",
    status: "draft",
    orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T10:00:00Z")),
    pickupStartsAt: Timestamp.fromDate(new Date("2026-09-28T06:00:00Z")),
    pickupEndsAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: "U-owner",
    ...overrides,
  };
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "POST",
    path: `${MENU_PATH}`,
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
  /** Undefined simulates "no such outlet." */
  outlet?: Record<string, unknown>;
  /** Undefined simulates "no such menu." */
  existingMenu?: Record<string, unknown>;
  menusSeed?: Array<Record<string, unknown>>;
}

/**
 * A fake Admin Firestore covering every call the menu routes make: the
 * membership read `requireOrganizationRole` performs, the outlet read
 * `getOutlet` performs, and the menus-subcollection reads/writes
 * `createMenu`/`listMenusForOutlet`/`getMenu`/`updateMenu`/`publishMenu`/
 * `archiveMenu` perform (one level deeper than `routes/outlets.test.ts`'s
 * equivalent fake, since Menu nests under Outlet).
 */
function fakeDb(opts: FakeDbOptions = {}) {
  const menuAutoId = "menu-auto-1";
  const creates: Array<{data: unknown}> = [];
  const updates: Array<{data: unknown}> = [];

  const tx = {
    get: vi.fn(async () => ({
      exists: opts.existingMenu !== undefined,
      data: () => opts.existingMenu,
    })),
    update: vi.fn((_ref: unknown, data: unknown) => {
      updates.push({data});
    }),
  };

  const menusCollection = {
    doc: (id?: string) => ({
      id: id ?? menuAutoId,
      get: async () => ({
        exists: opts.existingMenu !== undefined,
        data: () => opts.existingMenu,
      }),
      create: vi.fn(async (data: unknown) => {
        creates.push({data});
      }),
    }),
    orderBy: () => ({
      orderBy: () => ({
        get: async () => ({
          docs: (opts.menusSeed ?? []).map((data) => ({id: data.id as string, data: () => data})),
        }),
      }),
    }),
  };

  const outletRef = {
    get: async () => ({exists: opts.outlet !== undefined, data: () => opts.outlet}),
    collection: (name: string) => {
      if (name !== "menus") throw new Error(`unexpected subcollection: ${name}`);
      return menusCollection;
    },
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
        return {doc: () => outletRef};
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
  const routes = createMenuRoutes({db, validator});
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} route not registered`);
  return route.handler;
}

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {request: request(), params: {organizationId: ORG_ID, outletId: OUTLET_ID}, ...overrides};
}

describe("createMenuRoutes", () => {
  it("registers exactly the 6 documented routes", () => {
    const routes = createMenuRoutes({db: {} as Firestore});
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      `GET ${MENU_ROUTE_PATTERN}`,
      `GET ${MENU_ROUTE_PATTERN}/:menuId`,
      `PATCH ${MENU_ROUTE_PATTERN}/:menuId`,
      `POST ${MENU_ROUTE_PATTERN}`,
      `POST ${MENU_ROUTE_PATTERN}/:menuId/archive`,
      `POST ${MENU_ROUTE_PATTERN}/:menuId/publish`,
    ].sort());
  });
});

describe(`POST ${MENU_PATH}`, () => {
  const handlerPath = MENU_ROUTE_PATTERN;

  it("maps a missing/rejected session to 401 with WWW-Authenticate: Bearer", async () => {
    const {db} = fakeDb();
    const handler = routeFor("POST", handlerPath, db, rejectingValidator());

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({
      kind: "error", status: 401, code: "unauthenticated", headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure validating the session to 503", async () => {
    const {db} = fakeDb();
    const handler = routeFor("POST", handlerPath, db, unavailableValidator());

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("denies a caller with no membership in the organization (403)", async () => {
    const {db} = fakeDb({membership: undefined});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("denies staff (403) — staff can view but not create", async () => {
    const {db} = fakeDb({membership: {role: "staff", status: "active"}, outlet: validOutletDoc()});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("checks authorization before the outlet, and before the body", async () => {
    // No outlet seeded at all; a non-member must still get 403, not a 404
    // about the missing outlet or a 400 about the body.
    const {db} = fakeDb({membership: undefined, outlet: undefined});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: {}})}));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("maps a nonexistent outlet to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: undefined});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("maps an inactive outlet to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["owner", "manager"])("allows an active %s to create a menu (201, status draft)", async (role) => {
    const {db} = fakeDb({membership: {role, status: "active"}, outlet: validOutletDoc()});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.status).toBe(201);
      const data = result.data as {menu: {status: string; organizationId: string; outletId: string}};
      expect(data.menu).toMatchObject({status: "draft", organizationId: ORG_ID, outletId: OUTLET_ID});
    }
  });

  it("ignores extra authority fields in the body", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc()});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-real"));

    const result = await handler(ctx({
      request: request({body: validCreateBody({
        status: "published",
        id: "menu-attacker",
        organizationId: "org-attacker",
        outletId: "outlet-attacker",
        createdBy: "U-attacker",
      })}),
    }));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as {menu: {status: string; organizationId: string; outletId: string; createdBy: string}};
      expect(data.menu.status).toBe("draft");
      expect(data.menu.organizationId).toBe(ORG_ID);
      expect(data.menu.outletId).toBe(OUTLET_ID);
      expect(data.menu.createdBy).toBe("U-real");
    }
  });

  it.each([
    {menuDate: "2026-02-30"},
    {menuDate: "2026-09-26"},
    undefined,
  ])("rejects an invalid request body (%j) with 400 invalid_argument", async (overrides) => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc()});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const body = overrides === undefined ? undefined : validCreateBody(overrides);
    const result = await handler(ctx({request: request({body})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });
});

describe(`GET ${MENU_PATH}`, () => {
  const handlerPath = MENU_ROUTE_PATTERN;

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

  it("maps a nonexistent outlet to 404", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: undefined});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("allows listing menus for an INACTIVE outlet", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      menusSeed: [validMenuDoc()],
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it.each(["owner", "manager", "staff"])("allows an active %s to list menus (200)", async (role) => {
    const {db} = fakeDb({
      membership: {role, status: "active"},
      outlet: validOutletDoc(),
      menusSeed: [validMenuDoc()],
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as {menus: unknown[]};
      expect(data.menus).toHaveLength(1);
    }
  });

  it("returns an empty array for an outlet with no menus", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menusSeed: []});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind === "success") {
      expect(result.data).toEqual({menus: []});
    }
  });
});

describe(`GET ${MENU_PATH}/:menuId`, () => {
  const handlerPath = `${MENU_ROUTE_PATTERN}/:menuId`;

  function getCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "GET", body: undefined}),
      params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: "menu-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb();
    const handler = routeFor("GET", handlerPath, db, rejectingValidator());

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("allows staff to view a single menu, even for an inactive outlet", async () => {
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      existingMenu: validMenuDoc(),
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("maps a nonexistent menu to 404", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), existingMenu: undefined});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe(`PATCH ${MENU_PATH}/:menuId`, () => {
  const handlerPath = `${MENU_ROUTE_PATTERN}/:menuId`;

  function patchCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "PATCH", body: {title: "New Title"}}),
      params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: "menu-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb({outlet: validOutletDoc(), existingMenu: validMenuDoc()});
    const handler = routeFor("PATCH", handlerPath, db, rejectingValidator());

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies staff (403) — staff can view but not update", async () => {
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("maps an inactive outlet to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      existingMenu: validMenuDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["owner", "manager"])("allows an active %s to update a menu (200)", async (role) => {
    const {db, updates} = fakeDb({
      membership: {role, status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
    expect(updates).toHaveLength(1);
  });

  it("rejects an empty body with 400 invalid_argument", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc()});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx({request: request({method: "PATCH", body: {}})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps an archived menu to 400 invalid_argument (via failed-precondition)", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      existingMenu: validMenuDoc({status: "archived"}),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a nonexistent menu to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), existingMenu: undefined});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe(`POST ${MENU_PATH}/:menuId/publish`, () => {
  const handlerPath = `${MENU_ROUTE_PATTERN}/:menuId/publish`;

  function publishCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "POST", body: undefined}),
      params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: "menu-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb({outlet: validOutletDoc(), existingMenu: validMenuDoc()});
    const handler = routeFor("POST", handlerPath, db, rejectingValidator());

    expect(await handler(publishCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies staff (403)", async () => {
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc(),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(publishCtx())).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("maps an inactive outlet to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      existingMenu: validMenuDoc(),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(publishCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["owner", "manager"])("allows an active %s to publish a draft menu (200)", async (role) => {
    const {db, updates} = fakeDb({
      membership: {role, status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc({status: "draft"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(publishCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
    expect(updates[0].data).toMatchObject({status: "published"});
  });

  it("rejects publishing an already-published menu with 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc({status: "published"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(publishCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a nonexistent menu to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), existingMenu: undefined});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(publishCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe(`POST ${MENU_PATH}/:menuId/archive`, () => {
  const handlerPath = `${MENU_ROUTE_PATTERN}/:menuId/archive`;

  function archiveCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "POST", body: undefined}),
      params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: "menu-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb({outlet: validOutletDoc(), existingMenu: validMenuDoc({status: "published"})});
    const handler = routeFor("POST", handlerPath, db, rejectingValidator());

    expect(await handler(archiveCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies staff (403)", async () => {
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc({status: "published"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(archiveCtx())).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("allows archiving even when the outlet is INACTIVE", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      existingMenu: validMenuDoc({status: "published"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(archiveCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it.each(["owner", "manager"])("allows an active %s to archive a published menu (200)", async (role) => {
    const {db, updates} = fakeDb({
      membership: {role, status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc({status: "published"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(archiveCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
    expect(updates[0].data).toMatchObject({status: "archived"});
  });

  it("rejects archiving a draft menu with 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), existingMenu: validMenuDoc({status: "draft"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(archiveCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a nonexistent menu to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), existingMenu: undefined});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(archiveCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

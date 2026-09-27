// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {NormalizedRequest, RouteContext} from "../http/types";
import {createMenuItemRoutes} from "./menuItems";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
const MENU_ID = "menu-1";
/** A concrete path, only ever used for the request object's own `.path` field. */
const ITEM_PATH = `/organizations/${ORG_ID}/outlets/${OUTLET_ID}/menus/${MENU_ID}/items`;
/** The registered route PATTERN (literal `:param` segments) — routes are
 * looked up by exact match against this, never against a resolved path;
 * `ctx.params` (not `ctx.request.path`) is what carries the real values. */
const ITEM_ROUTE_PATTERN =
  "/organizations/:organizationId/outlets/:outletId/menus/:menuId/items";

// "Now" is pinned so the ordering-window gate (`findItemMutationViolation`/
// `findItemDeletionViolation`, both defaulting to `new Date()`) is
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
    name: "Chicken Biriyani",
    description: "Aromatic chicken biriyani",
    priceInPaise: 12000,
    displayOrder: 1,
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

/** `orderingClosesAt` defaults to after `FIXED_NOW` — i.e. "ordering still
 * open" — so a bare `validMenuDoc()` is always a safe default fixture;
 * individual tests override it to exercise the closed-ordering gate. */
function validMenuDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: MENU_ID,
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuDate: "2026-09-28",
    title: "Tuesday Special Menu",
    status: "draft",
    orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T13:00:00Z")),
    pickupStartsAt: Timestamp.fromDate(new Date("2026-09-28T06:00:00Z")),
    pickupEndsAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: "U-owner",
    ...overrides,
  };
}

function validItemDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    menuId: MENU_ID,
    name: "Chicken Biriyani",
    priceInPaise: 12000,
    enabled: true,
    displayOrder: 1,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: "U-owner",
    ...overrides,
  };
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "POST",
    path: `${ITEM_PATH}`,
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
  menu?: Record<string, unknown>;
  /** Undefined simulates "no such item." */
  existingItem?: Record<string, unknown>;
  itemsSeed?: Array<Record<string, unknown>>;
}

/**
 * A fake Admin Firestore covering every call the menu item routes make: the
 * membership read `requireOrganizationRole` performs, the outlet read
 * `getOutlet` performs, the (non-transactional) menu read `getMenu`
 * performs, and the items-subcollection reads/writes `createMenuItem`/
 * `listMenuItemsForMenu`/`getMenuItem`/`updateMenuItem`/`deleteMenuItem`
 * perform — one level deeper than `routes/menus.test.ts`'s equivalent fake,
 * since Item nests under Menu under Outlet.
 */
function fakeDb(opts: FakeDbOptions = {}) {
  const itemAutoId = "item-auto-1";
  const creates: Array<{data: unknown}> = [];
  const updates: Array<{data: unknown}> = [];
  const deletes: Array<true> = [];

  const tx = {
    get: vi.fn(async () => ({
      exists: opts.existingItem !== undefined,
      data: () => opts.existingItem,
    })),
    update: vi.fn((_ref: unknown, data: unknown) => {
      updates.push({data});
    }),
  };

  const itemsCollection = {
    doc: (id?: string) => ({
      id: id ?? itemAutoId,
      get: async () => ({
        exists: opts.existingItem !== undefined,
        data: () => opts.existingItem,
      }),
      create: vi.fn(async (data: unknown) => {
        creates.push({data});
      }),
      delete: vi.fn(async () => {
        deletes.push(true);
      }),
    }),
    orderBy: () => ({
      orderBy: () => ({
        get: async () => ({
          docs: (opts.itemsSeed ?? []).map((data) => ({id: data.id as string, data: () => data})),
        }),
      }),
    }),
  };

  const menuRef = {
    get: async () => ({exists: opts.menu !== undefined, data: () => opts.menu}),
    collection: (name: string) => {
      if (name !== "items") throw new Error(`unexpected subcollection: ${name}`);
      return itemsCollection;
    },
  };

  const outletRef = {
    get: async () => ({exists: opts.outlet !== undefined, data: () => opts.outlet}),
    collection: (name: string) => {
      if (name !== "menus") throw new Error(`unexpected subcollection: ${name}`);
      return {doc: () => menuRef};
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

  return {db: db as unknown as Firestore, creates, updates, deletes};
}

function routeFor(method: string, path: string, db: Firestore, validator: SessionValidator) {
  const routes = createMenuItemRoutes({db, validator});
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} route not registered`);
  return route.handler;
}

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    request: request(),
    params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: MENU_ID},
    ...overrides,
  };
}

describe("createMenuItemRoutes", () => {
  it("registers exactly the 5 documented routes", () => {
    const routes = createMenuItemRoutes({db: {} as Firestore});
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      `DELETE ${ITEM_ROUTE_PATTERN}/:itemId`,
      `GET ${ITEM_ROUTE_PATTERN}`,
      `GET ${ITEM_ROUTE_PATTERN}/:itemId`,
      `PATCH ${ITEM_ROUTE_PATTERN}/:itemId`,
      `POST ${ITEM_ROUTE_PATTERN}`,
    ].sort());
  });
});

describe(`POST ${ITEM_PATH}`, () => {
  const handlerPath = ITEM_ROUTE_PATTERN;

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
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("checks authorization before the outlet/menu, and before the body", async () => {
    const {db} = fakeDb({membership: undefined, outlet: undefined, menu: undefined});
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

  it("maps a nonexistent menu to 404 not_found", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: undefined,
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("maps an archived menu to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      menu: validMenuDoc({status: "archived"}),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a published menu whose ordering has closed to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      menu: validMenuDoc({
        status: "published",
        orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T11:00:00Z")), // before FIXED_NOW
      }),
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["owner", "manager"])("allows an active %s to create an item on a draft menu (201, enabled)", async (role) => {
    const {db} = fakeDb({membership: {role, status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc()});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.status).toBe(201);
      const data = result.data as {item: {enabled: boolean; menuId: string}};
      expect(data.item).toMatchObject({enabled: true, menuId: MENU_ID});
    }
  });

  it("allows creating on a published menu while ordering is still open", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      menu: validMenuDoc({status: "published"}), // orderingClosesAt after FIXED_NOW by default
    });
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "success", status: 201});
  });

  it("ignores extra authority fields in the body", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc()});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-real"));

    const result = await handler(ctx({
      request: request({body: validCreateBody({
        id: "item-attacker",
        menuId: "menu-attacker",
        enabled: false,
        createdBy: "U-attacker",
      })}),
    }));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as {item: {menuId: string; enabled: boolean; createdBy: string}};
      expect(data.item.menuId).toBe(MENU_ID);
      expect(data.item.enabled).toBe(true);
      expect(data.item.createdBy).toBe("U-real");
    }
  });

  it.each([
    {name: ""},
    {priceInPaise: -100},
    {priceInPaise: 12000.5},
    {displayOrder: -1},
    undefined,
  ])("rejects an invalid request body (%j) with 400 invalid_argument", async (overrides) => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc()});
    const handler = routeFor("POST", handlerPath, db, acceptingValidator("U-1"));

    const body = overrides === undefined ? undefined : validCreateBody(overrides);
    const result = await handler(ctx({request: request({body})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });
});

describe(`GET ${ITEM_PATH} (list)`, () => {
  const handlerPath = ITEM_ROUTE_PATTERN;

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

  it("maps a nonexistent menu to 404", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: undefined});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("allows listing items for an INACTIVE outlet", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      menu: validMenuDoc(),
      itemsSeed: [validItemDoc()],
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "success", status: 200});
  });

  it("allows listing items for an ARCHIVED menu (reads are never gated)", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      menu: validMenuDoc({status: "archived"}),
      itemsSeed: [validItemDoc()],
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "success", status: 200});
  });

  it.each(["owner", "manager", "staff"])("allows an active %s to list items (200)", async (role) => {
    const {db} = fakeDb({
      membership: {role, status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), itemsSeed: [validItemDoc()],
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as {items: unknown[]};
      expect(data.items).toHaveLength(1);
    }
  });

  it("returns an empty array for a menu with no items", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), itemsSeed: []});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(getCtx());

    if (result.kind === "success") {
      expect(result.data).toEqual({items: []});
    }
  });
});

describe(`GET ${ITEM_PATH}/:itemId`, () => {
  const handlerPath = `${ITEM_ROUTE_PATTERN}/:itemId`;

  function getCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "GET", body: undefined}),
      params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: MENU_ID, itemId: "item-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb();
    const handler = routeFor("GET", handlerPath, db, rejectingValidator());

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("allows staff to view a single item, even for an inactive outlet and an archived menu", async () => {
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      menu: validMenuDoc({status: "archived"}),
      existingItem: validItemDoc(),
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "success", status: 200});
  });

  it("maps a nonexistent item to 404", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: undefined,
    });
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("maps a nonexistent menu to 404", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: undefined});
    const handler = routeFor("GET", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(getCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe(`PATCH ${ITEM_PATH}/:itemId`, () => {
  const handlerPath = `${ITEM_ROUTE_PATTERN}/:itemId`;

  function patchCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "PATCH", body: {name: "New Name"}}),
      params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: MENU_ID, itemId: "item-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb({outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: validItemDoc()});
    const handler = routeFor("PATCH", handlerPath, db, rejectingValidator());

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies staff (403) — staff can view but not update", async () => {
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: validItemDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("maps an inactive outlet to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      menu: validMenuDoc(),
      existingItem: validItemDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps an archived menu to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      menu: validMenuDoc({status: "archived"}),
      existingItem: validItemDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a published menu whose ordering has closed to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      menu: validMenuDoc({
        status: "published",
        orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T11:00:00Z")), // before FIXED_NOW
      }),
      existingItem: validItemDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["owner", "manager"])("allows an active %s to update an item on a published menu while ordering is open (200)", async (role) => {
    const {db, updates} = fakeDb({
      membership: {role, status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc({status: "published"}), existingItem: validItemDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
    expect(updates).toHaveLength(1);
  });

  it("allows updating an item on a draft menu (200)", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc({status: "draft"}), existingItem: validItemDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "success", status: 200});
  });

  it("rejects an empty body with 400 invalid_argument", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: validItemDoc()});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(patchCtx({request: request({method: "PATCH", body: {}})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("maps a nonexistent item to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: undefined});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("maps a nonexistent menu to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: undefined});
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(patchCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("ignores an attempt to change id/menuId/createdBy/createdAt", async () => {
    const {db, updates} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: validItemDoc(),
    });
    const handler = routeFor("PATCH", handlerPath, db, acceptingValidator("U-1"));

    await handler(patchCtx({request: request({method: "PATCH", body: {
      name: "New Name",
      id: "item-attacker",
      menuId: "menu-attacker",
      createdBy: "U-attacker",
      createdAt: "2026-09-01T00:00:00Z",
    }})}));

    expect(updates[0].data).not.toHaveProperty("id");
    expect(updates[0].data).not.toHaveProperty("menuId");
    expect(updates[0].data).not.toHaveProperty("createdBy");
    expect(updates[0].data).not.toHaveProperty("createdAt");
  });
});

describe(`DELETE ${ITEM_PATH}/:itemId`, () => {
  const handlerPath = `${ITEM_ROUTE_PATTERN}/:itemId`;

  function deleteCtx(overrides: Partial<RouteContext> = {}) {
    return ctx({
      request: request({method: "DELETE", body: undefined}),
      params: {organizationId: ORG_ID, outletId: OUTLET_ID, menuId: MENU_ID, itemId: "item-1"},
      ...overrides,
    });
  }

  it("maps a rejected session to 401", async () => {
    const {db} = fakeDb({outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: validItemDoc()});
    const handler = routeFor("DELETE", handlerPath, db, rejectingValidator());

    expect(await handler(deleteCtx())).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies staff (403)", async () => {
    const {db} = fakeDb({
      membership: {role: "staff", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: validItemDoc(),
    });
    const handler = routeFor("DELETE", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(deleteCtx())).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("maps an inactive outlet to 400 invalid_argument", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc({status: "inactive"}),
      menu: validMenuDoc(),
      existingItem: validItemDoc(),
    });
    const handler = routeFor("DELETE", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(deleteCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects deleting an item on a PUBLISHED menu, even while ordering is still open (400)", async () => {
    const {db, deletes} = fakeDb({
      membership: {role: "owner", status: "active"},
      outlet: validOutletDoc(),
      menu: validMenuDoc({status: "published"}), // ordering still open
      existingItem: validItemDoc(),
    });
    const handler = routeFor("DELETE", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(deleteCtx());

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    expect(deletes).toHaveLength(0);
  });

  it("rejects deleting an item on an ARCHIVED menu (400)", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc({status: "archived"}), existingItem: validItemDoc(),
    });
    const handler = routeFor("DELETE", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(deleteCtx())).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["owner", "manager"])("allows an active %s to delete an item on a DRAFT menu (200)", async (role) => {
    const {db, deletes} = fakeDb({
      membership: {role, status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc({status: "draft"}), existingItem: validItemDoc(),
    });
    const handler = routeFor("DELETE", handlerPath, db, acceptingValidator("U-1"));

    const result = await handler(deleteCtx());

    expect(result).toMatchObject({kind: "success", status: 200});
    expect(deletes).toHaveLength(1);
  });

  it("maps a nonexistent item to 404 not_found", async () => {
    const {db} = fakeDb({
      membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: validMenuDoc(), existingItem: undefined,
    });
    const handler = routeFor("DELETE", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(deleteCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("maps a nonexistent menu to 404 not_found", async () => {
    const {db} = fakeDb({membership: {role: "owner", status: "active"}, outlet: validOutletDoc(), menu: undefined});
    const handler = routeFor("DELETE", handlerPath, db, acceptingValidator("U-1"));

    expect(await handler(deleteCtx())).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

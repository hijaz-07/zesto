// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {beforeAll, describe, expect, it} from "vitest";
import {
  listExploreOutlets,
  listUpcomingPublishedMenusForOutlet,
  resolveActivePublicOutlet,
} from "../domain/explore";
import {createMenuItem, updateMenuItem} from "../domain/menuItems";
import {archiveMenu, createMenu, publishMenu, type CreateMenuInput} from "../domain/menus";
import {createOrganization} from "../domain/organizations";
import {createOutlet, updateOutlet, type CreateOutletInput} from "../domain/outlets";
import {handleRequest} from "../http/handleRequest";
import type {NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createExploreRoutes} from "./explore";

/**
 * These tests exercise the public `/explore` routes against a REAL Firestore
 * emulator — proving the collection-group discovery query and its indexes
 * (declared in firestore.indexes.json), real outlet/menu/item filtering
 * across the actual `organizations/*\/outlets/*\/menus/*\/items/*` hierarchy,
 * tenant isolation, and that no `Authorization` header is ever required.
 *
 * Run via `npm run test:functions-emulator` (repo root). Org/outlet/menu/item
 * setup goes straight through the domain layer (not the management HTTP
 * routes) since authorization isn't part of what's under test here — see
 * `menus.emulator.test.ts` for the equivalent convention.
 */

const PROJECT_ID = "demo-zesto-functions-test";

let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this file via " +
      "`npm run test:functions-emulator` (from the repo root), which " +
      "starts the Firestore emulator first.",
    );
  }
  const app = getApps().length > 0 ?
    getApps()[0] :
    initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

function freshOrgInput() {
  const suffix = randomUUID();
  return {name: `Test Canteen ${suffix}`, slug: `test-canteen-${suffix}`};
}

function freshOutletInput(overrides: Partial<CreateOutletInput> = {}): CreateOutletInput {
  const suffix = randomUUID();
  return {name: `Main Canteen ${suffix}`, slug: `main-canteen-${suffix}`, ...overrides};
}

async function setupOrgWithOwner(): Promise<{organizationId: string; ownerId: string}> {
  const ownerId = `U-${randomUUID()}`;
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  return {organizationId: organization.id, ownerId};
}

async function setupOutlet(
  organizationId: string,
  ownerId: string,
  overrides: Partial<CreateOutletInput> = {},
): Promise<{outletId: string}> {
  const outlet = await createOutlet(db, organizationId, ownerId, freshOutletInput(overrides));
  return {outletId: outlet.id};
}

/** A fresh, internally-consistent create-menu body that is currently
 * ordering-OPEN relative to the real clock (opens "now", closes in 1h), with
 * `menuDate`/pickup "tomorrow" — matches `menus.emulator.test.ts`'s
 * `freshMenuInput` convention (relative to the real clock, never hardcoded,
 * so this suite never goes stale), just already `Timestamp`-typed since
 * setup goes through the domain layer directly. */
function freshMenuInput(overrides: Partial<CreateMenuInput> = {}): CreateMenuInput {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  return {
    menuDate: businessDateString(new Date(tomorrow)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 60 * 60 * 1000)),
    pickupStartsAt: Timestamp.fromDate(new Date(tomorrow)),
    pickupEndsAt: Timestamp.fromDate(new Date(tomorrow + 4 * 60 * 60 * 1000)),
    ...overrides,
  };
}

/** Overrides producing a menu that has not yet opened for ordering (opens in
 * 2h, closes in 3h), still dated "tomorrow" so `menuDate >= today` holds. */
function notYetOpenOverrides(): Partial<CreateMenuInput> {
  const now = Date.now();
  return {
    orderingOpensAt: Timestamp.fromDate(new Date(now + 2 * 60 * 60 * 1000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 3 * 60 * 60 * 1000)),
  };
}

/** Overrides producing a menu dated TODAY whose ordering window already
 * closed an hour ago — still a valid, internally-consistent schedule
 * (`orderingClosesAt <= pickupStartsAt`, pickup's Kolkata date == menuDate). */
function alreadyClosedOverrides(): Partial<CreateMenuInput> {
  const now = Date.now();
  return {
    menuDate: businessDateString(new Date(now)),
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 60 * 60 * 1000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now - 60 * 60 * 1000)),
    pickupStartsAt: Timestamp.fromDate(new Date(now)),
    pickupEndsAt: Timestamp.fromDate(new Date(now + 60 * 60 * 1000)),
  };
}

async function setupPublishedMenu(
  organizationId: string,
  outletId: string,
  ownerId: string,
  overrides: Partial<CreateMenuInput> = {},
): Promise<{menuId: string; itemId: string}> {
  const menu = await createMenu(db, organizationId, outletId, ownerId, freshMenuInput(overrides));
  const item = await createMenuItem(db, organizationId, outletId, menu.id, ownerId, {
    name: "Chicken Biriyani", priceInPaise: 12000, displayOrder: 1,
  });
  await publishMenu(db, organizationId, outletId, menu.id);
  return {menuId: menu.id, itemId: item.id};
}

async function setupDraftMenu(
  organizationId: string,
  outletId: string,
  ownerId: string,
): Promise<{menuId: string}> {
  const menu = await createMenu(db, organizationId, outletId, ownerId, freshMenuInput());
  return {menuId: menu.id};
}

async function setupArchivedMenu(
  organizationId: string,
  outletId: string,
  ownerId: string,
): Promise<{menuId: string}> {
  const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId);
  await archiveMenu(db, organizationId, outletId, menuId);
  return {menuId};
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "GET",
    path: "/explore/outlets",
    headers: {},
    query: {},
    body: undefined,
    ...overrides,
  };
}

async function callExploreOutlets() {
  const routes = createExploreRoutes({db});
  return handleRequest(routes, request({headers: {}}), () => {});
}

async function callOutletExplorePage(outletId: string, headers: Record<string, string> = {}) {
  const routes = createExploreRoutes({db});
  return handleRequest(
    routes,
    request({path: `/explore/outlets/${outletId}`, headers}),
    () => {},
  );
}

async function callCustomerMenuDetail(
  outletId: string, menuId: string, headers: Record<string, string> = {},
) {
  const routes = createExploreRoutes({db});
  return handleRequest(
    routes,
    request({path: `/explore/outlets/${outletId}/menus/${menuId}`, headers}),
    () => {},
  );
}

describe("Public access (no auth required, Firestore emulator)", () => {
  it("GET /explore/outlets works with no Authorization header", async () => {
    const result = await callExploreOutlets();
    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("GET /explore/outlets/:outletId works with no Authorization header", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callOutletExplorePage(outletId, {});

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("GET .../menus/:menuId works with no Authorization header", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId);

    const result = await callCustomerMenuDetail(outletId, menuId, {});

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("a valid authenticated customer session works identically (auth is ignored, not required)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId);
    const headers = {authorization: "Bearer some-token-that-is-never-validated"};

    expect(await callExploreOutlets()).toMatchObject({kind: "success", status: 200});
    expect(await callOutletExplorePage(outletId, headers)).toMatchObject({kind: "success", status: 200});
    expect(await callCustomerMenuDetail(outletId, menuId, headers))
      .toMatchObject({kind: "success", status: 200});
  });

  it("organization membership is never required, even for a total stranger", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    // No membership document of any kind exists for this caller; the public
    // routes never look at `organizations/*/members/*` at all.
    const result = await callOutletExplorePage(outletId);
    expect(result).toMatchObject({kind: "success", status: 200});
  });
});

describe("GET /explore/outlets — outlet filtering (Firestore emulator)", () => {
  it("an active outlet with a qualifying menu appears", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, outletId, ownerId);

    const result = await callExploreOutlets();

    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).toContain(outletId);
  });

  it("an inactive outlet never appears, even with a qualifying menu", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, outletId, ownerId);
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).not.toContain(outletId);
  });

  it("an active outlet with no menus at all does not appear", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).not.toContain(outletId);
  });

  it("an active outlet with only a draft menu does not appear", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupDraftMenu(organizationId, outletId, ownerId);

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).not.toContain(outletId);
  });

  it("an active outlet with only an archived menu does not appear", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupArchivedMenu(organizationId, outletId, ownerId);

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).not.toContain(outletId);
  });
});

describe("GET /explore/outlets — menu filtering (Firestore emulator)", () => {
  it("a published future menu appears", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, outletId, ownerId);

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).toContain(outletId);
  });

  it("a published menu before ordering opens still appears, with orderingState not_open", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, outletId, ownerId, notYetOpenOverrides());

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string; nextMenu: {orderingState: string}}>};
    const entry = outlets.find((o) => o.id === outletId);
    expect(entry?.nextMenu.orderingState).toBe("not_open");
  });

  it("a currently-open published menu appears, with orderingState open", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, outletId, ownerId);

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string; nextMenu: {orderingState: string}}>};
    const entry = outlets.find((o) => o.id === outletId);
    expect(entry?.nextMenu.orderingState).toBe("open");
  });

  it("a published menu whose ordering has already closed is excluded from the default feed", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, outletId, ownerId, alreadyClosedOverrides());

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).not.toContain(outletId);
  });

  it("a draft menu is excluded", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupDraftMenu(organizationId, outletId, ownerId);

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).not.toContain(outletId);
  });

  it("an archived menu is excluded", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    await setupArchivedMenu(organizationId, outletId, ownerId);

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    expect(outlets.map((o) => o.id)).not.toContain(outletId);
  });
});

describe("GET /explore/outlets/:outletId/menus/:menuId — detail endpoint (Firestore emulator)", () => {
  it("a published, currently-open menu is readable", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId);

    const result = await callCustomerMenuDetail(outletId, menuId);

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {orderingState: string}};
    expect(menu.orderingState).toBe("open");
  });

  it("a published, not-yet-open menu is readable", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId, notYetOpenOverrides());

    const result = await callCustomerMenuDetail(outletId, menuId);

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {orderingState: string}};
    expect(menu.orderingState).toBe("not_open");
  });

  it("a published, already-closed menu is still readable read-only by its known direct URL", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId, alreadyClosedOverrides());

    const result = await callCustomerMenuDetail(outletId, menuId);

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {orderingState: string}};
    expect(menu.orderingState).toBe("closed");
  });

  it("a draft menu returns 404", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupDraftMenu(organizationId, outletId, ownerId);

    const result = await callCustomerMenuDetail(outletId, menuId);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("an archived menu returns 404", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupArchivedMenu(organizationId, outletId, ownerId);

    const result = await callCustomerMenuDetail(outletId, menuId);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("an inactive outlet's menu returns 404, even though the menu itself is published", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId);
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callCustomerMenuDetail(outletId, menuId);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a menu ID belonging to a different outlet returns 404 (never cross-tenant)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const outletA = await setupOutlet(organizationId, ownerId);
    const outletB = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletB.outletId, ownerId);

    const result = await callCustomerMenuDetail(outletA.outletId, menuId);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a missing outlet returns 404", async () => {
    const result = await callCustomerMenuDetail("no-such-outlet", "no-such-menu");
    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a missing menu under a real, active outlet returns 404", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callCustomerMenuDetail(outletId, "no-such-menu");

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe("Item filtering (Firestore emulator)", () => {
  it("enabled items are returned, ordered by displayOrder then createdAt", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId, itemId: firstItemId} = await setupPublishedMenu(organizationId, outletId, ownerId);
    const secondItem = await createMenuItem(db, organizationId, outletId, menuId, ownerId, {
      name: "Fried Rice", priceInPaise: 9000, displayOrder: 1,
    });

    const result = await callCustomerMenuDetail(outletId, menuId);

    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {items: Array<{id: string}>}};
    expect(menu.items.map((i) => i.id)).toEqual([firstItemId, secondItem.id]);
  });

  it("disabled items are omitted completely, not returned with enabled: false", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId, itemId} = await setupPublishedMenu(organizationId, outletId, ownerId);
    const disabledItem = await createMenuItem(db, organizationId, outletId, menuId, ownerId, {
      name: "Veg Meals (retired)", priceInPaise: 8000, displayOrder: 2,
    });
    await updateMenuItem(db, organizationId, outletId, menuId, disabledItem.id, {enabled: false});

    const result = await callCustomerMenuDetail(outletId, menuId);

    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {items: Array<Record<string, unknown>>}};
    expect(menu.items.map((i) => i.id)).toEqual([itemId]);
    for (const item of menu.items) {
      expect(item).not.toHaveProperty("enabled");
    }
  });
});

describe("Data privacy and price (Firestore emulator)", () => {
  it("the outlet, menu, and item never expose createdBy, organizationId, or internal audit fields", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId, {
      description: "Main campus food outlet",
      phone: "0499xxxxxxx",
      address: {line1: "Main Campus", city: "Kasaragod", state: "Kerala", postalCode: "671xxx"},
    });
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId);

    const result = await callCustomerMenuDetail(outletId, menuId);

    if (result.kind !== "success") throw new Error("expected success");
    const {outlet, menu} = result.data as {
      outlet: Record<string, unknown>;
      menu: Record<string, unknown> & {items: Array<Record<string, unknown>>};
    };

    for (const forbidden of [
      "createdBy", "organizationId", "createdAt", "updatedAt", "slug", "status", "phone",
    ]) {
      expect(outlet).not.toHaveProperty(forbidden);
    }
    expect(outlet.address).toEqual({city: "Kasaragod", state: "Kerala"});

    for (const forbidden of [
      "createdBy", "organizationId", "outletId", "status", "createdAt", "updatedAt", "publishedAt",
    ]) {
      expect(menu).not.toHaveProperty(forbidden);
    }

    for (const item of menu.items) {
      for (const forbidden of ["createdBy", "menuId", "enabled", "createdAt", "updatedAt"]) {
        expect(item).not.toHaveProperty(forbidden);
      }
      expect(item).not.toHaveProperty("stock");
      expect(item).not.toHaveProperty("inventory");
      expect(item).not.toHaveProperty("remainingQuantity");
    }
  });

  it("keeps priceInPaise as an integer", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletId, ownerId);
    await createMenuItem(db, organizationId, outletId, menuId, ownerId, {
      name: "Egg Curry", priceInPaise: 9950, displayOrder: 2,
    });

    const result = await callCustomerMenuDetail(outletId, menuId);

    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {items: Array<{priceInPaise: number}>}};
    for (const item of menu.items) {
      expect(Number.isInteger(item.priceInPaise)).toBe(true);
    }
  });
});

describe("Discovery: dedup, ordering, and bounding (Firestore emulator)", () => {
  it("two qualifying menus on the same outlet produce only one outlet summary, keyed by the earliest menu", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const now = Date.now();
    const tomorrow = now + 24 * 60 * 60 * 1000;
    const dayAfter = now + 48 * 60 * 60 * 1000;
    const earlier = await setupPublishedMenu(organizationId, outletId, ownerId, {
      menuDate: businessDateString(new Date(tomorrow)),
    });
    await setupPublishedMenu(organizationId, outletId, ownerId, {
      menuDate: businessDateString(new Date(dayAfter)),
      pickupStartsAt: Timestamp.fromDate(new Date(dayAfter)),
      pickupEndsAt: Timestamp.fromDate(new Date(dayAfter + 4 * 60 * 60 * 1000)),
    });

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string; nextMenu: {id: string}}>};
    const matches = outlets.filter((o) => o.id === outletId);
    expect(matches).toHaveLength(1);
    expect(matches[0].nextMenu.id).toBe(earlier.menuId);
  });

  it("orders outlets by their next menu's menuDate ascending", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const now = Date.now();
    const tomorrow = now + 24 * 60 * 60 * 1000;
    const dayAfter = now + 48 * 60 * 60 * 1000;
    const later = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, later.outletId, ownerId, {
      menuDate: businessDateString(new Date(dayAfter)),
      pickupStartsAt: Timestamp.fromDate(new Date(dayAfter)),
      pickupEndsAt: Timestamp.fromDate(new Date(dayAfter + 4 * 60 * 60 * 1000)),
    });
    const earlier = await setupOutlet(organizationId, ownerId);
    await setupPublishedMenu(organizationId, earlier.outletId, ownerId, {
      menuDate: businessDateString(new Date(tomorrow)),
    });

    const result = await callExploreOutlets();

    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string}>};
    const ids = outlets.map((o) => o.id);
    expect(ids.indexOf(earlier.outletId)).toBeLessThan(ids.indexOf(later.outletId));
  });

  it("the candidate query is bounded: an outlet result limit is enforced, not an unbounded scan", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const outletIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const {outletId} = await setupOutlet(organizationId, ownerId);
      await setupPublishedMenu(organizationId, outletId, ownerId);
      outletIds.push(outletId);
    }

    const entries = await listExploreOutlets(db, new Date(), {outletResultLimit: 2});

    const matches = entries.filter((e) => outletIds.includes(e.outlet.id));
    expect(entries.length).toBeLessThanOrEqual(2);
    expect(matches.length).toBeLessThanOrEqual(2);
  }, 15000);
});

describe("Tenant isolation (Firestore emulator)", () => {
  it("a menu from Organization B's outlet can never be read through Organization A's outlet ID", async () => {
    const orgA = await setupOrgWithOwner();
    const orgB = await setupOrgWithOwner();
    const outletA = await setupOutlet(orgA.organizationId, orgA.ownerId);
    const outletB = await setupOutlet(orgB.organizationId, orgB.ownerId);
    const {menuId} = await setupPublishedMenu(orgB.organizationId, outletB.outletId, orgB.ownerId);

    const result = await callCustomerMenuDetail(outletA.outletId, menuId);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("mismatched outlet/menu IDs return 404", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const outletA = await setupOutlet(organizationId, ownerId);
    const outletB = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupPublishedMenu(organizationId, outletB.outletId, ownerId);

    const result = await callCustomerMenuDetail(outletA.outletId, menuId);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe("Domain-level Asia/Kolkata boundary behavior (Firestore emulator)", () => {
  it("uses the Kolkata calendar date, not UTC, to decide whether a menu still qualifies", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    // 2026-09-27T18:30:00Z is exactly IST midnight rolling into 2026-09-28
    // (see time.test.ts): Kolkata "today" is 2026-09-28, while the UTC
    // calendar date is still 2026-09-27.
    const now = new Date("2026-09-27T18:30:00Z");
    // A menu dated 2026-09-27 is therefore already YESTERDAY in Kolkata —
    // it must be excluded — but would incorrectly still qualify
    // (menuDate >= today) if the cutoff used the UTC date instead.
    await createMenu(db, organizationId, outletId, ownerId, {
      menuDate: "2026-09-27",
      title: "Yesterday-in-Kolkata Menu",
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T00:00:00Z")),
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T12:00:00Z")),
      pickupStartsAt: Timestamp.fromDate(new Date("2026-09-27T13:00:00Z")),
      pickupEndsAt: Timestamp.fromDate(new Date("2026-09-27T17:00:00Z")),
    }).then((menu) =>
      createMenuItem(db, organizationId, outletId, menu.id, ownerId, {
        name: "Test Item", priceInPaise: 5000, displayOrder: 1,
      }).then(() => publishMenu(db, organizationId, outletId, menu.id)));

    const feedEntries = await listExploreOutlets(db, now);
    expect(feedEntries.map((e) => e.outlet.id)).not.toContain(outletId);

    const outlet = await resolveActivePublicOutlet(db, outletId);
    const outletMenus = await listUpcomingPublishedMenusForOutlet(db, outlet, now);
    expect(outletMenus).toEqual([]);
  });

  it("a menu dated exactly the Kolkata 'today' still qualifies at that same instant", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const now = new Date("2026-09-27T18:30:00Z"); // Kolkata "today" = 2026-09-28.
    const menu = await createMenu(db, organizationId, outletId, ownerId, {
      menuDate: "2026-09-28",
      title: "Kolkata-today Menu",
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T19:00:00Z")),
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T20:00:00Z")),
      pickupStartsAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
      pickupEndsAt: Timestamp.fromDate(new Date("2026-09-28T12:00:00Z")),
    });
    await createMenuItem(db, organizationId, outletId, menu.id, ownerId, {
      name: "Test Item", priceInPaise: 5000, displayOrder: 1,
    });
    await publishMenu(db, organizationId, outletId, menu.id);

    const feedEntries = await listExploreOutlets(db, now);
    expect(feedEntries.map((e) => e.outlet.id)).toContain(outletId);
  });
});

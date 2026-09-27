// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {archiveMenu, createMenu, publishMenu} from "../domain/menus";
import {createOrganization} from "../domain/organizations";
import {createOutlet, updateOutlet} from "../domain/outlets";
import {handleRequest} from "../http/handleRequest";
import type {NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createMenuItemRoutes} from "./menuItems";

/**
 * These tests exercise the menu item routes against a REAL Firestore
 * emulator — the same reason `menus.emulator.test.ts` exists: to prove real
 * transaction/read-then-write semantics (update), the full owner/manager/
 * staff/non-member authorization matrix against real membership documents,
 * tenant isolation (including cross-menu access within the same
 * organization), the real 2-field `displayOrder`+`createdAt` ordering
 * (which exercises the composite index declared in firestore.indexes.json),
 * read-back fidelity, and concurrency. Descope stays faked. The parent
 * organization/outlet/menu chain is set up directly via their own domain
 * functions (already proven by their own emulator suites), not via HTTP.
 *
 * Run via `npm run test:functions-emulator` (repo root).
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

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

function freshOrgInput() {
  const suffix = randomUUID();
  return {name: `Test Canteen ${suffix}`, slug: `test-canteen-${suffix}`};
}

function freshOutletInput() {
  const suffix = randomUUID();
  return {name: `Main Canteen ${suffix}`, slug: `main-canteen-${suffix}`};
}

/** A fresh, internally-consistent create-item body. */
function freshItemInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `Test Item ${randomUUID()}`,
    description: "A freshly prepared test item.",
    priceInPaise: 12000,
    displayOrder: 1,
    ...overrides,
  };
}

async function setupOrgWithOwner(): Promise<{organizationId: string; ownerId: string}> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  return {organizationId: organization.id, ownerId};
}

async function setupOutlet(
  organizationId: string,
  ownerId: string,
): Promise<{outletId: string}> {
  const outlet = await createOutlet(db, organizationId, ownerId, freshOutletInput());
  return {outletId: outlet.id};
}

async function setupInactiveOutlet(
  organizationId: string,
  ownerId: string,
): Promise<{outletId: string}> {
  const {outletId} = await setupOutlet(organizationId, ownerId);
  await updateOutlet(db, organizationId, outletId, {status: "inactive"});
  return {outletId};
}

interface SetupMenuOptions {
  /** Defaults to 1 hour from now — i.e. ordering still open. */
  orderingClosesAt?: Date;
}

/** Creates a real, valid DRAFT menu directly via the Menu domain layer
 * (bypassing its own Zod schema/route, exactly like `createOutlet`/
 * `createOrganization` are used as ancestor fixtures elsewhere) so this
 * suite can freely construct a menu whose `orderingClosesAt` is already in
 * the past, which `createMenuBodySchema` itself would never accept from a
 * real request body. */
async function setupMenu(
  organizationId: string,
  outletId: string,
  ownerId: string,
  options: SetupMenuOptions = {},
): Promise<{menuId: string}> {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  const orderingClosesAt = options.orderingClosesAt ?? new Date(now + 60 * 60 * 1000);
  const menu = await createMenu(db, organizationId, outletId, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 60 * 60 * 1000)),
    orderingClosesAt: Timestamp.fromDate(orderingClosesAt),
    pickupStartsAt: Timestamp.fromDate(new Date(tomorrow)),
    pickupEndsAt: Timestamp.fromDate(new Date(tomorrow + 4 * 60 * 60 * 1000)),
  });
  return {menuId: menu.id};
}

async function addMembership(
  organizationId: string,
  userId: string,
  role: string,
  status = "active",
): Promise<void> {
  await db
    .collection("organizations").doc(organizationId)
    .collection("members").doc(userId)
    .set({userId, organizationId, role, status, createdAt: new Date()});
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({
      jwt: "irrelevant",
      token: {sub: userId, aud: ["P-test"]},
    })),
  };
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "GET",
    path: "/",
    headers: {authorization: "Bearer token"},
    query: {},
    body: undefined,
    ...overrides,
  };
}

function itemBasePath(organizationId: string, outletId: string, menuId: string): string {
  return `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/items`;
}

async function callCreate(
  organizationId: string, outletId: string, menuId: string, validator: SessionValidator, body: unknown,
) {
  const routes = createMenuItemRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "POST", path: itemBasePath(organizationId, outletId, menuId), body}),
    () => {},
  );
}

async function callList(organizationId: string, outletId: string, menuId: string, validator: SessionValidator) {
  const routes = createMenuItemRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "GET", path: itemBasePath(organizationId, outletId, menuId)}),
    () => {},
  );
}

async function callGet(
  organizationId: string, outletId: string, menuId: string, itemId: string, validator: SessionValidator,
) {
  const routes = createMenuItemRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "GET", path: `${itemBasePath(organizationId, outletId, menuId)}/${itemId}`}),
    () => {},
  );
}

async function callPatch(
  organizationId: string, outletId: string, menuId: string, itemId: string, validator: SessionValidator, body: unknown,
) {
  const routes = createMenuItemRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "PATCH", path: `${itemBasePath(organizationId, outletId, menuId)}/${itemId}`, body}),
    () => {},
  );
}

async function callDelete(
  organizationId: string, outletId: string, menuId: string, itemId: string, validator: SessionValidator,
) {
  const routes = createMenuItemRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "DELETE", path: `${itemBasePath(organizationId, outletId, menuId)}/${itemId}`}),
    () => {},
  );
}

async function readItemDoc(organizationId: string, outletId: string, menuId: string, itemId: string) {
  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("items").doc(itemId)
    .get();
  return snapshot.data();
}

/** Org + owner + outlet + a fresh DRAFT menu + one item on it. */
async function setupItem(overrides: Record<string, unknown> = {}) {
  const {organizationId, ownerId} = await setupOrgWithOwner();
  const {outletId} = await setupOutlet(organizationId, ownerId);
  const {menuId} = await setupMenu(organizationId, outletId, ownerId);
  const created = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), freshItemInput(overrides));
  if (created.kind !== "success") throw new Error("setup failed");
  const itemId = (created.data as {item: {id: string}}).item.id;
  return {organizationId, ownerId, outletId, menuId, itemId};
}

/** Org + owner + outlet + item, created while the menu is still a DRAFT
 * (the only state that always allows creation), then transitions the menu
 * to `finalStatus` — since neither an archived nor an ordering-closed
 * published menu would ever allow the item to be created in the first
 * place. */
async function setupItemThenTransitionMenu(
  finalStatus: "published" | "archived",
  menuOptions: SetupMenuOptions = {},
) {
  const {organizationId, ownerId} = await setupOrgWithOwner();
  const {outletId} = await setupOutlet(organizationId, ownerId);
  const {menuId} = await setupMenu(organizationId, outletId, ownerId, menuOptions);
  const created = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), freshItemInput());
  if (created.kind !== "success") throw new Error("setup failed");
  const itemId = (created.data as {item: {id: string}}).item.id;

  await publishMenu(db, organizationId, outletId, menuId);
  if (finalStatus === "archived") {
    await archiveMenu(db, organizationId, outletId, menuId);
  }

  return {organizationId, ownerId, outletId, menuId, itemId};
}

describe("POST .../items (Firestore emulator)", () => {
  it("creates the item as enabled; read back from Firestore matches the request", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);
    const input = freshItemInput();

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), input);

    expect(result).toMatchObject({kind: "success", status: 201});
    if (result.kind !== "success") throw new Error("expected success");
    const {item} = result.data as {item: {id: string; enabled: boolean; createdBy: string; menuId: string}};
    expect(item.enabled).toBe(true);
    expect(item.createdBy).toBe(ownerId);
    expect(item.menuId).toBe(menuId);

    const stored = await readItemDoc(organizationId, outletId, menuId, item.id);
    expect(stored).toMatchObject({
      menuId, name: input.name, description: input.description,
      priceInPaise: input.priceInPaise, displayOrder: input.displayOrder,
      enabled: true, createdBy: ownerId,
    });
    expect(stored).not.toHaveProperty("organizationId");
    expect(stored).not.toHaveProperty("outletId");
  });

  it("denies a non-member (403)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(freshUserId()), freshItemInput());

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each([
    ["owner", true], ["manager", true], ["staff", false],
  ])("%s can create: %s", async (role, canCreate) => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);
    const memberId = freshUserId();
    await addMembership(organizationId, memberId, role);

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(memberId), freshItemInput());

    if (canCreate) {
      expect(result).toMatchObject({kind: "success", status: 201});
    } else {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });

  it("denies creation for a nonexistent outlet (404)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();

    const result = await callCreate(organizationId, "no-such-outlet", "no-such-menu", acceptingValidator(ownerId), freshItemInput());

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("denies creation for a nonexistent menu (404)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callCreate(organizationId, outletId, "no-such-menu", acceptingValidator(ownerId), freshItemInput());

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("denies creation for an inactive outlet (400)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupInactiveOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), freshItemInput());

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("denies creation for an archived menu (400)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupItemThenTransitionMenu("archived");

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), freshItemInput());

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("denies creation for a published menu whose ordering has closed (400)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupItemThenTransitionMenu(
      "published", {orderingClosesAt: new Date(Date.now() - 60 * 60 * 1000)},
    );

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), freshItemInput());

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("allows creation for a published menu while ordering is still open", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupItemThenTransitionMenu("published");

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), freshItemInput());

    expect(result).toMatchObject({kind: "success", status: 201});
  });

  it("rejects an invalid body without touching Firestore", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);

    const result = await callCreate(organizationId, outletId, menuId, acceptingValidator(ownerId), {name: "No price"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const listResult = await callList(organizationId, outletId, menuId, acceptingValidator(ownerId));
    if (listResult.kind === "success") {
      expect((listResult.data as {items: unknown[]}).items).toHaveLength(0);
    }
  });

  it("lets two concurrent creates on the same menu both succeed as distinct items", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);
    const input = freshItemInput();
    const validator = acceptingValidator(ownerId);

    const [resultA, resultB] = await Promise.all([
      callCreate(organizationId, outletId, menuId, validator, input),
      callCreate(organizationId, outletId, menuId, validator, input),
    ]);

    expect(resultA.status).toBe(201);
    expect(resultB.status).toBe(201);
    if (resultA.kind !== "success" || resultB.kind !== "success") throw new Error("expected success");
    const idA = (resultA.data as {item: {id: string}}).item.id;
    const idB = (resultB.data as {item: {id: string}}).item.id;
    expect(idA).not.toBe(idB);
  });
});

describe("GET .../items (list, Firestore emulator)", () => {
  it("orders by displayOrder ascending, then createdAt ascending (exercises the composite index)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);
    const validator = acceptingValidator(ownerId);

    // Created out of displayOrder order, on purpose.
    const later = await callCreate(organizationId, outletId, menuId, validator, freshItemInput({displayOrder: 2}));
    const earlierA = await callCreate(organizationId, outletId, menuId, validator, freshItemInput({displayOrder: 1}));
    const earlierB = await callCreate(organizationId, outletId, menuId, validator, freshItemInput({displayOrder: 1}));
    if (later.kind !== "success" || earlierA.kind !== "success" || earlierB.kind !== "success") {
      throw new Error("setup failed");
    }
    const laterId = (later.data as {item: {id: string}}).item.id;
    const earlierAId = (earlierA.data as {item: {id: string}}).item.id;
    const earlierBId = (earlierB.data as {item: {id: string}}).item.id;

    const result = await callList(organizationId, outletId, menuId, validator);

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {items} = result.data as {items: Array<{id: string; displayOrder: number}>};
    const ids = items.map((i) => i.id);
    // Both displayOrder-1 items (earlierA then earlierB) must sort before
    // the displayOrder-2 one, and earlierA before earlierB (createdAt
    // tie-breaker).
    expect(ids.indexOf(earlierAId)).toBeLessThan(ids.indexOf(earlierBId));
    expect(ids.indexOf(earlierBId)).toBeLessThan(ids.indexOf(laterId));
  });

  it("returns every item including disabled, and an empty array for a menu with none", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);
    const validator = acceptingValidator(ownerId);

    const empty = await callList(organizationId, outletId, menuId, validator);
    expect(empty).toMatchObject({kind: "success", status: 200});
    if (empty.kind === "success") expect(empty.data).toEqual({items: []});

    const created = await callCreate(organizationId, outletId, menuId, validator, freshItemInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const itemId = (created.data as {item: {id: string}}).item.id;
    await callPatch(organizationId, outletId, menuId, itemId, validator, {enabled: false});

    const afterDisable = await callList(organizationId, outletId, menuId, validator);
    if (afterDisable.kind === "success") {
      const {items} = afterDisable.data as {items: Array<{enabled: boolean}>};
      expect(items).toHaveLength(1);
      expect(items[0].enabled).toBe(false);
    }
  });

  it("allows staff to view the list, and allows listing for an inactive outlet and an archived menu", async () => {
    const {organizationId, outletId, menuId} = await setupItemThenTransitionMenu("archived");
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});
    const staffId = freshUserId();
    await addMembership(organizationId, staffId, "staff");

    const result = await callList(organizationId, outletId, menuId, acceptingValidator(staffId));

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind === "success") {
      expect((result.data as {items: unknown[]}).items).toHaveLength(1);
    }
  });

  it("denies a non-member (403)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const {menuId} = await setupMenu(organizationId, outletId, ownerId);

    const result = await callList(organizationId, outletId, menuId, acceptingValidator(freshUserId()));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });
});

describe("GET .../items/:itemId (Firestore emulator)", () => {
  it("returns the item; allows viewing for an inactive outlet and an archived menu", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItemThenTransitionMenu("archived");
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callGet(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("returns 404, not 500, for a nonexistent item", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupItem();

    const result = await callGet(organizationId, outletId, menuId, "no-such-item", acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("an item from a different menu cannot be read (404, never leaking cross-menu data)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const menuA = await setupMenu(organizationId, outletId, ownerId);
    const menuB = await setupMenu(organizationId, outletId, ownerId);
    const created = await callCreate(organizationId, outletId, menuB.menuId, acceptingValidator(ownerId), freshItemInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const itemId = (created.data as {item: {id: string}}).item.id;

    const result = await callGet(organizationId, outletId, menuA.menuId, itemId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe("PATCH .../items/:itemId (Firestore emulator)", () => {
  it("owner can update allowed fields; updatedAt changes; immutable fields don't", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItem();
    const before = await readItemDoc(organizationId, outletId, menuId, itemId);

    const result = await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId), {
      name: "Renamed Item",
      priceInPaise: 14000,
      id: "item-attacker",
      menuId: "menu-attacker",
      createdBy: "U-attacker",
    });

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {item} = result.data as {item: {name: string; priceInPaise: number; id: string; menuId: string; createdBy: string}};
    expect(item.name).toBe("Renamed Item");
    expect(item.priceInPaise).toBe(14000);
    expect(item.id).toBe(itemId);
    expect(item.menuId).toBe(menuId);
    expect(item.createdBy).toBe(ownerId);

    const after = await readItemDoc(organizationId, outletId, menuId, itemId);
    expect(after?.updatedAt.toMillis()).toBeGreaterThan(before?.updatedAt.toMillis());
    expect(after?.name).toBe("Renamed Item");
  });

  it("manager can update; staff cannot (403)", async () => {
    const {organizationId, outletId, menuId, itemId} = await setupItem();
    const managerId = freshUserId();
    await addMembership(organizationId, managerId, "manager");
    const staffId = freshUserId();
    await addMembership(organizationId, staffId, "staff");

    const managerResult = await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(managerId), {name: "New"});
    expect(managerResult).toMatchObject({kind: "success", status: 200});

    const staffResult = await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(staffId), {name: "New"});
    expect(staffResult).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("an archived menu's item cannot be edited (400), and the stored document is left unchanged", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItemThenTransitionMenu("archived");
    const before = await readItemDoc(organizationId, outletId, menuId, itemId);

    const result = await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId), {name: "New"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const after = await readItemDoc(organizationId, outletId, menuId, itemId);
    expect(after).toEqual(before);
  });

  it("a published menu's item cannot be edited once ordering has closed (400), doc unchanged", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItemThenTransitionMenu(
      "published", {orderingClosesAt: new Date(Date.now() - 60 * 60 * 1000)},
    );
    const before = await readItemDoc(organizationId, outletId, menuId, itemId);

    const result = await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId), {name: "New"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const after = await readItemDoc(organizationId, outletId, menuId, itemId);
    expect(after).toEqual(before);
  });

  it("a published menu's item can still be edited while ordering is open", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItemThenTransitionMenu("published");

    const result = await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId), {name: "New"});

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("enabled can be toggled off and back on, and persists", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItem();

    await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId), {enabled: false});
    const disabled = await readItemDoc(organizationId, outletId, menuId, itemId);
    expect(disabled?.enabled).toBe(false);

    await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId), {enabled: true});
    const reenabled = await readItemDoc(organizationId, outletId, menuId, itemId);
    expect(reenabled?.enabled).toBe(true);
  });

  it("denies updating for an inactive outlet (400)", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItem();
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callPatch(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId), {name: "New"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("returns 404, not 500, for a nonexistent item, and never creates a document (no upsert)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupItem();

    const result = await callPatch(organizationId, outletId, menuId, "does-not-exist", acceptingValidator(ownerId), {name: "New"});

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
    const snapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").doc(outletId)
      .collection("menus").doc(menuId)
      .collection("items").doc("does-not-exist").get();
    expect(snapshot.exists).toBe(false);
  });

  it("an item from another menu cannot be updated (404, never leaking cross-menu data)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const menuA = await setupMenu(organizationId, outletId, ownerId);
    const itemInB = await setupItem();

    const result = await callPatch(
      organizationId, outletId, menuA.menuId, itemInB.itemId, acceptingValidator(ownerId), {name: "Hijacked"},
    );

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("concurrent updates to different fields both succeed, leaving a well-formed document", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItem();
    const validator = acceptingValidator(ownerId);

    const [resultA, resultB] = await Promise.all([
      callPatch(organizationId, outletId, menuId, itemId, validator, {name: "Renamed Concurrently"}),
      callPatch(organizationId, outletId, menuId, itemId, validator, {priceInPaise: 15000}),
    ]);

    expect(resultA.status).toBe(200);
    expect(resultB.status).toBe(200);
    const stored = await readItemDoc(organizationId, outletId, menuId, itemId);
    expect(typeof stored?.name).toBe("string");
    expect(typeof stored?.priceInPaise).toBe("number");
    expect(Number.isInteger(stored?.priceInPaise)).toBe(true);
  });
});

describe("DELETE .../items/:itemId (Firestore emulator)", () => {
  it("deletes a draft menu's item; the document is removed", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItem();

    const result = await callDelete(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "success", status: 200});
    const snapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").doc(outletId)
      .collection("menus").doc(menuId)
      .collection("items").doc(itemId).get();
    expect(snapshot.exists).toBe(false);
  });

  it("rejects deleting a published menu's item, even while ordering is open (400); document unchanged", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItemThenTransitionMenu("published");

    const result = await callDelete(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const stored = await readItemDoc(organizationId, outletId, menuId, itemId);
    expect(stored).toBeDefined();
  });

  it("rejects deleting an archived menu's item (400)", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItemThenTransitionMenu("archived");

    const result = await callDelete(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("denies deleting for an inactive outlet (400)", async () => {
    const {organizationId, ownerId, outletId, menuId, itemId} = await setupItem();
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callDelete(organizationId, outletId, menuId, itemId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("returns 404 for a nonexistent item", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupItem();

    const result = await callDelete(organizationId, outletId, menuId, "no-such-item", acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it.each([
    ["owner", true], ["manager", true], ["staff", false],
  ])("%s can delete a draft item: %s", async (role, canDelete) => {
    const {organizationId, outletId, menuId, itemId} = await setupItem();
    const memberId = freshUserId();
    await addMembership(organizationId, memberId, role);

    const result = await callDelete(organizationId, outletId, menuId, itemId, acceptingValidator(memberId));

    if (canDelete) {
      expect(result).toMatchObject({kind: "success", status: 200});
    } else {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });

  it("an item from another menu cannot be deleted (404, never leaking cross-menu data)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const menuA = await setupMenu(organizationId, outletId, ownerId);
    const itemInB = await setupItem();

    const result = await callDelete(organizationId, outletId, menuA.menuId, itemInB.itemId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe("Tenant isolation (Firestore emulator)", () => {
  it("a user from Organization A cannot create, list, get, update, or delete in Organization B", async () => {
    const orgA = await setupOrgWithOwner();
    const orgB = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(orgB.organizationId, orgB.ownerId);
    const {menuId} = await setupMenu(orgB.organizationId, outletId, orgB.ownerId);
    const created = await callCreate(orgB.organizationId, outletId, menuId, acceptingValidator(orgB.ownerId), freshItemInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const itemId = (created.data as {item: {id: string}}).item.id;

    const userA = acceptingValidator(orgA.ownerId);
    const createResult = await callCreate(orgB.organizationId, outletId, menuId, userA, freshItemInput());
    const listResult = await callList(orgB.organizationId, outletId, menuId, userA);
    const getResult = await callGet(orgB.organizationId, outletId, menuId, itemId, userA);
    const patchResult = await callPatch(orgB.organizationId, outletId, menuId, itemId, userA, {name: "Hijacked"});
    const deleteResult = await callDelete(orgB.organizationId, outletId, menuId, itemId, userA);

    for (const result of [createResult, listResult, getResult, patchResult, deleteResult]) {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });
});

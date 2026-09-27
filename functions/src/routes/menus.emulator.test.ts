// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {createOrganization} from "../domain/organizations";
import {createOutlet, updateOutlet} from "../domain/outlets";
import {handleRequest} from "../http/handleRequest";
import type {NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createMenuRoutes} from "./menus";

/**
 * These tests exercise the menu routes against a REAL Firestore emulator —
 * the same reason `outlets.emulator.test.ts` exists: to prove real
 * transaction/read-then-write semantics (publish/archive/update), the full
 * owner/manager/staff/non-member authorization matrix against real
 * membership documents, tenant isolation, the real 2-field `menuDate`+
 * `createdAt` ordering (which exercises the composite index declared in
 * firestore.indexes.json), read-back fidelity, and concurrency. Descope
 * stays faked.
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

/** A fresh, internally-consistent create-menu body. `menuDate` is always
 * "tomorrow" relative to the real clock (not hardcoded), so this suite
 * never goes stale. */
function freshMenuInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  return {
    menuDate: businessDateString(new Date(tomorrow)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: new Date(now).toISOString(),
    orderingClosesAt: new Date(now + 60 * 60 * 1000).toISOString(),
    pickupStartsAt: new Date(tomorrow).toISOString(),
    pickupEndsAt: new Date(tomorrow + 4 * 60 * 60 * 1000).toISOString(),
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

function menuBasePath(organizationId: string, outletId: string): string {
  return `/organizations/${organizationId}/outlets/${outletId}/menus`;
}

async function callCreate(
  organizationId: string, outletId: string, validator: SessionValidator, body: unknown,
) {
  const routes = createMenuRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "POST", path: menuBasePath(organizationId, outletId), body}),
    () => {},
  );
}

async function callList(organizationId: string, outletId: string, validator: SessionValidator) {
  const routes = createMenuRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "GET", path: menuBasePath(organizationId, outletId)}),
    () => {},
  );
}

async function callGet(
  organizationId: string, outletId: string, menuId: string, validator: SessionValidator,
) {
  const routes = createMenuRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "GET", path: `${menuBasePath(organizationId, outletId)}/${menuId}`}),
    () => {},
  );
}

async function callPatch(
  organizationId: string, outletId: string, menuId: string, validator: SessionValidator, body: unknown,
) {
  const routes = createMenuRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "PATCH", path: `${menuBasePath(organizationId, outletId)}/${menuId}`, body}),
    () => {},
  );
}

async function callPublish(
  organizationId: string, outletId: string, menuId: string, validator: SessionValidator,
) {
  const routes = createMenuRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "POST", path: `${menuBasePath(organizationId, outletId)}/${menuId}/publish`}),
    () => {},
  );
}

async function callArchive(
  organizationId: string, outletId: string, menuId: string, validator: SessionValidator,
) {
  const routes = createMenuRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "POST", path: `${menuBasePath(organizationId, outletId)}/${menuId}/archive`}),
    () => {},
  );
}

async function readMenuDoc(organizationId: string, outletId: string, menuId: string) {
  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .get();
  return snapshot.data();
}

describe("POST .../menus (Firestore emulator)", () => {
  it("creates the menu as draft; read back from Firestore matches the request", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const input = freshMenuInput({description: "Freshly prepared lunch menu."});

    const result = await callCreate(organizationId, outletId, acceptingValidator(ownerId), input);

    expect(result).toMatchObject({kind: "success", status: 201});
    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {id: string; status: string; createdBy: string}};
    expect(menu.status).toBe("draft");
    expect(menu.createdBy).toBe(ownerId);

    const stored = await readMenuDoc(organizationId, outletId, menu.id);
    expect(stored).toMatchObject({
      organizationId, outletId, menuDate: input.menuDate, title: input.title,
      description: input.description, status: "draft", createdBy: ownerId,
    });
  });

  it("denies a non-member (403)", async () => {
    const {organizationId} = await setupOrgWithOwner();
    const otherOrg = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, otherOrg.ownerId);

    const result = await callCreate(organizationId, outletId, acceptingValidator(freshUserId()), freshMenuInput());

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each([
    ["owner", true], ["manager", true], ["staff", false],
  ])("%s can create: %s", async (role, canCreate) => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const memberId = freshUserId();
    await addMembership(organizationId, memberId, role);

    const result = await callCreate(organizationId, outletId, acceptingValidator(memberId), freshMenuInput());

    if (canCreate) {
      expect(result).toMatchObject({kind: "success", status: 201});
    } else {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });

  it("denies creation for a nonexistent outlet (404)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();

    const result = await callCreate(organizationId, "no-such-outlet", acceptingValidator(ownerId), freshMenuInput());

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("denies creation for an inactive outlet (400)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupInactiveOutlet(organizationId, ownerId);

    const result = await callCreate(organizationId, outletId, acceptingValidator(ownerId), freshMenuInput());

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects an invalid body without touching Firestore", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callCreate(organizationId, outletId, acceptingValidator(ownerId), {title: "No date"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const listResult = await callList(organizationId, outletId, acceptingValidator(ownerId));
    if (listResult.kind === "success") {
      expect((listResult.data as {menus: unknown[]}).menus).toHaveLength(0);
    }
  });

  it("lets two concurrent creates for the same outlet and menuDate both succeed as distinct documents (no uniqueness constraint)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const input = freshMenuInput();
    const validator = acceptingValidator(ownerId);

    const [resultA, resultB] = await Promise.all([
      callCreate(organizationId, outletId, validator, input),
      callCreate(organizationId, outletId, validator, input),
    ]);

    expect(resultA.status).toBe(201);
    expect(resultB.status).toBe(201);
    if (resultA.kind !== "success" || resultB.kind !== "success") throw new Error("expected success");
    const idA = (resultA.data as {menu: {id: string}}).menu.id;
    const idB = (resultB.data as {menu: {id: string}}).menu.id;
    expect(idA).not.toBe(idB);
  });
});

describe("GET .../menus (list, Firestore emulator)", () => {
  it("orders by menuDate ascending, then createdAt ascending (exercises the composite index)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const validator = acceptingValidator(ownerId);
    const now = Date.now();
    const dayAfterTomorrow = businessDateString(new Date(now + 48 * 60 * 60 * 1000));
    const tomorrow = businessDateString(new Date(now + 24 * 60 * 60 * 1000));

    // Created out of menuDate order, on purpose.
    const later = await callCreate(organizationId, outletId, validator, freshMenuInput({
      menuDate: dayAfterTomorrow,
      pickupStartsAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
      pickupEndsAt: new Date(now + 52 * 60 * 60 * 1000).toISOString(),
    }));
    const earlierA = await callCreate(organizationId, outletId, validator, freshMenuInput({menuDate: tomorrow}));
    const earlierB = await callCreate(organizationId, outletId, validator, freshMenuInput({menuDate: tomorrow}));
    if (later.kind !== "success" || earlierA.kind !== "success" || earlierB.kind !== "success") {
      throw new Error("setup failed");
    }
    const laterId = (later.data as {menu: {id: string}}).menu.id;
    const earlierAId = (earlierA.data as {menu: {id: string}}).menu.id;
    const earlierBId = (earlierB.data as {menu: {id: string}}).menu.id;

    const result = await callList(organizationId, outletId, validator);

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {menus} = result.data as {menus: Array<{id: string; menuDate: string}>};
    const ids = menus.map((m) => m.id);
    // Both tomorrow-dated menus (created earlierA then earlierB) must sort
    // before the day-after-tomorrow one, and earlierA before earlierB
    // (createdAt tie-breaker).
    expect(ids.indexOf(earlierAId)).toBeLessThan(ids.indexOf(earlierBId));
    expect(ids.indexOf(earlierBId)).toBeLessThan(ids.indexOf(laterId));
  });

  it("returns every lifecycle state, and an empty array for an outlet with none", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const validator = acceptingValidator(ownerId);

    const empty = await callList(organizationId, outletId, validator);
    expect(empty).toMatchObject({kind: "success", status: 200});
    if (empty.kind === "success") expect(empty.data).toEqual({menus: []});

    const created = await callCreate(organizationId, outletId, validator, freshMenuInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const menuId = (created.data as {menu: {id: string}}).menu.id;
    await callPublish(organizationId, outletId, menuId, validator);
    await callArchive(organizationId, outletId, menuId, validator);

    const afterArchive = await callList(organizationId, outletId, validator);
    if (afterArchive.kind === "success") {
      const {menus} = afterArchive.data as {menus: Array<{status: string}>};
      expect(menus).toHaveLength(1);
      expect(menus[0].status).toBe("archived");
    }
  });

  it("allows staff to view the list, and allows listing for an inactive outlet", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupInactiveOutlet(organizationId, ownerId);
    const staffId = freshUserId();
    await addMembership(organizationId, staffId, "staff");

    const result = await callList(organizationId, outletId, acceptingValidator(staffId));

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("denies a non-member (403)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callList(organizationId, outletId, acceptingValidator(freshUserId()));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });
});

describe("GET .../menus/:menuId (Firestore emulator)", () => {
  it("returns the menu; allows viewing for an inactive outlet", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const created = await callCreate(organizationId, outletId, acceptingValidator(ownerId), freshMenuInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const menuId = (created.data as {menu: {id: string}}).menu.id;
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callGet(organizationId, outletId, menuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("returns 404, not 500, for a nonexistent menu", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callGet(organizationId, outletId, "no-such-menu", acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a menu from a different outlet cannot be read (404, never leaking cross-tenant data)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const outletA = await setupOutlet(organizationId, ownerId);
    const outletB = await setupOutlet(organizationId, ownerId);
    const created = await callCreate(organizationId, outletB.outletId, acceptingValidator(ownerId), freshMenuInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const menuId = (created.data as {menu: {id: string}}).menu.id;

    const result = await callGet(organizationId, outletA.outletId, menuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe("PATCH .../menus/:menuId (Firestore emulator)", () => {
  async function setupMenu(overrides: Record<string, unknown> = {}) {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const created = await callCreate(organizationId, outletId, acceptingValidator(ownerId), freshMenuInput(overrides));
    if (created.kind !== "success") throw new Error("setup failed");
    const menuId = (created.data as {menu: {id: string}}).menu.id;
    return {organizationId, ownerId, outletId, menuId};
  }

  it("owner can update allowed fields; updatedAt changes; immutable fields don't", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupMenu();
    const before = await readMenuDoc(organizationId, outletId, menuId);

    const result = await callPatch(organizationId, outletId, menuId, acceptingValidator(ownerId), {
      title: "Renamed Menu",
      status: "published",
      organizationId: "org-attacker",
      outletId: "outlet-attacker",
      createdBy: "U-attacker",
    });

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {title: string; status: string; organizationId: string; outletId: string; createdBy: string}};
    expect(menu.title).toBe("Renamed Menu");
    expect(menu.status).toBe("draft");
    expect(menu.organizationId).toBe(organizationId);
    expect(menu.outletId).toBe(outletId);
    expect(menu.createdBy).toBe(ownerId);

    const after = await readMenuDoc(organizationId, outletId, menuId);
    expect(after?.updatedAt.toMillis()).toBeGreaterThan(before?.updatedAt.toMillis());
    expect(after?.title).toBe("Renamed Menu");
  });

  it("manager can update; staff cannot (403)", async () => {
    const {organizationId, outletId, menuId} = await setupMenu();
    const managerId = freshUserId();
    await addMembership(organizationId, managerId, "manager");
    const staffId = freshUserId();
    await addMembership(organizationId, staffId, "staff");

    const managerResult = await callPatch(organizationId, outletId, menuId, acceptingValidator(managerId), {title: "New"});
    expect(managerResult).toMatchObject({kind: "success", status: 200});

    const staffResult = await callPatch(organizationId, outletId, menuId, acceptingValidator(staffId), {title: "New"});
    expect(staffResult).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("an archived menu cannot be edited (400), and the stored document is left unchanged", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupMenu();
    await callPublish(organizationId, outletId, menuId, acceptingValidator(ownerId));
    await callArchive(organizationId, outletId, menuId, acceptingValidator(ownerId));
    const before = await readMenuDoc(organizationId, outletId, menuId);

    const result = await callPatch(organizationId, outletId, menuId, acceptingValidator(ownerId), {title: "New"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const after = await readMenuDoc(organizationId, outletId, menuId);
    expect(after).toEqual(before);
  });

  it("rejects a schedule-field edit once ordering has closed, but still allows title/description", async () => {
    const now = Date.now();
    const {organizationId, ownerId, outletId, menuId} = await setupMenu({
      orderingOpensAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      orderingClosesAt: new Date(now - 60 * 60 * 1000).toISOString(),
      pickupStartsAt: new Date(now + 60 * 60 * 1000).toISOString(),
      pickupEndsAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      menuDate: businessDateString(new Date(now)),
    });

    const scheduleEdit = await callPatch(organizationId, outletId, menuId, acceptingValidator(ownerId), {
      pickupEndsAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
    });
    expect(scheduleEdit).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});

    const titleEdit = await callPatch(organizationId, outletId, menuId, acceptingValidator(ownerId), {
      title: "Still editable",
    });
    expect(titleEdit).toMatchObject({kind: "success", status: 200});
  });

  it("rejects a patch that would break the merged schedule's relational rules", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupMenu();
    const stored = await readMenuDoc(organizationId, outletId, menuId);

    const result = await callPatch(organizationId, outletId, menuId, acceptingValidator(ownerId), {
      // Push orderingOpensAt past the existing, untouched orderingClosesAt.
      orderingOpensAt: stored?.orderingClosesAt.toDate().toISOString(),
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("denies updating for an inactive outlet (400)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupMenu();
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callPatch(organizationId, outletId, menuId, acceptingValidator(ownerId), {title: "New"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("returns 404, not 500, for a nonexistent menu, and never creates a document (no upsert)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callPatch(organizationId, outletId, "does-not-exist", acceptingValidator(ownerId), {title: "New"});

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
    const snapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").doc(outletId)
      .collection("menus").doc("does-not-exist").get();
    expect(snapshot.exists).toBe(false);
  });

  it("a menu from another outlet cannot be updated (404, never leaking cross-tenant data)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const outletA = await setupOutlet(organizationId, ownerId);
    const menuInB = await setupMenu();

    const result = await callPatch(
      organizationId, outletA.outletId, menuInB.menuId, acceptingValidator(ownerId), {title: "Hijacked"},
    );

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe("POST .../menus/:menuId/publish (Firestore emulator)", () => {
  async function setupDraftMenu() {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const created = await callCreate(organizationId, outletId, acceptingValidator(ownerId), freshMenuInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const menuId = (created.data as {menu: {id: string}}).menu.id;
    return {organizationId, ownerId, outletId, menuId};
  }

  it("publishes a draft; publishedAt is generated; read-back confirms status and publishedAt", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupDraftMenu();

    const result = await callPublish(organizationId, outletId, menuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {menu} = result.data as {menu: {status: string; publishedAt?: string}};
    expect(menu.status).toBe("published");
    expect(menu.publishedAt).toBeDefined();

    const stored = await readMenuDoc(organizationId, outletId, menuId);
    expect(stored?.status).toBe("published");
    expect(stored?.publishedAt).toBeDefined();
  });

  it("rejects publishing an already-published menu (400), and an archived one (400)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupDraftMenu();
    await callPublish(organizationId, outletId, menuId, acceptingValidator(ownerId));

    const republish = await callPublish(organizationId, outletId, menuId, acceptingValidator(ownerId));
    expect(republish).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});

    await callArchive(organizationId, outletId, menuId, acceptingValidator(ownerId));
    const publishArchived = await callPublish(organizationId, outletId, menuId, acceptingValidator(ownerId));
    expect(publishArchived).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("denies publishing for an inactive outlet (400)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupDraftMenu();
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callPublish(organizationId, outletId, menuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("returns 404 for a nonexistent menu", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callPublish(organizationId, outletId, "no-such-menu", acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it.each([
    ["owner", true], ["manager", true], ["staff", false],
  ])("%s can publish: %s", async (role, canPublish) => {
    const {organizationId, outletId, menuId} = await setupDraftMenu();
    const memberId = freshUserId();
    await addMembership(organizationId, memberId, role);

    const result = await callPublish(organizationId, outletId, menuId, acceptingValidator(memberId));

    if (canPublish) {
      expect(result).toMatchObject({kind: "success", status: 200});
    } else {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });

  it("publish is atomic under concurrency: exactly one of two concurrent publishes succeeds, leaving no invalid state", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupDraftMenu();
    const validator = acceptingValidator(ownerId);

    const [resultA, resultB] = await Promise.all([
      callPublish(organizationId, outletId, menuId, validator),
      callPublish(organizationId, outletId, menuId, validator),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual([200, 400]);

    const stored = await readMenuDoc(organizationId, outletId, menuId);
    expect(stored?.status).toBe("published");
    expect(stored?.publishedAt).toBeDefined();
  });
});

describe("POST .../menus/:menuId/archive (Firestore emulator)", () => {
  async function setupPublishedMenu() {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const created = await callCreate(organizationId, outletId, acceptingValidator(ownerId), freshMenuInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const menuId = (created.data as {menu: {id: string}}).menu.id;
    await callPublish(organizationId, outletId, menuId, acceptingValidator(ownerId));
    return {organizationId, ownerId, outletId, menuId};
  }

  it("archives a published menu; read-back confirms status", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupPublishedMenu();

    const result = await callArchive(organizationId, outletId, menuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "success", status: 200});
    const stored = await readMenuDoc(organizationId, outletId, menuId);
    expect(stored?.status).toBe("archived");
  });

  it("rejects archiving a draft (400)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const created = await callCreate(organizationId, outletId, acceptingValidator(ownerId), freshMenuInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const draftMenuId = (created.data as {menu: {id: string}}).menu.id;

    const result = await callArchive(organizationId, outletId, draftMenuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects archiving an already-archived menu (400)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupPublishedMenu();
    await callArchive(organizationId, outletId, menuId, acceptingValidator(ownerId));

    const result = await callArchive(organizationId, outletId, menuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("allows archiving even when the outlet has since become inactive", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupPublishedMenu();
    await updateOutlet(db, organizationId, outletId, {status: "inactive"});

    const result = await callArchive(organizationId, outletId, menuId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it.each([
    ["owner", true], ["manager", true], ["staff", false],
  ])("%s can archive: %s", async (role, canArchive) => {
    const {organizationId, outletId, menuId} = await setupPublishedMenu();
    const memberId = freshUserId();
    await addMembership(organizationId, memberId, role);

    const result = await callArchive(organizationId, outletId, menuId, acceptingValidator(memberId));

    if (canArchive) {
      expect(result).toMatchObject({kind: "success", status: 200});
    } else {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });
});

describe("Tenant isolation (Firestore emulator)", () => {
  it("a user from Organization A cannot create, list, get, update, publish, or archive in Organization B", async () => {
    const orgA = await setupOrgWithOwner();
    const orgB = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(orgB.organizationId, orgB.ownerId);
    const created = await callCreate(orgB.organizationId, outletId, acceptingValidator(orgB.ownerId), freshMenuInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const menuId = (created.data as {menu: {id: string}}).menu.id;

    const userA = acceptingValidator(orgA.ownerId);
    const createResult = await callCreate(orgB.organizationId, outletId, userA, freshMenuInput());
    const listResult = await callList(orgB.organizationId, outletId, userA);
    const getResult = await callGet(orgB.organizationId, outletId, menuId, userA);
    const patchResult = await callPatch(orgB.organizationId, outletId, menuId, userA, {title: "Hijacked"});
    const publishResult = await callPublish(orgB.organizationId, outletId, menuId, userA);
    const archiveResult = await callArchive(orgB.organizationId, outletId, menuId, userA);

    for (const result of [createResult, listResult, getResult, patchResult, publishResult, archiveResult]) {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });
});

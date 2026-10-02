// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {createMenuItem, updateMenuItem} from "../domain/menuItems";
import {archiveMenu, createMenu, publishMenu, type Menu} from "../domain/menus";
import {createOrder} from "../domain/orders";
import {createOrganization} from "../domain/organizations";
import {createOutlet, updateOutlet} from "../domain/outlets";
import {toResponseBody} from "../http/envelope";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * These tests exercise `GET /organizations/{organizationId}/orders` against a
 * REAL Firestore emulator: the real membership documents behind the
 * owner/manager/staff/invited/revoked/non-member matrix, the real
 * collection-group query and its ordering/pagination, and — the point of the
 * endpoint — tenant isolation between organizations and between outlets.
 * Descope stays faked. The organization/outlet/menu chain is set up directly
 * through the domain functions (already proven by their own suites), orders
 * are written with exact timestamps so ordering assertions are deterministic.
 *
 * Note the Firestore emulator does NOT enforce composite indexes, so this file
 * proves the query's behavior, not that `firestore.indexes.json` declares the
 * indexes it needs; that can only be confirmed against real Firestore.
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

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    await deleteSeeded();
  } finally {
    await archiveFixtureMenus();
  }
});

// Menus this file publishes (see `publishTracked`); archived after each test so
// they don't linger in the shared emulator's public Explore feed.
const publishedFixtureMenus: Array<{organizationId: string; outletId: string; menuId: string}> = [];

async function publishTracked(organizationId: string, outletId: string, menuId: string): Promise<void> {
  await publishMenu(db, organizationId, outletId, menuId);
  publishedFixtureMenus.push({organizationId, outletId, menuId});
}

async function archiveFixtureMenus(): Promise<void> {
  let firstError: unknown;
  for (const {organizationId, outletId, menuId} of publishedFixtureMenus.splice(0)) {
    try {
      await archiveMenu(db, organizationId, outletId, menuId);
    } catch (error) {
      const alreadyGone = error instanceof HttpsError &&
        (error.code === "failed-precondition" || error.code === "not-found");
      if (!alreadyGone && firstError === undefined) {
        firstError = error;
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

function freshOrgInput() {
  const suffix = randomUUID();
  return {name: `Test Org ${suffix}`, slug: `test-org-${suffix}`};
}

function freshOutletInput(name?: string) {
  const suffix = randomUUID();
  return {name: name ?? `Outlet ${suffix}`, slug: `outlet-${suffix}`};
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

function rejectingValidator(): SessionValidator {
  return {
    validateSession: vi.fn(async () => {
      throw new HttpsError("unauthenticated", "The session is invalid or has expired.");
    }),
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

async function callList(
  organizationId: string,
  validator: SessionValidator,
  query: Record<string, unknown> = {},
  headers: NormalizedRequest["headers"] = {authorization: "Bearer token"},
): Promise<ApiResult> {
  const routes = createOrganizationOrderRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "GET", path: `/organizations/${organizationId}/orders`, query, headers}),
    () => {},
  );
}

interface OrderRowShape {
  id: string;
  outletId: string;
  menuId: string;
  outlet?: {name: string};
  menu?: {title: string; menuDate: string};
  status: string;
  paymentStatus: string;
  currency: string;
  subtotalInPaise: number;
  totalInPaise: number;
  itemCount: number;
  items: Array<{name: string; quantity: number}>;
  moreItemLines: number;
  createdAt: string;
  updatedAt: string;
}

interface PageShape {
  orders: OrderRowShape[];
  nextCursor: string | null;
}

function pageOf(result: ApiResult): PageShape {
  if (result.kind !== "success") throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result.data as PageShape;
}

function idsOf(result: ApiResult): string[] {
  return pageOf(result).orders.map((order) => order.id);
}

/** The organization-orders listing walked page by page until the cursor runs out. */
async function walkAll(
  organizationId: string,
  validator: SessionValidator,
  query: Record<string, unknown>,
): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = pageOf(await callList(organizationId, validator, cursor ? {...query, cursor} : query));
    pages.push(page.orders.map((order) => order.id));
    cursor = page.nextCursor;
    if (cursor === null) {
      return pages;
    }
  }
  throw new Error("pagination did not terminate");
}

// Orders (and the payment documents some tests attach) written by `seedOrders`.
// The emulator answers a collection-group query by scanning every document in
// the group, so leftovers slow every other file's order lookups: delete them
// after each test.
const seededRefs: DocumentReference[] = [];

async function deleteSeeded(): Promise<void> {
  const refs = seededRefs.splice(0);
  const BATCH_LIMIT = 400;
  for (let start = 0; start < refs.length; start += BATCH_LIMIT) {
    const batch = db.batch();
    for (const ref of refs.slice(start, start + BATCH_LIMIT)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
}

interface SeedOrderInput {
  userId?: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  createdAt: Timestamp;
  status?: "pending_payment" | "confirmed" | "cancelled";
  paymentStatus?: "pending" | "paid";
  items?: Array<{itemId: string; name: string; priceInPaise: number; quantity: number}>;
}

/**
 * Writes orders straight into Firestore with an exact `createdAt`, bypassing
 * `createOrder` (whose millisecond timestamps can tie). The shape is exactly
 * what `createOrder` writes; the route re-validates it with `parseOrder` on
 * every read. Returns the new order ids in input order.
 */
async function seedOrders(inputs: SeedOrderInput[]): Promise<string[]> {
  const batch = db.batch();
  const ids: string[] = [];
  for (const input of inputs) {
    const ref = db
      .collection("organizations").doc(input.organizationId)
      .collection("outlets").doc(input.outletId)
      .collection("menus").doc(input.menuId)
      .collection("orders").doc();
    seededRefs.push(ref);
    const items = (input.items ?? [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 1}])
      .map((item) => ({...item, lineTotalInPaise: item.priceInPaise * item.quantity}));
    const subtotalInPaise = items.reduce((sum, item) => sum + item.lineTotalInPaise, 0);
    batch.create(ref, {
      id: ref.id,
      userId: input.userId ?? "U-seed-customer",
      organizationId: input.organizationId,
      outletId: input.outletId,
      menuId: input.menuId,
      status: input.status ?? "pending_payment",
      paymentStatus: input.paymentStatus ?? "pending",
      currency: "INR",
      subtotalInPaise,
      totalInPaise: subtotalInPaise,
      items,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    ids.push(ref.id);
  }
  await batch.commit();
  return ids;
}

const BASE_MILLIS = Date.UTC(2026, 8, 1, 6, 0, 0);

/** A fixed instant `minutes` after a fixed base, so tests choose exact orderings. */
function minutesAfterBase(minutes: number): Timestamp {
  return Timestamp.fromMillis(BASE_MILLIS + minutes * 60_000);
}

async function createDraftMenu(organizationId: string, outletId: string, ownerId: string): Promise<Menu> {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  return createMenu(db, organizationId, outletId, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 60 * 60 * 1000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 60 * 60 * 1000)),
    pickupStartsAt: Timestamp.fromDate(new Date(tomorrow)),
    pickupEndsAt: Timestamp.fromDate(new Date(tomorrow + 4 * 60 * 60 * 1000)),
  });
}

interface OrgFixture {
  organizationId: string;
  ownerId: string;
  /** An active outlet. */
  outletId: string;
  outletName: string;
  /** A second outlet that has since been deactivated. */
  inactiveOutletId: string;
  inactiveOutletName: string;
  menuId: string;
  inactiveMenuId: string;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  const organizationId = organization.id;
  const outletName = `${label} Main Canteen`;
  const inactiveOutletName = `${label} Old Annex`;
  const outlet = await createOutlet(db, organizationId, ownerId, freshOutletInput(outletName));
  const inactive = await createOutlet(db, organizationId, ownerId, freshOutletInput(inactiveOutletName));
  // The menus are never-published drafts on purpose: listing orders does not
  // depend on menu state, and it keeps the fixture out of the public feed.
  const menu = await createDraftMenu(organizationId, outlet.id, ownerId);
  const inactiveMenu = await createDraftMenu(organizationId, inactive.id, ownerId);
  await updateOutlet(db, organizationId, inactive.id, {status: "inactive"});
  return {
    organizationId,
    ownerId,
    outletId: outlet.id,
    outletName,
    inactiveOutletId: inactive.id,
    inactiveOutletName,
    menuId: menu.id,
    inactiveMenuId: inactiveMenu.id,
  };
}

describe("GET /organizations/:organizationId/orders (Firestore emulator)", () => {
  // Two unrelated organizations shared by every test (each test seeds its own
  // orders, deleted afterwards): building a full org/outlet/menu chain per test
  // is a dozen sequential emulator round trips.
  let orgA: OrgFixture;
  let orgB: OrgFixture;
  let managerA: string;
  let staffA: string;
  let invitedA: string;
  let revokedA: string;

  beforeAll(async () => {
    orgA = await buildOrg("Org A");
    orgB = await buildOrg("Org B");
    managerA = freshUserId();
    staffA = freshUserId();
    invitedA = freshUserId();
    revokedA = freshUserId();
    await addMembership(orgA.organizationId, managerA, "manager");
    await addMembership(orgA.organizationId, staffA, "staff");
    await addMembership(orgA.organizationId, invitedA, "owner", "invited");
    await addMembership(orgA.organizationId, revokedA, "manager", "revoked");
  });

  /** Seeds `count` orders for org A's main outlet, newest = highest index. */
  async function seedA(count: number, extra: Partial<SeedOrderInput> = {}): Promise<string[]> {
    return seedOrders(Array.from({length: count}, (_unused, index) => ({
      organizationId: orgA.organizationId,
      outletId: orgA.outletId,
      menuId: orgA.menuId,
      createdAt: minutesAfterBase(index + 1),
      ...extra,
    })));
  }

  describe("authentication and authorization", () => {
    it("denies an unauthenticated caller (401)", async () => {
      const result = await callList(orgA.organizationId, rejectingValidator());

      expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
    });

    it("denies a request with no Authorization header (401) without consulting the validator", async () => {
      const validator = acceptingValidator(orgA.ownerId);

      const result = await callList(orgA.organizationId, validator, {}, {});

      expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
      expect(validator.validateSession).not.toHaveBeenCalled();
    });

    it("denies a customer-only account — a real user with no membership anywhere (403)", async () => {
      await seedA(2);

      const result = await callList(orgA.organizationId, acceptingValidator(freshUserId()));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });

    it("denies a customer who PLACED an order in the organization: customers are not members (403)", async () => {
      const customerId = freshUserId();
      await seedOrders([{
        userId: customerId,
        organizationId: orgA.organizationId,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        createdAt: minutesAfterBase(1),
      }]);

      const result = await callList(orgA.organizationId, acceptingValidator(customerId));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });

    it.each(["owner", "manager", "staff"] as const)("lets an active %s read the organization's orders (200)", async (role) => {
      const ids = await seedA(3);
      const userId = {owner: orgA.ownerId, manager: managerA, staff: staffA}[role];

      const result = await callList(orgA.organizationId, acceptingValidator(userId));

      expect(result).toMatchObject({kind: "success", status: 200});
      expect(idsOf(result)).toEqual([...ids].reverse());
    });

    it.each([
      ["invited", () => invitedA],
      ["revoked", () => revokedA],
    ])("denies a %s member (403)", async (_label, user) => {
      await seedA(1);

      const result = await callList(orgA.organizationId, acceptingValidator(user()));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });

    it("stops serving a member the moment their membership is revoked", async () => {
      const userId = freshUserId();
      await addMembership(orgA.organizationId, userId, "staff");
      await seedA(1);
      expect(await callList(orgA.organizationId, acceptingValidator(userId))).toMatchObject({status: 200});

      await addMembership(orgA.organizationId, userId, "staff", "revoked");

      expect(await callList(orgA.organizationId, acceptingValidator(userId)))
        .toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });

    it("denies a member whose document holds an unknown role or status (403)", async () => {
      const oddRole = freshUserId();
      const oddStatus = freshUserId();
      await addMembership(orgA.organizationId, oddRole, "superadmin");
      await addMembership(orgA.organizationId, oddStatus, "owner", "pending");

      expect(await callList(orgA.organizationId, acceptingValidator(oddRole))).toMatchObject({status: 403});
      expect(await callList(orgA.organizationId, acceptingValidator(oddStatus))).toMatchObject({status: 403});
    });

    it("treats a nonexistent organization exactly like a forbidden one (403, not 404)", async () => {
      const result = await callList(`no-such-org-${randomUUID()}`, acceptingValidator(orgA.ownerId));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });

    it("authorizes before validating the query: a non-member gets 403 even for a malformed query", async () => {
      const result = await callList(
        orgA.organizationId,
        acceptingValidator(freshUserId()),
        {limit: "abc", outletId: "a/b"},
      );

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });
  });

  describe("tenant isolation", () => {
    it("shows each organization only its own orders", async () => {
      const aIds = await seedA(2);
      const bIds = await seedOrders([
        {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(1)},
        {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(5)},
      ]);

      const forA = idsOf(await callList(orgA.organizationId, acceptingValidator(orgA.ownerId)));
      const forB = idsOf(await callList(orgB.organizationId, acceptingValidator(orgB.ownerId)));

      expect(forA).toEqual([...aIds].reverse());
      expect(forB).toEqual([...bIds].reverse());
      expect(forA.filter((id) => bIds.includes(id))).toEqual([]);
      expect(forB.filter((id) => aIds.includes(id))).toEqual([]);
    });

    it("denies organization A's owner organization B's orders by changing the path organizationId (403)", async () => {
      const [bOrder] = await seedOrders([
        {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(1)},
      ]);

      const result = await callList(orgB.organizationId, acceptingValidator(orgA.ownerId));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(JSON.stringify(result)).not.toContain(bOrder);
    });

    it("denies organization A's staff and manager organization B's orders (403)", async () => {
      await seedOrders([
        {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(1)},
      ]);

      expect(await callList(orgB.organizationId, acceptingValidator(staffA))).toMatchObject({status: 403});
      expect(await callList(orgB.organizationId, acceptingValidator(managerA))).toMatchObject({status: 403});
    });

    it("keeps a role per organization: a user who owns A and is only revoked in B has no access to B", async () => {
      const userId = freshUserId();
      await addMembership(orgA.organizationId, userId, "owner");
      await addMembership(orgB.organizationId, userId, "owner", "revoked");
      await seedOrders([
        {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(1)},
      ]);

      expect(await callList(orgA.organizationId, acceptingValidator(userId))).toMatchObject({status: 200});
      expect(await callList(orgB.organizationId, acceptingValidator(userId))).toMatchObject({status: 403});
    });

    it("ignores an organizationId or userId in the query string: neither is authority", async () => {
      const aIds = await seedA(2);
      await seedOrders([
        {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(9)},
      ]);

      const result = await callList(
        orgA.organizationId,
        acceptingValidator(orgA.ownerId),
        {organizationId: orgB.organizationId, userId: "U-someone-else"},
      );

      expect(idsOf(result)).toEqual([...aIds].reverse());
    });

    it("lists an order whatever customer placed it: ownership of the order is irrelevant to members", async () => {
      const [first, second] = await seedOrders([
        {userId: freshUserId(), organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId,
          createdAt: minutesAfterBase(1)},
        {userId: freshUserId(), organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId,
          createdAt: minutesAfterBase(2)},
      ]);

      expect(idsOf(await callList(orgA.organizationId, acceptingValidator(staffA)))).toEqual([second, first]);
    });
  });

  describe("outlet filter", () => {
    it("narrows the list to the requested outlet", async () => {
      const [mainOrder] = await seedOrders([
        {organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId, createdAt: minutesAfterBase(1)},
      ]);
      const [annexOrder] = await seedOrders([
        {organizationId: orgA.organizationId, outletId: orgA.inactiveOutletId, menuId: orgA.inactiveMenuId,
          createdAt: minutesAfterBase(2)},
      ]);
      const validator = acceptingValidator(managerA);

      const main = idsOf(await callList(orgA.organizationId, validator, {outletId: orgA.outletId}));
      const all = idsOf(await callList(orgA.organizationId, validator));

      expect(main).toEqual([mainOrder]);
      expect(all).toEqual([annexOrder, mainOrder]);
    });

    it("keeps historical orders of an INACTIVE outlet visible, both unfiltered and filtered", async () => {
      const [annexOrder] = await seedOrders([
        {organizationId: orgA.organizationId, outletId: orgA.inactiveOutletId, menuId: orgA.inactiveMenuId,
          createdAt: minutesAfterBase(1), status: "confirmed", paymentStatus: "paid"},
      ]);
      const validator = acceptingValidator(staffA);

      const unfiltered = pageOf(await callList(orgA.organizationId, validator));
      const filtered = pageOf(await callList(orgA.organizationId, validator, {outletId: orgA.inactiveOutletId}));

      expect(unfiltered.orders.map((order) => order.id)).toEqual([annexOrder]);
      expect(filtered.orders.map((order) => order.id)).toEqual([annexOrder]);
      expect(filtered.orders[0].outlet).toEqual({name: orgA.inactiveOutletName});
    });

    it("denies another organization's outlet as not found (404), leaking none of its orders", async () => {
      const [bOrder] = await seedOrders([
        {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(1)},
      ]);

      const result = await callList(orgA.organizationId, acceptingValidator(orgA.ownerId), {outletId: orgB.outletId});

      expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
      expect(JSON.stringify(result)).not.toContain(bOrder);
    });

    it("answers a foreign outlet and a nonexistent outlet identically (404)", async () => {
      const validator = acceptingValidator(orgA.ownerId);

      const foreign = await callList(orgA.organizationId, validator, {outletId: orgB.outletId});
      const missing = await callList(orgA.organizationId, validator, {outletId: `no-such-outlet-${randomUUID()}`});

      expect(foreign).toEqual(missing);
      expect(foreign).toMatchObject({status: 404});
    });

    it("cannot be used to reach another organization: org B's owner naming org A's outlet on org B's path is a 404", async () => {
      await seedA(2);

      const result = await callList(orgB.organizationId, acceptingValidator(orgB.ownerId), {outletId: orgA.outletId});

      expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
    });

    it("never turns an outlet filter into authorization: a non-member naming a real outlet still gets 403", async () => {
      await seedA(1);

      const result = await callList(orgA.organizationId, acceptingValidator(freshUserId()), {outletId: orgA.outletId});

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });

    it.each(["", "a/b", ".."])("rejects the malformed outletId %j with 400 instead of treating it as no filter", async (outletId) => {
      await seedA(1);

      const result = await callList(orgA.organizationId, acceptingValidator(orgA.ownerId), {outletId});

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    });
  });

  describe("content", () => {
    it("shows every order status: pending_payment, confirmed and cancelled", async () => {
      const [pending, confirmed, cancelled] = await seedOrders([
        {organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId,
          createdAt: minutesAfterBase(1), status: "pending_payment", paymentStatus: "pending"},
        {organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId,
          createdAt: minutesAfterBase(2), status: "confirmed", paymentStatus: "paid"},
        {organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId,
          createdAt: minutesAfterBase(3), status: "cancelled", paymentStatus: "pending"},
      ]);

      const rows = pageOf(await callList(orgA.organizationId, acceptingValidator(orgA.ownerId))).orders;

      expect(rows.map((row) => [row.id, row.status, row.paymentStatus])).toEqual([
        [cancelled, "cancelled", "pending"],
        [confirmed, "confirmed", "paid"],
        [pending, "pending_payment", "pending"],
      ]);
    });

    it("returns an empty first page for an organization with no orders", async () => {
      const ownerId = freshUserId();
      const {organization} = await createOrganization(db, ownerId, freshOrgInput());

      const result = await callList(organization.id, acceptingValidator(ownerId));

      expect(result).toMatchObject({kind: "success", status: 200});
      expect(pageOf(result)).toEqual({orders: [], nextCursor: null});
    });

    it("returns the outlet and menu names, the totals and the dates for a row", async () => {
      const [orderId] = await seedOrders([{
        organizationId: orgA.organizationId,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        createdAt: minutesAfterBase(1),
        status: "confirmed",
        paymentStatus: "paid",
        items: [
          {itemId: "i1", name: "Chicken Biriyani", priceInPaise: 12000, quantity: 2},
          {itemId: "i2", name: "Veg Meals", priceInPaise: 6000, quantity: 1},
        ],
      }]);

      const [row] = pageOf(await callList(orgA.organizationId, acceptingValidator(orgA.ownerId))).orders;

      expect(row).toMatchObject({
        id: orderId,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        outlet: {name: orgA.outletName},
        status: "confirmed",
        paymentStatus: "paid",
        currency: "INR",
        subtotalInPaise: 30000,
        totalInPaise: 30000,
        itemCount: 3,
        items: [{name: "Chicken Biriyani", quantity: 2}, {name: "Veg Meals", quantity: 1}],
        moreItemLines: 0,
        createdAt: minutesAfterBase(1).toDate().toISOString(),
      });
      expect(row.menu?.title).toMatch(/^Test Menu /);
    });

    it("omits the outlet/menu names, rather than failing, when those documents do not exist", async () => {
      const [orderId] = await seedOrders([{
        organizationId: orgA.organizationId,
        outletId: orgA.outletId,
        menuId: `ghost-menu-${randomUUID()}`,
        createdAt: minutesAfterBase(1),
      }]);

      const [row] = pageOf(await callList(orgA.organizationId, acceptingValidator(orgA.ownerId))).orders;

      expect(row.id).toBe(orderId);
      expect(row.outlet).toEqual({name: orgA.outletName});
      expect(row).not.toHaveProperty("menu");
    });

    it("lists at most 10 item lines and counts the omitted ones in moreItemLines", async () => {
      await seedOrders([{
        organizationId: orgA.organizationId,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        createdAt: minutesAfterBase(1),
        items: Array.from({length: 13}, (_unused, i) => (
          {itemId: `i${i + 1}`, name: `Dish ${i + 1}`, priceInPaise: 1000, quantity: 2}
        )),
      }]);

      const [row] = pageOf(await callList(orgA.organizationId, acceptingValidator(orgA.ownerId))).orders;

      expect(row.items).toHaveLength(10);
      expect(row.items[0]).toEqual({name: "Dish 1", quantity: 2});
      expect(row.items[9]).toEqual({name: "Dish 10", quantity: 2});
      expect(row.moreItemLines).toBe(3);
      expect(row.itemCount).toBe(26);
    });

    it("exposes no customer identity, organization id, provider data or per-line prices", async () => {
      const customerId = `U-customer-${randomUUID()}`;
      const providerOrderId = `order_secret_${randomUUID()}`;
      const providerPaymentId = `pay_secret_${randomUUID()}`;
      const [orderId] = await seedOrders([{
        userId: customerId,
        organizationId: orgA.organizationId,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        createdAt: minutesAfterBase(1),
        status: "confirmed",
        paymentStatus: "paid",
        items: [{itemId: "item-secret-id", name: "Masala Dosa", priceInPaise: 7777, quantity: 1}],
      }]);
      // A payment document with provider identifiers, exactly where the real one lives.
      const paymentRef = db
        .collection("organizations").doc(orgA.organizationId)
        .collection("outlets").doc(orgA.outletId)
        .collection("menus").doc(orgA.menuId)
        .collection("orders").doc(orderId)
        .collection("payments").doc(orderId);
      seededRefs.push(paymentRef);
      await paymentRef.set({
        id: orderId, orderId, userId: customerId, organizationId: orgA.organizationId,
        outletId: orgA.outletId, menuId: orgA.menuId, amountInPaise: 7777, currency: "INR",
        status: "succeeded", provider: "razorpay", providerOrderId, providerPaymentId,
        createdAt: new Date(), updatedAt: new Date(),
      });

      const result = await callList(orgA.organizationId, acceptingValidator(orgA.ownerId));
      // What actually goes over the wire: the envelope's body, not the in-process
      // `ApiResult` (which also carries the caller's own `userId`, for logging only).
      const serialized = JSON.stringify(toResponseBody(result, "test-request"));
      const [row] = pageOf(result).orders;

      expect(Object.keys(row).sort()).toEqual([
        "createdAt", "currency", "id", "itemCount", "items", "menu", "menuId", "moreItemLines", "outlet",
        "outletId", "paymentStatus", "status", "subtotalInPaise", "totalInPaise", "updatedAt",
      ]);
      expect(serialized).not.toContain(customerId);
      expect(serialized).not.toContain(providerOrderId);
      expect(serialized).not.toContain(providerPaymentId);
      expect(serialized).not.toContain("item-secret-id");
      expect(serialized).not.toContain("razorpay");
      expect(serialized).not.toContain("userId");
      expect(serialized).not.toContain("organizationId");
      expect(serialized).not.toContain("priceInPaise");
      expect(serialized).not.toContain(orgA.organizationId);
    });

    it("shows an order as it was placed, even after the menu item is renamed and repriced", async () => {
      const ownerId = freshUserId();
      const {organization} = await createOrganization(db, ownerId, freshOrgInput());
      const outlet = await createOutlet(db, organization.id, ownerId, freshOutletInput("Live Canteen"));
      const menu = await createDraftMenu(organization.id, outlet.id, ownerId);
      const item = await createMenuItem(db, organization.id, outlet.id, menu.id, ownerId, {
        name: "Original Dish", priceInPaise: 12000, displayOrder: 1,
      });
      await publishTracked(organization.id, outlet.id, menu.id);
      const customerId = freshUserId();
      const {order} = await createOrder(db, customerId, {
        outletId: outlet.id, menuId: menu.id, items: [{itemId: item.id, quantity: 3}],
        idempotencyKey: randomUUID(),
      });
      seededRefs.push(
        db.collection("organizations").doc(organization.id)
          .collection("outlets").doc(outlet.id)
          .collection("menus").doc(menu.id)
          .collection("orders").doc(order.id),
      );
      await updateMenuItem(db, organization.id, outlet.id, menu.id, item.id, {name: "Renamed Dish", priceInPaise: 99900});

      const [row] = pageOf(await callList(organization.id, acceptingValidator(ownerId))).orders;

      expect(row.id).toBe(order.id);
      expect(row.items).toEqual([{name: "Original Dish", quantity: 3}]);
      expect(row.totalInPaise).toBe(36000);
      expect(row.status).toBe("pending_payment");
      expect(JSON.stringify(row)).not.toContain(customerId);
    });
  });

  describe("pagination", () => {
    it("walks newest-first pages with no skips and no duplicates, ending with a null cursor", async () => {
      const ids = await seedA(7);
      const expected = [...ids].reverse();

      const pages = await walkAll(orgA.organizationId, acceptingValidator(staffA), {limit: "3"});

      expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
      expect(pages.flat()).toEqual(expected);
    });

    it("has no further page when the last page is exactly full", async () => {
      await seedA(4);

      const first = pageOf(await callList(orgA.organizationId, acceptingValidator(staffA), {limit: "2"}));
      const second = pageOf(await callList(
        orgA.organizationId, acceptingValidator(staffA), {limit: "2", cursor: first.nextCursor},
      ));

      expect(first.nextCursor).not.toBeNull();
      expect(second.orders).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
    });

    it("never skips or repeats orders that share the exact same createdAt", async () => {
      const sameInstant = minutesAfterBase(5);
      const ids = await seedOrders(Array.from({length: 5}, () => ({
        organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId, createdAt: sameInstant,
      })));

      const pages = await walkAll(orgA.organizationId, acceptingValidator(managerA), {limit: "2"});
      const seen = pages.flat();

      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...ids].sort());
    });

    it("defaults to 20 per page and caps any requested limit at 50, however large", async () => {
      await seedA(52);
      const validator = acceptingValidator(orgA.ownerId);

      const byDefault = pageOf(await callList(orgA.organizationId, validator));
      const huge = pageOf(await callList(orgA.organizationId, validator, {limit: "1000"}));
      const exactlyMax = pageOf(await callList(orgA.organizationId, validator, {limit: "50"}));

      expect(byDefault.orders).toHaveLength(20);
      expect(byDefault.nextCursor).not.toBeNull();
      expect(huge.orders).toHaveLength(50);
      expect(huge.nextCursor).not.toBeNull();
      expect(exactlyMax.orders).toHaveLength(50);

      const rest = pageOf(await callList(orgA.organizationId, validator, {limit: "1000", cursor: huge.nextCursor}));
      expect(rest.orders).toHaveLength(2);
      expect(rest.nextCursor).toBeNull();
      expect(new Set([...huge.orders, ...rest.orders].map((order) => order.id)).size).toBe(52);
    });

    it("rejects limits that are not positive integers (400)", async () => {
      for (const limit of ["0", "-1", "1.5", "abc"]) {
        const result = await callList(orgA.organizationId, acceptingValidator(orgA.ownerId), {limit});
        expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
      }
    });

    it("keeps every filtered page inside the selected outlet", async () => {
      const mainIds = await seedOrders(Array.from({length: 5}, (_unused, i) => ({
        organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId,
        createdAt: minutesAfterBase(i * 2 + 1),
      })));
      const annexIds = await seedOrders(Array.from({length: 5}, (_unused, i) => ({
        organizationId: orgA.organizationId, outletId: orgA.inactiveOutletId, menuId: orgA.inactiveMenuId,
        createdAt: minutesAfterBase(i * 2 + 2),
      })));

      const mainPages = await walkAll(orgA.organizationId, acceptingValidator(staffA), {
        outletId: orgA.outletId, limit: "2",
      });
      const annexPages = await walkAll(orgA.organizationId, acceptingValidator(staffA), {
        outletId: orgA.inactiveOutletId, limit: "2",
      });

      expect(mainPages.flat()).toEqual([...mainIds].reverse());
      expect(annexPages.flat()).toEqual([...annexIds].reverse());
    });

    describe("cursor scope", () => {
      it("rejects (400) a cursor taken from another organization's list, returning nothing", async () => {
        await seedA(3);
        await seedOrders(Array.from({length: 3}, (_unused, i) => ({
          organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId,
          createdAt: minutesAfterBase(i + 1),
        })));
        const bFirst = pageOf(await callList(orgB.organizationId, acceptingValidator(orgB.ownerId), {limit: "1"}));
        expect(bFirst.nextCursor).not.toBeNull();

        const result = await callList(
          orgA.organizationId, acceptingValidator(orgA.ownerId), {cursor: bFirst.nextCursor},
        );

        expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument", message: "Invalid cursor."});
      });

      it("rejects (400) a forged cursor that names another organization's order document", async () => {
        const [bOrder] = await seedOrders([
          {organizationId: orgB.organizationId, outletId: orgB.outletId, menuId: orgB.menuId, createdAt: minutesAfterBase(1)},
        ]);
        const path = `organizations/${orgB.organizationId}/outlets/${orgB.outletId}/menus/${orgB.menuId}/orders/${bOrder}`;
        const forged = Buffer.from(
          JSON.stringify({s: Math.floor(BASE_MILLIS / 1000) + 3600, n: 0, p: path}), "utf8",
        ).toString("base64url");

        const result = await callList(orgA.organizationId, acceptingValidator(orgA.ownerId), {cursor: forged});

        expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
      });

      it("rejects (400) a cursor from another outlet once an outlet filter is active, never widening the filter", async () => {
        await seedOrders([
          {organizationId: orgA.organizationId, outletId: orgA.outletId, menuId: orgA.menuId, createdAt: minutesAfterBase(1)},
          {organizationId: orgA.organizationId, outletId: orgA.inactiveOutletId, menuId: orgA.inactiveMenuId,
            createdAt: minutesAfterBase(2)},
          {organizationId: orgA.organizationId, outletId: orgA.inactiveOutletId, menuId: orgA.inactiveMenuId,
            createdAt: minutesAfterBase(3)},
        ]);
        const validator = acceptingValidator(orgA.ownerId);
        // The unfiltered listing's first cursor points at an ANNEX order.
        const unfiltered = pageOf(await callList(orgA.organizationId, validator, {limit: "1"}));
        expect(unfiltered.nextCursor).not.toBeNull();

        const result = await callList(
          orgA.organizationId, validator, {outletId: orgA.outletId, cursor: unfiltered.nextCursor},
        );

        expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument", message: "Invalid cursor."});
      });

      it("rejects (400) garbage and structurally invalid cursors", async () => {
        const validator = acceptingValidator(orgA.ownerId);
        const wrongShape = Buffer.from(JSON.stringify({s: 1, n: 0, p: "orders/not-a-real-path"}), "utf8").toString("base64url");

        for (const cursor of ["not a cursor!", "e30", wrongShape]) {
          const result = await callList(orgA.organizationId, validator, {cursor});
          expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument", message: "Invalid cursor."});
        }
      });

      it("accepts a cursor issued by this same filtered listing", async () => {
        await seedA(4);

        const first = pageOf(await callList(
          orgA.organizationId, acceptingValidator(orgA.ownerId), {outletId: orgA.outletId, limit: "2"},
        ));
        const second = await callList(
          orgA.organizationId, acceptingValidator(orgA.ownerId),
          {outletId: orgA.outletId, limit: "2", cursor: first.nextCursor},
        );

        expect(second).toMatchObject({kind: "success", status: 200});
        expect(pageOf(second).orders).toHaveLength(2);
      });
    });
  });
});

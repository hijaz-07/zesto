// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {
  createMenuItem,
  updateMenuItem,
  type CreateMenuItemInput,
  type MenuItem,
} from "../domain/menuItems";
import {archiveMenu, createMenu, publishMenu, type Menu} from "../domain/menus";
import {createOrganization} from "../domain/organizations";
import {createOutlet, updateOutlet} from "../domain/outlets";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createOrderRoutes} from "./orders";

/**
 * These tests exercise the order routes against a REAL Firestore emulator —
 * the same reason `menuItems.emulator.test.ts`/`menus.emulator.test.ts`
 * exist: to prove real transaction semantics (the idempotency
 * check-and-create, and the menu/item reads that feed it), the real
 * collection-group lookups `resolveOutletForOrder`/`getOwnedOrder` perform,
 * tenant/customer isolation, and concurrency. Descope stays faked. The
 * parent organization/outlet/menu/item chain is set up directly via their
 * own domain functions (already proven by their own emulator suites), not
 * via HTTP — matching this file's siblings' established convention.
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

function freshItemInput(overrides: Partial<CreateMenuItemInput> = {}): CreateMenuItemInput {
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

interface CreateMenuOptions {
  /** Defaults to 2 hours ago — i.e. ordering already open. */
  orderingOpensAt?: Date;
  /** Defaults to 1 hour from now — i.e. ordering still open. */
  orderingClosesAt?: Date;
}

/** Creates a real, valid DRAFT menu directly via the Menu domain layer,
 * matching `menuItems.emulator.test.ts`'s identical `setupMenu` helper —
 * `createMenu` performs no schedule-relation validation itself (only the
 * HTTP route's Zod schema does), so this can freely construct schedules a
 * real request body would never be allowed to submit (e.g. an already-closed
 * ordering window), which is exactly what several rejection tests below need. */
async function createDraftMenu(
  organizationId: string,
  outletId: string,
  ownerId: string,
  options: CreateMenuOptions = {},
): Promise<Menu> {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  const orderingOpensAt = options.orderingOpensAt ?? new Date(now - 2 * 60 * 60 * 1000);
  const orderingClosesAt = options.orderingClosesAt ?? new Date(now + 60 * 60 * 1000);
  return createMenu(db, organizationId, outletId, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(orderingOpensAt),
    orderingClosesAt: Timestamp.fromDate(orderingClosesAt),
    pickupStartsAt: Timestamp.fromDate(new Date(tomorrow)),
    pickupEndsAt: Timestamp.fromDate(new Date(tomorrow + 4 * 60 * 60 * 1000)),
  });
}

async function addItem(
  organizationId: string,
  outletId: string,
  menuId: string,
  ownerId: string,
  overrides: Partial<CreateMenuItemInput> = {},
): Promise<MenuItem> {
  return createMenuItem(db, organizationId, outletId, menuId, ownerId, freshItemInput(overrides));
}

/** Org + owner + active outlet + a PUBLISHED menu (ordering open) + one
 * enabled item — the common happy-path fixture most tests build on. */
async function setupPublishedMenuWithItem(itemOverrides: Partial<CreateMenuItemInput> = {}) {
  const {organizationId, ownerId} = await setupOrgWithOwner();
  const {outletId} = await setupOutlet(organizationId, ownerId);
  const menu = await createDraftMenu(organizationId, outletId, ownerId);
  const item = await addItem(organizationId, outletId, menu.id, ownerId, itemOverrides);
  await publishMenu(db, organizationId, outletId, menu.id);
  return {organizationId, ownerId, outletId, menuId: menu.id, item};
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

async function callCreate(validator: SessionValidator, body: unknown): Promise<ApiResult> {
  const routes = createOrderRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "POST", path: "/orders", body}),
    () => {},
  );
}

async function callGet(validator: SessionValidator, orderId: string): Promise<ApiResult> {
  const routes = createOrderRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "GET", path: `/orders/${orderId}`}),
    () => {},
  );
}

interface OrderResponseShape {
  id: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  status: string;
  paymentStatus: string;
  currency: string;
  subtotalInPaise: number;
  totalInPaise: number;
  items: Array<{itemId: string; name: string; priceInPaise: number; quantity: number; lineTotalInPaise: number}>;
  createdAt: string;
  updatedAt: string;
}

function orderOf(result: ApiResult): OrderResponseShape {
  if (result.kind !== "success") throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return (result.data as {order: OrderResponseShape}).order;
}

describe("POST /orders — success (Firestore emulator)", () => {
  it("creates an order with correct snapshots, subtotal, total, and initial status", async () => {
    const {organizationId, ownerId, outletId, menuId, item: itemA} =
      await setupPublishedMenuWithItem({name: "Chicken Biriyani", priceInPaise: 7500});
    const itemB = await addItem(organizationId, outletId, menuId, ownerId, {name: "Veg Biriyani", priceInPaise: 6000});
    const customerId = freshUserId();

    const result = await callCreate(acceptingValidator(customerId), {
      outletId, menuId,
      items: [{itemId: itemA.id, quantity: 2}, {itemId: itemB.id, quantity: 1}],
      idempotencyKey: "success-key",
    });

    expect(result).toMatchObject({kind: "success", status: 201});
    const order = orderOf(result);
    expect(order.organizationId).toBe(organizationId);
    expect(order.outletId).toBe(outletId);
    expect(order.menuId).toBe(menuId);
    expect(order.status).toBe("pending_payment");
    expect(order.paymentStatus).toBe("pending");
    expect(order.currency).toBe("INR");
    expect(order.items).toHaveLength(2);
    expect(order.items.find((i) => i.itemId === itemA.id)).toMatchObject({
      name: "Chicken Biriyani", priceInPaise: 7500, quantity: 2, lineTotalInPaise: 15000,
    });
    expect(order.items.find((i) => i.itemId === itemB.id)).toMatchObject({
      name: "Veg Biriyani", priceInPaise: 6000, quantity: 1, lineTotalInPaise: 6000,
    });
    expect(order.subtotalInPaise).toBe(21000);
    expect(order.totalInPaise).toBe(21000);
    expect(order).not.toHaveProperty("userId");

    const stored = await db.collectionGroup("orders").where("id", "==", order.id).get();
    expect(stored.size).toBe(1);
    expect(stored.docs[0].data()).toMatchObject({
      userId: customerId, subtotalInPaise: 21000, totalInPaise: 21000, status: "pending_payment", paymentStatus: "pending",
    });
  });

  it("two concurrent creates with different idempotencyKeys both succeed as distinct orders", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const validator = acceptingValidator(freshUserId());

    const [resultA, resultB] = await Promise.all([
      callCreate(validator, {outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "key-a"}),
      callCreate(validator, {outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "key-b"}),
    ]);

    expect(resultA.status).toBe(201);
    expect(resultB.status).toBe(201);
    expect(orderOf(resultA).id).not.toBe(orderOf(resultB).id);
  });
});

describe("POST /orders — rejections (Firestore emulator)", () => {
  it("unauthenticated (401)", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();

    const result = await callCreate(rejectingValidator(), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("malformed outletId/menuId/itemId are rejected as 400, never reaching Firestore as an unintended nested path", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const validator = acceptingValidator(freshUserId());

    const badOutlet = await callCreate(validator, {
      outletId: "a/b", menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k1",
    });
    expect(badOutlet).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});

    const badMenu = await callCreate(validator, {
      outletId, menuId: "..", items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k2",
    });
    expect(badMenu).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});

    const badItem = await callCreate(validator, {
      outletId, menuId, items: [{itemId: "a/b", quantity: 1}], idempotencyKey: "k3",
    });
    expect(badItem).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("nonexistent outlet (404)", async () => {
    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId: "no-such-outlet", menuId: "no-such-menu", items: [{itemId: "item-1", quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("inactive outlet (400)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupInactiveOutlet(organizationId, ownerId);
    const menu = await createDraftMenu(organizationId, outletId, ownerId);
    const item = await addItem(organizationId, outletId, menu.id, ownerId);
    await publishMenu(db, organizationId, outletId, menu.id);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId: menu.id, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("nonexistent menu under a real, active outlet (404)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId: "no-such-menu", items: [{itemId: "item-1", quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a menu belonging to a different outlet is treated as not found (404)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId: outletA} = await setupOutlet(organizationId, ownerId);
    const {outletId: outletB} = await setupOutlet(organizationId, ownerId);
    const menuA = await createDraftMenu(organizationId, outletA, ownerId);
    const item = await addItem(organizationId, outletA, menuA.id, ownerId);
    await publishMenu(db, organizationId, outletA, menuA.id);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId: outletB, menuId: menuA.id, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a draft menu is rejected (400)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const menu = await createDraftMenu(organizationId, outletId, ownerId);
    const item = await addItem(organizationId, outletId, menu.id, ownerId);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId: menu.id, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("an archived menu is rejected (400)", async () => {
    const {organizationId, outletId, menuId, item} = await setupPublishedMenuWithItem();
    await archiveMenu(db, organizationId, outletId, menuId);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("ordering not yet open is rejected (400)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const now = Date.now();
    const menu = await createDraftMenu(organizationId, outletId, ownerId, {
      orderingOpensAt: new Date(now + 2 * 60 * 60 * 1000),
      orderingClosesAt: new Date(now + 3 * 60 * 60 * 1000),
    });
    const item = await addItem(organizationId, outletId, menu.id, ownerId);
    await publishMenu(db, organizationId, outletId, menu.id);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId: menu.id, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("ordering already closed is rejected (400)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const {outletId} = await setupOutlet(organizationId, ownerId);
    const now = Date.now();
    const menu = await createDraftMenu(organizationId, outletId, ownerId, {
      orderingOpensAt: new Date(now - 2 * 60 * 60 * 1000),
      orderingClosesAt: new Date(now - 60 * 60 * 1000),
    });
    const item = await addItem(organizationId, outletId, menu.id, ownerId);
    await publishMenu(db, organizationId, outletId, menu.id);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId: menu.id, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("a nonexistent item is rejected (404)", async () => {
    const {outletId, menuId} = await setupPublishedMenuWithItem();

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: "no-such-item", quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("an item belonging to a different menu is rejected (404)", async () => {
    const {organizationId, ownerId, outletId, menuId} = await setupPublishedMenuWithItem();
    const menuB = await createDraftMenu(organizationId, outletId, ownerId);
    const itemInB = await addItem(organizationId, outletId, menuB.id, ownerId);

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: itemInB.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a disabled item is rejected (400)", async () => {
    const {organizationId, outletId, menuId, item} = await setupPublishedMenuWithItem();
    await updateMenuItem(db, organizationId, outletId, menuId, item.id, {enabled: false});

    const result = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "k",
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("ignores tampered client-supplied price/subtotal/total/userId/organizationId, computing everything server-side", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem({priceInPaise: 5000});
    const customerId = freshUserId();

    const result = await callCreate(acceptingValidator(customerId), {
      outletId, menuId,
      items: [{itemId: item.id, quantity: 3, priceInPaise: 1, lineTotalInPaise: 1}],
      idempotencyKey: "tamper-key",
      organizationId: "org-attacker",
      userId: "U-attacker",
      subtotalInPaise: 1,
      totalInPaise: 1,
      currency: "USD",
      status: "confirmed",
      paymentStatus: "paid",
    });

    expect(result).toMatchObject({kind: "success", status: 201});
    const order = orderOf(result);
    expect(order.subtotalInPaise).toBe(15000);
    expect(order.totalInPaise).toBe(15000);
    expect(order.currency).toBe("INR");
    expect(order.status).toBe("pending_payment");
    expect(order.paymentStatus).toBe("pending");
    expect(order.items[0].priceInPaise).toBe(5000);

    // The order actually belongs to the authenticated customer, never the
    // attacker-supplied userId.
    const asOwner = await callGet(acceptingValidator(customerId), order.id);
    expect(asOwner).toMatchObject({kind: "success", status: 200});
    const asAttacker = await callGet(acceptingValidator("U-attacker"), order.id);
    expect(asAttacker).toMatchObject({kind: "error", status: 404});
  });
});

describe("Order item snapshot behavior (Firestore emulator)", () => {
  it("preserves the item name/price at order time even after the menu item is changed afterward", async () => {
    const {organizationId, outletId, menuId, item} =
      await setupPublishedMenuWithItem({name: "Original Name", priceInPaise: 10000});
    const customerId = freshUserId();

    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 2}], idempotencyKey: "snap-key",
    });
    expect(created).toMatchObject({kind: "success", status: 201});
    const order = orderOf(created);
    expect(order.items[0]).toMatchObject({name: "Original Name", priceInPaise: 10000, lineTotalInPaise: 20000});

    await updateMenuItem(db, organizationId, outletId, menuId, item.id, {
      name: "Renamed Item", priceInPaise: 99999,
    });

    const reread = orderOf(await callGet(acceptingValidator(customerId), order.id));
    expect(reread.items[0]).toMatchObject({name: "Original Name", priceInPaise: 10000, lineTotalInPaise: 20000});
    expect(reread.subtotalInPaise).toBe(20000);
  });
});

describe("Idempotency (Firestore emulator)", () => {
  it("same user + same idempotencyKey twice creates only one order; both calls resolve consistently", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const validator = acceptingValidator(freshUserId());
    const body = {outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "repeat-key"};

    const first = await callCreate(validator, body);
    const second = await callCreate(validator, body);

    expect(first).toMatchObject({kind: "success", status: 201});
    expect(second).toMatchObject({kind: "success", status: 200});
    const firstId = orderOf(first).id;
    expect(orderOf(second).id).toBe(firstId);

    const stored = await db.collectionGroup("orders").where("id", "==", firstId).get();
    expect(stored.size).toBe(1);
  });

  it("a different user with the same idempotencyKey does not access the first user's order", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const body = {outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "shared-key"};

    const resultA = await callCreate(acceptingValidator(freshUserId()), body);
    const resultB = await callCreate(acceptingValidator(freshUserId()), body);

    expect(resultA).toMatchObject({kind: "success", status: 201});
    expect(resultB).toMatchObject({kind: "success", status: 201});
    expect(orderOf(resultA).id).not.toBe(orderOf(resultB).id);
  });

  it("reusing the same idempotencyKey for a different logical request is rejected (409)", async () => {
    const {organizationId, ownerId, outletId, menuId, item} = await setupPublishedMenuWithItem();
    const item2 = await addItem(organizationId, outletId, menuId, ownerId);
    const validator = acceptingValidator(freshUserId());

    const first = await callCreate(validator, {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "reused-key",
    });
    const second = await callCreate(validator, {
      outletId, menuId, items: [{itemId: item2.id, quantity: 1}], idempotencyKey: "reused-key",
    });

    expect(first).toMatchObject({kind: "success", status: 201});
    expect(second).toMatchObject({kind: "error", status: 409, code: "already_exists"});
  });

  // Explicit timeout, matching `menuItems.emulator.test.ts`'s identical
  // concurrent-transaction test: comfortably inside vitest's 5000ms default
  // in isolation, but transaction retries occasionally run long enough to
  // miss it when the full suite shares one emulator instance.
  it("concurrent requests with the same user + idempotencyKey create exactly one order", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const validator = acceptingValidator(freshUserId());
    const body = {outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "concurrent-key"};

    const [resultA, resultB] = await Promise.all([
      callCreate(validator, body),
      callCreate(validator, body),
    ]);

    expect([resultA.status, resultB.status].sort()).toEqual([200, 201]);
    const idA = orderOf(resultA).id;
    const idB = orderOf(resultB).id;
    expect(idA).toBe(idB);

    const stored = await db.collectionGroup("orders").where("id", "==", idA).get();
    expect(stored.size).toBe(1);
  }, 15000);
});

describe("GET /orders/:orderId (Firestore emulator)", () => {
  it("returns the caller's own order", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "get-key",
    });
    const orderId = orderOf(created).id;

    const result = await callGet(acceptingValidator(customerId), orderId);

    expect(result).toMatchObject({kind: "success", status: 200});
    expect(orderOf(result).id).toBe(orderId);
  });

  it("denies a different customer (404)", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const created = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "own-key",
    });
    const orderId = orderOf(created).id;

    const result = await callGet(acceptingValidator(freshUserId()), orderId);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("denies the organization's own owner and staff through this customer endpoint (404)", async () => {
    const {organizationId, ownerId, outletId, menuId, item} = await setupPublishedMenuWithItem();
    const created = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "org-key",
    });
    const orderId = orderOf(created).id;

    const ownerResult = await callGet(acceptingValidator(ownerId), orderId);
    expect(ownerResult).toMatchObject({kind: "error", status: 404});

    const staffId = freshUserId();
    await addMembership(organizationId, staffId, "staff");
    const staffResult = await callGet(acceptingValidator(staffId), orderId);
    expect(staffResult).toMatchObject({kind: "error", status: 404});
  });

  it("denies an unauthenticated caller (401)", async () => {
    const result = await callGet(rejectingValidator(), "some-order-id");
    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("returns 404, not 500, for a nonexistent order", async () => {
    const result = await callGet(acceptingValidator(freshUserId()), "no-such-order");
    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

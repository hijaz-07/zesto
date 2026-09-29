// @vitest-environment node
import {createHmac, randomUUID} from "node:crypto";
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
import {preparePayment} from "../domain/payments";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {PaymentProviderError, type PaymentProviderGateway} from "../providers/razorpay";
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
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_public_key");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "test_key_secret_for_verify");
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

interface PaymentResponseShape {
  paymentId: string;
  orderId: string;
  amountInPaise: number;
  currency: string;
  status: string;
  provider: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerKeyId?: string;
}

function paymentOf(result: ApiResult): PaymentResponseShape {
  if (result.kind !== "success") throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return (result.data as {payment: PaymentResponseShape}).payment;
}

/** A fake `PaymentProviderGateway` — this suite never calls the real
 * Razorpay API (see this checkpoint's "unit tests should mock the provider
 * abstraction" requirement; `payments.emulator.test.ts` covers the domain
 * invariants directly, this file covers the route/response wiring). */
function fakePaymentProvider(overrides: Partial<PaymentProviderGateway> = {}): PaymentProviderGateway {
  let counter = 0;
  return {
    createOrder: vi.fn(async (input) => ({
      id: `order_fake_${randomUUID()}_${++counter}`,
      amountInPaise: input.amountInPaise, currency: input.currency, receipt: input.receipt, status: "created",
    })),
    fetchOrder: vi.fn(async (providerOrderId) => (
      {id: providerOrderId, amountInPaise: 0, currency: "INR", status: "created"}
    )),
    ...overrides,
  };
}

async function callPreparePayment(
  validator: SessionValidator,
  orderId: string,
  body: unknown = undefined,
  paymentProvider: PaymentProviderGateway = fakePaymentProvider(),
): Promise<ApiResult> {
  const routes = createOrderRoutes({db, validator, paymentProvider});
  return handleRequest(
    routes,
    request({method: "POST", path: `/orders/${orderId}/payment`, body}),
    () => {},
  );
}

async function callVerifyPayment(
  validator: SessionValidator,
  orderId: string,
  body: unknown,
): Promise<ApiResult> {
  const routes = createOrderRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "POST", path: `/orders/${orderId}/payment/verify`, body}),
    () => {},
  );
}

/**
 * @param {string} providerOrderId The trusted provider order ID.
 * @param {string} razorpayPaymentId The submitted payment ID.
 * @return {string} A valid Checkout signature for these values, computed
 *   independently of `verifyCheckoutSignature`'s own implementation, using
 *   the `RAZORPAY_KEY_SECRET` this file's `beforeEach` stubs.
 */
function computeCheckoutSignature(providerOrderId: string, razorpayPaymentId: string): string {
  return createHmac("sha256", "test_key_secret_for_verify")
    .update(`${providerOrderId}|${razorpayPaymentId}`)
    .digest("hex");
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

describe("POST /orders/:orderId/payment (Firestore emulator)", () => {
  it("creates a pending payment for the order's owner, amount/currency from the order", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem({priceInPaise: 8000});
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 3}], idempotencyKey: "pay-key",
    });
    const order = orderOf(created);

    const result = await callPreparePayment(acceptingValidator(customerId), order.id);

    expect(result).toMatchObject({kind: "success", status: 201});
    const payment = paymentOf(result);
    expect(payment).toEqual({
      paymentId: order.id,
      orderId: order.id,
      amountInPaise: order.totalInPaise,
      currency: "INR",
      status: "pending",
      provider: "razorpay",
      providerOrderId: payment.providerOrderId,
      providerKeyId: "rzp_test_public_key",
    });
    expect(payment.providerOrderId).toBeTruthy();

    const stored = await db.collectionGroup("payments").where("orderId", "==", order.id).get();
    expect(stored.docs[0].data()).toMatchObject({
      status: "pending", provider: "razorpay", providerOrderId: payment.providerOrderId,
    });
  });

  it("sends the provider only amount/currency/receipt, never client-suppliable data", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem({priceInPaise: 8000});
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-fields",
    });
    const order = orderOf(created);
    const provider = fakePaymentProvider();

    await callPreparePayment(acceptingValidator(customerId), order.id, undefined, provider);

    expect(provider.createOrder).toHaveBeenCalledTimes(1);
    expect(provider.createOrder).toHaveBeenCalledWith({
      amountInPaise: order.totalInPaise, currency: "INR", receipt: order.id,
    });
  });

  it("never returns provider secrets, provider payment internals, or internal Firestore path context", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-2",
    });
    const order = orderOf(created);

    const result = await callPreparePayment(acceptingValidator(customerId), order.id);

    expect(result).toMatchObject({kind: "success"});
    const payment = paymentOf(result) as unknown as Record<string, unknown>;
    expect(payment).not.toHaveProperty("providerPaymentId");
    expect(payment).not.toHaveProperty("userId");
    expect(payment).not.toHaveProperty("organizationId");
    expect(payment).not.toHaveProperty("outletId");
    expect(payment).not.toHaveProperty("menuId");
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("test_key_secret");
  });

  it("is idempotent: a repeated call reuses the same payment AND provider order (200, not 201)", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-3",
    });
    const order = orderOf(created);
    const provider = fakePaymentProvider();

    const first = await callPreparePayment(acceptingValidator(customerId), order.id, undefined, provider);
    const second = await callPreparePayment(acceptingValidator(customerId), order.id, undefined, provider);

    expect(first).toMatchObject({kind: "success", status: 201});
    expect(second).toMatchObject({kind: "success", status: 200});
    expect(paymentOf(second)).toEqual(paymentOf(first));
    expect(provider.createOrder).toHaveBeenCalledTimes(1);

    const stored = await db.collectionGroup("payments").where("orderId", "==", order.id).get();
    expect(stored.size).toBe(1);
  });

  it("a provider failure produces a safe 503, leaves the payment pending, and a retry can still succeed", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-fail",
    });
    const order = orderOf(created);
    const failingProvider = fakePaymentProvider({
      createOrder: async () => { throw new PaymentProviderError("Razorpay order creation failed.", {statusCode: 500}); },
    });

    const failed = await callPreparePayment(acceptingValidator(customerId), order.id, undefined, failingProvider);
    expect(failed).toMatchObject({kind: "error", status: 503, code: "unavailable"});
    const failedMessage = (failed as {message: string}).message.toLowerCase();
    expect(failedMessage).not.toContain("secret");

    const afterFailure = await callGet(acceptingValidator(customerId), order.id);
    expect(orderOf(afterFailure)).toMatchObject({status: "pending_payment", paymentStatus: "pending"});

    const retried = await callPreparePayment(acceptingValidator(customerId), order.id);
    expect(retried).toMatchObject({kind: "success", status: 201});
    expect(paymentOf(retried).status).toBe("pending");
  });

  it("two concurrent prepare-payment requests settle on exactly one authoritative provider order", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-concurrent",
    });
    const order = orderOf(created);
    const provider = fakePaymentProvider();

    const [a, b] = await Promise.all([
      callPreparePayment(acceptingValidator(customerId), order.id, undefined, provider),
      callPreparePayment(acceptingValidator(customerId), order.id, undefined, provider),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(paymentOf(a).providerOrderId).toBe(paymentOf(b).providerOrderId);

    const stored = await db.collectionGroup("payments").where("orderId", "==", order.id).get();
    expect(stored.size).toBe(1);
    expect(stored.docs[0].data().providerOrderId).toBe(paymentOf(a).providerOrderId);
  });

  it("denies a different authenticated customer from preparing payment for someone else's order (404)", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const created = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-4",
    });
    const order = orderOf(created);

    const result = await callPreparePayment(acceptingValidator(freshUserId()), order.id);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("denies the organization's own owner using the customer payment endpoint as an ownership bypass (404)", async () => {
    const {organizationId, ownerId, outletId, menuId, item} = await setupPublishedMenuWithItem();
    const created = await callCreate(acceptingValidator(freshUserId()), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-5",
    });
    const order = orderOf(created);
    await addMembership(organizationId, ownerId, "owner");

    const result = await callPreparePayment(acceptingValidator(ownerId), order.id);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("rejects an unauthenticated caller (401), without touching Firestore", async () => {
    const result = await callPreparePayment(rejectingValidator(), "some-order-id");
    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("returns 404, not 500, for a nonexistent order", async () => {
    const result = await callPreparePayment(acceptingValidator(freshUserId()), "no-such-order");
    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("rejects a malformed order ID (400)", async () => {
    // ".." (not a "/"-containing value — that would just fail to match the
    // route at all, a router-level 404, before ever reaching the handler).
    const result = await callPreparePayment(acceptingValidator(freshUserId()), "..");
    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects preparing payment for an order that is not pending_payment (400)", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: "pay-key-6",
    });
    const order = orderOf(created);
    await db.collectionGroup("orders").where("id", "==", order.id).get()
      .then((snapshot) => snapshot.docs[0].ref.update({status: "cancelled"}));

    const result = await callPreparePayment(acceptingValidator(customerId), order.id);

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });
});

describe("POST /orders/:orderId/payment/verify (Firestore emulator)", () => {
  /** A real order with a real (fake-gateway) provider order already
   * attached — the fixture every test here builds on. */
  async function setupVerifiablePayment(priceInPaise = 8000) {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem({priceInPaise});
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: `verify-${randomUUID()}`,
    });
    const order = orderOf(created);
    const prepared = await callPreparePayment(acceptingValidator(customerId), order.id);
    const payment = paymentOf(prepared);
    return {order, payment, customerId};
  }

  it("verifies a valid Checkout signature: payment succeeded, order confirmed/paid (200)", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();
    const razorpayPaymentId = `pay_test_${randomUUID()}`;
    const razorpaySignature = computeCheckoutSignature(payment.providerOrderId as string, razorpayPaymentId);

    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: payment.providerOrderId, razorpayPaymentId, razorpaySignature,
    });

    expect(result).toMatchObject({kind: "success", status: 200});
    const responseOrder = orderOf(result);
    const responsePayment = paymentOf(result);
    expect(responseOrder.status).toBe("confirmed");
    expect(responseOrder.paymentStatus).toBe("paid");
    expect(responseOrder.totalInPaise).toBe(order.totalInPaise);
    expect(responsePayment.status).toBe("succeeded");
    expect(responsePayment.providerPaymentId).toBe(razorpayPaymentId);

    const reread = orderOf(await callGet(acceptingValidator(customerId), order.id));
    expect(reread).toMatchObject({status: "confirmed", paymentStatus: "paid"});
  });

  it("never leaks the key secret or internal Firestore path context in the response", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();
    const razorpayPaymentId = `pay_test_${randomUUID()}`;
    const razorpaySignature = computeCheckoutSignature(payment.providerOrderId as string, razorpayPaymentId);

    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: payment.providerOrderId, razorpayPaymentId, razorpaySignature,
    });

    expect(result).toMatchObject({kind: "success"});
    const responsePayment = paymentOf(result) as unknown as Record<string, unknown>;
    expect(responsePayment).not.toHaveProperty("userId");
    expect(responsePayment).not.toHaveProperty("organizationId");
    expect(responsePayment).not.toHaveProperty("outletId");
    expect(responsePayment).not.toHaveProperty("menuId");
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("test_key_secret_for_verify");
  });

  it("is idempotent: a repeated call with the same identifiers returns the same confirmed state (200)", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();
    const razorpayPaymentId = `pay_test_${randomUUID()}`;
    const body = {
      razorpayOrderId: payment.providerOrderId,
      razorpayPaymentId,
      razorpaySignature: computeCheckoutSignature(payment.providerOrderId as string, razorpayPaymentId),
    };

    const first = await callVerifyPayment(acceptingValidator(customerId), order.id, body);
    const second = await callVerifyPayment(acceptingValidator(customerId), order.id, body);

    expect(first).toMatchObject({kind: "success", status: 200});
    expect(second).toMatchObject({kind: "success", status: 200});
    expect(paymentOf(second)).toEqual(paymentOf(first));
  });

  it("rejects a repeat verification with a different providerPaymentId as a conflict (409)", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();
    const firstPaymentId = `pay_test_${randomUUID()}`;
    await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: payment.providerOrderId,
      razorpayPaymentId: firstPaymentId,
      razorpaySignature: computeCheckoutSignature(payment.providerOrderId as string, firstPaymentId),
    });

    const conflictingPaymentId = `pay_test_${randomUUID()}`;
    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: payment.providerOrderId,
      razorpayPaymentId: conflictingPaymentId,
      razorpaySignature: computeCheckoutSignature(payment.providerOrderId as string, conflictingPaymentId),
    });

    expect(result).toMatchObject({kind: "error", status: 409, code: "already_exists"});
  });

  it("rejects a wrong provider order ID (400), never confirming the order", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();
    const razorpayPaymentId = `pay_test_${randomUUID()}`;

    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: "order_wrong",
      razorpayPaymentId,
      razorpaySignature: computeCheckoutSignature(payment.providerOrderId as string, razorpayPaymentId),
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const reread = orderOf(await callGet(acceptingValidator(customerId), order.id));
    expect(reread.status).toBe("pending_payment");
  });

  it("rejects an invalid signature (400), never confirming the order", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();

    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: payment.providerOrderId, razorpayPaymentId: "pay_test_x", razorpaySignature: "not-valid",
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    const reread = orderOf(await callGet(acceptingValidator(customerId), order.id));
    expect(reread.status).toBe("pending_payment");
  });

  it("rejects verification when no payment has been prepared at all (404), never leaking whether a payment exists", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: `verify-none-${randomUUID()}`,
    });
    const order = orderOf(created);

    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: "order_never_created",
      razorpayPaymentId: "pay_x",
      razorpaySignature: computeCheckoutSignature("order_never_created", "pay_x"),
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("rejects verification when a payment exists but has no provider order yet (400)", async () => {
    const {outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: `verify-no-provider-${randomUUID()}`,
    });
    const order = orderOf(created);
    // Creates the internal payment record directly via the domain layer,
    // deliberately skipping ensureProviderOrder — the one route
    // (`POST /orders/{orderId}/payment`) always does both together, so this
    // "payment exists, no provider order yet" state can only be reached
    // through the domain layer directly, matching this file's established
    // convention of setting up ancestor state via domain functions.
    await preparePayment(db, customerId, order.id);

    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: "order_never_created",
      razorpayPaymentId: "pay_x",
      razorpaySignature: computeCheckoutSignature("order_never_created", "pay_x"),
    });

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("ignores client-supplied amount/currency/status/providerOrderId: they have no effect on the outcome", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();
    const razorpayPaymentId = `pay_test_${randomUUID()}`;

    const result = await callVerifyPayment(acceptingValidator(customerId), order.id, {
      razorpayOrderId: payment.providerOrderId,
      razorpayPaymentId,
      razorpaySignature: computeCheckoutSignature(payment.providerOrderId as string, razorpayPaymentId),
      amountInPaise: 1, currency: "USD", status: "succeeded", providerOrderId: "attacker-order",
    });

    expect(result).toMatchObject({kind: "success", status: 200});
    const responseOrder = orderOf(result);
    expect(responseOrder.totalInPaise).toBe(order.totalInPaise);
    expect(responseOrder.currency).toBe("INR");
  });

  it("rejects an unauthenticated caller (401), without touching Firestore", async () => {
    const result = await callVerifyPayment(rejectingValidator(), "some-order-id", {
      razorpayOrderId: "o", razorpayPaymentId: "p", razorpaySignature: "s",
    });
    expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
  });

  it("denies a different authenticated customer from verifying someone else's payment (404)", async () => {
    const {order, payment} = await setupVerifiablePayment();
    const razorpayPaymentId = `pay_test_${randomUUID()}`;

    const result = await callVerifyPayment(acceptingValidator(freshUserId()), order.id, {
      razorpayOrderId: payment.providerOrderId,
      razorpayPaymentId,
      razorpaySignature: computeCheckoutSignature(payment.providerOrderId as string, razorpayPaymentId),
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("denies the organization's own owner using this endpoint as an ownership bypass (404)", async () => {
    const {organizationId, ownerId, outletId, menuId, item} = await setupPublishedMenuWithItem();
    const customerId = freshUserId();
    const created = await callCreate(acceptingValidator(customerId), {
      outletId, menuId, items: [{itemId: item.id, quantity: 1}], idempotencyKey: `verify-owner-${randomUUID()}`,
    });
    const order = orderOf(created);
    const prepared = await callPreparePayment(acceptingValidator(customerId), order.id);
    await addMembership(organizationId, ownerId, "owner");
    const razorpayPaymentId = `pay_test_${randomUUID()}`;

    const result = await callVerifyPayment(acceptingValidator(ownerId), order.id, {
      razorpayOrderId: paymentOf(prepared).providerOrderId,
      razorpayPaymentId,
      razorpaySignature: computeCheckoutSignature(paymentOf(prepared).providerOrderId as string, razorpayPaymentId),
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("rejects a malformed order ID (400)", async () => {
    const result = await callVerifyPayment(acceptingValidator(freshUserId()), "..", {
      razorpayOrderId: "o", razorpayPaymentId: "p", razorpaySignature: "s",
    });
    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("returns 404, not 500, for a nonexistent order", async () => {
    const result = await callVerifyPayment(acceptingValidator(freshUserId()), "no-such-order", {
      razorpayOrderId: "o", razorpayPaymentId: "p", razorpaySignature: "s",
    });
    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it.each([
    ["missing razorpayPaymentId", {razorpayOrderId: "o", razorpaySignature: "s"}],
    ["missing razorpayOrderId", {razorpayPaymentId: "p", razorpaySignature: "s"}],
    ["missing razorpaySignature", {razorpayOrderId: "o", razorpayPaymentId: "p"}],
    ["empty razorpaySignature", {razorpayOrderId: "o", razorpayPaymentId: "p", razorpaySignature: ""}],
  ])("rejects an invalid body (%s) as 400", async (_label, body) => {
    const result = await callVerifyPayment(acceptingValidator(freshUserId()), "some-order-id", body);
    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("two concurrent verification calls with the same valid identifiers converge safely (200 both)", async () => {
    const {order, payment, customerId} = await setupVerifiablePayment();
    const razorpayPaymentId = `pay_test_${randomUUID()}`;
    const body = {
      razorpayOrderId: payment.providerOrderId,
      razorpayPaymentId,
      razorpaySignature: computeCheckoutSignature(payment.providerOrderId as string, razorpayPaymentId),
    };

    const [a, b] = await Promise.all([
      callVerifyPayment(acceptingValidator(customerId), order.id, body),
      callVerifyPayment(acceptingValidator(customerId), order.id, body),
    ]);

    expect(a).toMatchObject({kind: "success", status: 200});
    expect(b).toMatchObject({kind: "success", status: 200});
    const reread = orderOf(await callGet(acceptingValidator(customerId), order.id));
    expect(reread.status).toBe("confirmed");
    expect(reread.paymentStatus).toBe("paid");
  }, 15000);
});

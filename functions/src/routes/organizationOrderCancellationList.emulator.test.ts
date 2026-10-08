// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {createMenu} from "../domain/menus";
import {createOrganization} from "../domain/organizations";
import {createOutlet} from "../domain/outlets";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult} from "../http/types";
import {businessDateString} from "../time";
import {createOrderRoutes} from "./orders";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * What the ORGANIZATION'S order list (and the cancel route's own row) shows of a
 * cancellation and its refund, against a REAL Firestore emulator: the
 * cancellation really runs, and the list is read back like the dashboard reads
 * it. Proves the rows carry the operator-safe `cancellation` / `refund` blocks —
 * and nothing that identifies the actor, the reason, the payment or the provider.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

const PROJECT_ID = "demo-zesto-org-cancel-list";
const AMOUNT = 10000;

let db: Firestore;

vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this file via " +
      "`npm run test:functions-emulator` (from the repo root), which " +
      "starts the Firestore emulator first.",
    );
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

const seededOrderRefs: DocumentReference[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const ref of seededOrderRefs.splice(0)) {
    await db.recursiveDelete(ref);
  }
});

const freshUserId = (): string => `U-${randomUUID()}`;

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({jwt: "irrelevant", token: {sub: userId, aud: ["P-test"]}})),
  };
}

async function addMembership(organizationId: string, userId: string, role: string): Promise<void> {
  await db
    .collection("organizations").doc(organizationId)
    .collection("members").doc(userId)
    .set({userId, organizationId, role, status: "active", createdAt: new Date()});
}

interface OrgFixture {
  organizationId: string;
  outletId: string;
  menuId: string;
  ownerId: string;
  managerId: string;
  staffId: string;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const suffix = randomUUID();
  const {organization} = await createOrganization(db, ownerId, {name: `${label} ${suffix}`, slug: `cancel-list-${suffix}`});
  const outlet = await createOutlet(db, organization.id, ownerId, {name: `${label} Canteen`, slug: `outlet-${randomUUID()}`});
  const now = Date.now();
  const hour = 3_600_000;
  const menu = await createMenu(db, organization.id, outlet.id, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromMillis(now - 2 * hour),
    orderingClosesAt: Timestamp.fromMillis(now + hour),
    pickupStartsAt: Timestamp.fromMillis(now + 24 * hour),
    pickupEndsAt: Timestamp.fromMillis(now + 28 * hour),
  });
  const managerId = freshUserId();
  const staffId = freshUserId();
  await addMembership(organization.id, ownerId, "owner");
  await addMembership(organization.id, managerId, "manager");
  await addMembership(organization.id, staffId, "staff");
  return {organizationId: organization.id, outletId: outlet.id, menuId: menu.id, ownerId, managerId, staffId};
}

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
  providerPaymentId: string;
}

async function seedOrder(org: OrgFixture, status: string): Promise<SeededOrder> {
  const paid = status !== "pending_payment";
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(org.outletId)
    .collection("menus").doc(org.menuId)
    .collection("orders").doc();
  seededOrderRefs.push(ref);
  const customerId = freshUserId();
  const providerPaymentId = `pay_${randomUUID().slice(0, 14)}`;
  const createdAt = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId: org.menuId,
    status,
    paymentStatus: paid ? "paid" : "pending",
    currency: "INR",
    subtotalInPaise: AMOUNT,
    totalInPaise: AMOUNT,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: AMOUNT}],
    createdAt,
    updatedAt: createdAt,
  });
  await ref.collection("payments").doc(ref.id).create({
    id: ref.id,
    orderId: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId: org.menuId,
    amountInPaise: AMOUNT,
    currency: "INR",
    status: paid ? "succeeded" : "pending",
    provider: "razorpay",
    providerOrderId: `order_${randomUUID().slice(0, 14)}`,
    ...(paid ? {providerPaymentId} : {}),
    createdAt,
    updatedAt: createdAt,
  });
  return {id: ref.id, ref, customerId, providerPaymentId};
}

const request = (userId: string, method: string, path: string, body?: unknown) => ({
  validator: acceptingValidator(userId),
  call: (routes: ReturnType<typeof createOrganizationOrderRoutes>): Promise<ApiResult> =>
    handleRequest(routes, {method, path, headers: {authorization: "Bearer token"}, query: {}, body}, () => {}),
});

function orgCancel(userId: string, org: OrgFixture, orderId: string, reason: string): Promise<ApiResult> {
  const {validator, call} = request(
    userId, "POST", `/organizations/${org.organizationId}/orders/${orderId}/cancel`, {reason},
  );
  return call(createOrganizationOrderRoutes({db, validator}));
}

function customerCancel(userId: string, orderId: string): Promise<ApiResult> {
  return handleRequest(createOrderRoutes({db, validator: acceptingValidator(userId)}), {
    method: "POST",
    path: `/orders/${orderId}/cancel`,
    headers: {authorization: "Bearer token"},
    query: {},
    body: {},
  }, () => {});
}

interface Row {
  id: string;
  status: string;
  cancellation?: Record<string, unknown>;
  refund?: Record<string, unknown>;
}

async function listRows(userId: string, org: OrgFixture): Promise<Row[]> {
  const {validator, call} = request(userId, "GET", `/organizations/${org.organizationId}/orders`);
  const result = await call(createOrganizationOrderRoutes({db, validator}));
  if (result.kind !== "success") {
    throw new Error(`list failed: ${JSON.stringify(result)}`);
  }
  return (result.data as {orders: Row[]}).orders;
}

function expectNothingInternal(data: unknown, order: SeededOrder, userIds: string[]): void {
  const body = JSON.stringify(data);
  for (const leaked of [
    order.providerPaymentId, "providerPaymentId", "providerRefundId", "providerOrderId", "rfnd_", "idempotencyKey",
    "cancelledByRole", "cancellationReason", "cancelledFromStatus", "outlet_closed", "item_unavailable",
    "refundStatus", "attentionRequired", "failureCode", order.customerId, ...userIds,
  ]) {
    expect(body, leaked).not.toContain(leaked);
  }
}

describe("organization order list — cancellation and refund blocks (Firestore emulator)", () => {
  let orgA: OrgFixture;
  let orgB: OrgFixture;

  beforeAll(async () => {
    orgA = await buildOrg("Org A");
    orgB = await buildOrg("Org B");
  });

  it("an order that was never cancelled carries neither block", async () => {
    const order = await seedOrder(orgA, "confirmed");

    const row = (await listRows(orgA.ownerId, orgA)).find((r) => r.id === order.id);

    expect(row).toMatchObject({status: "confirmed"});
    expect(row).not.toHaveProperty("cancellation");
    expect(row).not.toHaveProperty("refund");
  });

  it("a paid order cancelled by an owner reads back as cancelled by the organization, with its refund in progress", async () => {
    const order = await seedOrder(orgA, "preparing");

    const cancelled = await orgCancel(orgA.ownerId, orgA, order.id, "outlet_closed");

    const fromRoute = (cancelled as {data: {order: Row}}).data.order;
    const fromList = (await listRows(orgA.ownerId, orgA)).find((r) => r.id === order.id) as Row;
    for (const row of [fromRoute, fromList]) {
      expect(row.status).toBe("cancelled");
      expect(row.cancellation).toEqual({cancelledBy: "organization", cancelledAt: expect.any(String)});
      expect(Number.isNaN(Date.parse(String(row.cancellation?.cancelledAt)))).toBe(false);
      expect(row.refund).toEqual({state: "in_progress", refundedInPaise: 0});
      expectNothingInternal(row, order, [orgA.ownerId]);
    }
    expect(fromList).toEqual(fromRoute);
  });

  it("a repeat cancellation by a manager leaves the first cancellation's row as it was", async () => {
    const order = await seedOrder(orgA, "confirmed");
    await orgCancel(orgA.ownerId, orgA, order.id, "outlet_closed");
    const before = (await listRows(orgA.ownerId, orgA)).find((r) => r.id === order.id);

    await orgCancel(orgA.managerId, orgA, order.id, "other");

    expect((await listRows(orgA.ownerId, orgA)).find((r) => r.id === order.id)).toEqual(before);
  });

  it("an unpaid order cancelled by an owner has the cancellation block and no refund block", async () => {
    const order = await seedOrder(orgA, "pending_payment");

    await orgCancel(orgA.managerId, orgA, order.id, "duplicate_order");

    const row = (await listRows(orgA.ownerId, orgA)).find((r) => r.id === order.id) as Row;
    expect(row.status).toBe("cancelled");
    expect(row.cancellation).toMatchObject({cancelledBy: "organization"});
    expect(row).not.toHaveProperty("refund");
  });

  it("an order the customer cancelled reads back as cancelled by the customer", async () => {
    const order = await seedOrder(orgA, "confirmed");

    const result = await customerCancel(order.customerId, order.id);
    expect(result).toMatchObject({kind: "success", status: 200});

    const row = (await listRows(orgA.ownerId, orgA)).find((r) => r.id === order.id) as Row;
    expect(row.cancellation).toMatchObject({cancelledBy: "customer"});
    expect(row.refund).toEqual({state: "in_progress", refundedInPaise: 0});
    expectNothingInternal(row, order, [orgA.ownerId]);
  });

  it("staff see the same cancellation and refund state as an owner", async () => {
    const order = await seedOrder(orgA, "ready");
    await orgCancel(orgA.ownerId, orgA, order.id, "item_unavailable");

    const asStaff = (await listRows(orgA.staffId, orgA)).find((r) => r.id === order.id);
    const asOwner = (await listRows(orgA.ownerId, orgA)).find((r) => r.id === order.id);

    expect(asStaff).toEqual(asOwner);
    expect(asStaff?.refund).toEqual({state: "in_progress", refundedInPaise: 0});
  });

  it("another organization's list never contains the order or its cancellation", async () => {
    const order = await seedOrder(orgA, "confirmed");
    await orgCancel(orgA.ownerId, orgA, order.id, "other");

    const rowsOfB = await listRows(orgB.ownerId, orgB);

    expect(rowsOfB.find((r) => r.id === order.id)).toBeUndefined();
    expect(JSON.stringify(rowsOfB)).not.toContain(order.id);
  });
});

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
 * `POST /orders/:orderId/cancel` and
 * `POST /organizations/:organizationId/orders/:orderId/cancel` end to end
 * against a REAL Firestore emulator: the real membership check, the real
 * cancellation transaction, and the HTTP mapping of every outcome. What the
 * transaction writes in detail is `domain/orderCancellation.emulator.test.ts`'s
 * job; this file proves what a CALLER sees, and that nothing a caller sends can
 * choose the amount, the deadline, the status or the actor.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// Own project id, like the other emulator files that write orders heavily.
const PROJECT_ID = "demo-zesto-cancellation-routes";
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

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({
      jwt: "irrelevant",
      token: {sub: userId, aud: ["P-test"]},
    })),
  };
}

async function addMembership(organizationId: string, userId: string, role: string, status = "active"): Promise<void> {
  await db
    .collection("organizations").doc(organizationId)
    .collection("members").doc(userId)
    .set({userId, organizationId, role, status, createdAt: new Date()});
}

interface OrgFixture {
  organizationId: string;
  outletId: string;
  menuId: string;
  closedMenuId: string;
  ownerId: string;
  managerId: string;
  staffId: string;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const suffix = randomUUID();
  const {organization} = await createOrganization(db, ownerId, {name: `${label} ${suffix}`, slug: `cancel-routes-${suffix}`});
  const outlet = await createOutlet(db, organization.id, ownerId, {name: `${label} Canteen`, slug: `outlet-${randomUUID()}`});
  const now = Date.now();
  const hour = 3_600_000;
  const menuInput = (opens: number, closes: number) => ({
    menuDate: businessDateString(new Date(now)),
    title: `Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromMillis(opens),
    orderingClosesAt: Timestamp.fromMillis(closes),
    pickupStartsAt: Timestamp.fromMillis(now + 24 * hour),
    pickupEndsAt: Timestamp.fromMillis(now + 28 * hour),
  });
  const open = await createMenu(db, organization.id, outlet.id, ownerId, menuInput(now - 2 * hour, now + hour));
  // createMenu validates the schedule, so close it afterwards: ordering ended an hour ago.
  const closed = await createMenu(db, organization.id, outlet.id, ownerId, menuInput(now - 4 * hour, now + hour));
  await db
    .collection("organizations").doc(organization.id)
    .collection("outlets").doc(outlet.id)
    .collection("menus").doc(closed.id)
    .update({orderingClosesAt: Timestamp.fromMillis(now - hour)});

  const managerId = freshUserId();
  const staffId = freshUserId();
  await addMembership(organization.id, ownerId, "owner");
  await addMembership(organization.id, managerId, "manager");
  await addMembership(organization.id, staffId, "staff");
  return {organizationId: organization.id, outletId: outlet.id, menuId: open.id, closedMenuId: closed.id, ownerId, managerId, staffId};
}

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
}

async function seedOrder(
  org: OrgFixture,
  status: string,
  options: {paid?: boolean; menuId?: string} = {},
): Promise<SeededOrder> {
  const menuId = options.menuId ?? org.menuId;
  const paid = options.paid ?? status !== "pending_payment";
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(org.outletId)
    .collection("menus").doc(menuId)
    .collection("orders").doc();
  seededOrderRefs.push(ref);
  const customerId = freshUserId();
  const createdAt = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId,
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
    menuId,
    amountInPaise: AMOUNT,
    currency: "INR",
    status: paid ? "succeeded" : "pending",
    provider: "razorpay",
    providerOrderId: `order_${randomUUID().slice(0, 14)}`,
    ...(paid ? {providerPaymentId: `pay_${randomUUID().slice(0, 14)}`} : {}),
    createdAt,
    updatedAt: createdAt,
  });
  return {id: ref.id, ref, customerId};
}

async function refundsOf(order: SeededOrder): Promise<Array<Record<string, unknown>>> {
  const snapshot = await order.ref.collection("payments").doc(order.id).collection("refunds").get();
  return snapshot.docs.map((doc) => doc.data());
}

/**
 * A cancelling caller's response carries no provider, payment, webhook, audit or
 * idempotency detail, and no identity (the customer's or the acting member's).
 *
 * @param {unknown} data The response's `data`.
 * @param {SeededOrder} order The order, whose customer's ID must not appear.
 * @param {string[]} extraIds More identities that must not appear.
 */
function expectNothingInternal(data: unknown, order: SeededOrder, extraIds: string[] = []): void {
  const body = JSON.stringify(data);
  for (const leaked of [
    "providerPaymentId", "providerRefundId", "providerOrderId", "pay_", "rfnd_", "evt_", "idempotencyKey",
    "refundId", "initiatedBy", "cancelledBy", "cancelledByRole", "cancellationReason", "cancelledAt", "cancelledFromStatus",
    "submitAttempts", "userId", "refundStatus", "refundedInPaise", "failureCode", "attentionRequired",
    order.customerId, `${order.id}-r`, ...extraIds,
  ]) {
    expect(body, leaked).not.toContain(leaked);
  }
}

function customerCancel(userId: string, orderId: string, body?: unknown): Promise<ApiResult> {
  return handleRequest(createOrderRoutes({db, validator: acceptingValidator(userId)}), {
    method: "POST",
    path: `/orders/${orderId}/cancel`,
    headers: {authorization: "Bearer token"},
    query: {},
    body,
  }, () => {});
}

function orgCancel(userId: string, organizationId: string, orderId: string, body?: unknown): Promise<ApiResult> {
  return handleRequest(createOrganizationOrderRoutes({db, validator: acceptingValidator(userId)}), {
    method: "POST",
    path: `/organizations/${organizationId}/orders/${orderId}/cancel`,
    headers: {authorization: "Bearer token"},
    query: {},
    body,
  }, () => {});
}

describe("order cancellation routes (Firestore emulator)", () => {
  let orgA: OrgFixture;
  let orgB: OrgFixture;

  beforeAll(async () => {
    orgA = await buildOrg("Org A");
    orgB = await buildOrg("Org B");
  });

  describe("POST /orders/:orderId/cancel", () => {
    it("cancels the caller's paid order (200): the customer-shaped order, the cancellation state and a safe refund summary", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const result = await customerCancel(order.customerId, order.id, {reason: "changed_my_mind"});

      expect(result).toMatchObject({
        kind: "success",
        status: 200,
        data: {
          order: {id: order.id, status: "cancelled", paymentStatus: "paid"},
          cancellation: {state: "cancelled", canCancel: false},
          refund: {status: "requested", amountInPaise: AMOUNT, currency: "INR"},
        },
      });
      const data = (result as {data: {refund: Record<string, unknown>}}).data;
      expect(Object.keys(data).sort()).toEqual(["cancellation", "order", "refund"]);
      expect(Object.keys(data.refund).sort()).toEqual(["amountInPaise", "currency", "initiatedAt", "status"]);
      const stored = (await refundsOf(order))[0];
      expect(data.refund.initiatedAt).toBe((stored.createdAt as Timestamp).toDate().toISOString());
      expectNothingInternal(data, order);
      expect(await refundsOf(order)).toHaveLength(1);
    });

    it("returns a processed refund's completedAt, still without any provider identifier", async () => {
      const order = await seedOrder(orgA, "confirmed");
      await order.ref.update({
        status: "cancelled",
        cancelledAt: Timestamp.now(),
        cancelledBy: order.customerId,
        cancelledByRole: "customer",
        cancelledFromStatus: "confirmed",
        refundStatus: "refunded",
        refundedInPaise: AMOUNT,
      });
      const payment = order.ref.collection("payments").doc(order.id);
      await payment.update({capturedAmountInPaise: AMOUNT, refundedAmountInPaise: AMOUNT, refundSeq: 1, refundState: "refunded"});
      const processedAt = Timestamp.fromDate(new Date("2026-09-02T08:30:00Z"));
      const refundId = `${order.id}-r1`;
      await payment.collection("refunds").doc(refundId).set({
        id: refundId,
        paymentId: order.id,
        orderId: order.id,
        organizationId: orgA.organizationId,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        userId: order.customerId,
        providerPaymentId: "pay_secret_1",
        amountInPaise: AMOUNT,
        currency: "INR",
        status: "processed",
        reason: "customer_cancelled",
        source: "cancellation",
        initiatedBy: order.customerId,
        initiatedByRole: "customer",
        idempotencyKey: refundId,
        providerRefundId: "rfnd_secret_1",
        providerStatus: "processed",
        submitAttempts: 1,
        createdAt: Timestamp.fromDate(new Date("2026-09-01T06:00:00Z")),
        updatedAt: processedAt,
        processedAt,
        attentionRequired: false,
        lastWebhookEventKey: "evt_secret_1",
      });

      const result = await customerCancel(order.customerId, order.id);

      const data = (result as {data: Record<string, unknown>}).data;
      expect(result).toMatchObject({kind: "success", status: 200});
      expect(data.refund).toEqual({
        status: "processed",
        amountInPaise: AMOUNT,
        currency: "INR",
        initiatedAt: "2026-09-01T06:00:00.000Z",
        completedAt: "2026-09-02T08:30:00.000Z",
      });
      expectNothingInternal(data, order);
    });

    it("cancels an unpaid order with no body at all, and creates no refund", async () => {
      const order = await seedOrder(orgA, "pending_payment");

      const result = await customerCancel(order.customerId, order.id);

      expect(result).toMatchObject({
        kind: "success",
        status: 200,
        data: {order: {status: "cancelled", paymentStatus: "pending"}, cancellation: {state: "cancelled", canCancel: false}},
      });
      // No money was captured, so there is no refund to summarize: the key is absent.
      expect((result as {data: object}).data).not.toHaveProperty("refund");
      expect(await refundsOf(order)).toEqual([]);
    });

    it("answers a repeat with the same 200 and changes nothing", async () => {
      const order = await seedOrder(orgA, "confirmed");
      const first = await customerCancel(order.customerId, order.id, {reason: "changed_my_mind"});
      const before = (await order.ref.get()).data();

      const again = await customerCancel(order.customerId, order.id, {reason: "other"});

      expect(again).toMatchObject({
        kind: "success",
        status: 200,
        data: {
          order: {status: "cancelled"},
          cancellation: {state: "cancelled", canCancel: false},
          refund: {status: "requested", amountInPaise: AMOUNT},
        },
      });
      // The same refund summary the cancelling call returned.
      expect((again as {data: {refund: unknown}}).data.refund).toEqual((first as {data: {refund: unknown}}).data.refund);
      expect((await order.ref.get()).data()).toEqual(before);
      expect(await refundsOf(order)).toHaveLength(1);
    });

    it("ignores everything the client says about money, deadlines, status and identity", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const result = await customerCancel(order.customerId, order.id, {
        reason: "changed_my_mind",
        amountInPaise: 1,
        refundAmountInPaise: 1,
        refund: {amountInPaise: 1},
        status: "preparing",
        userId: "U-someone-else",
        organizationId: orgB.organizationId,
        orderingClosesAt: "2999-01-01T00:00:00Z",
        cancelledBy: "U-someone-else",
      });

      expect(result).toMatchObject({kind: "success", status: 200});
      const refunds = await refundsOf(order);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({amountInPaise: AMOUNT, initiatedBy: order.customerId});
      expect((await order.ref.get()).data()).toMatchObject({cancelledBy: order.customerId, cancelledByRole: "customer"});
    });

    it("answers another customer's order exactly like a missing one (404), before and after it is cancelled", async () => {
      const order = await seedOrder(orgA, "confirmed");
      const stranger = freshUserId();

      const live = await customerCancel(stranger, order.id, {reason: "changed_my_mind"});
      await customerCancel(order.customerId, order.id);
      const cancelled = await customerCancel(stranger, order.id, {reason: "changed_my_mind"});
      const missing = await customerCancel(stranger, "no-such-order", {reason: "changed_my_mind"});

      for (const result of [live, cancelled, missing]) {
        expect(result).toMatchObject({kind: "error", status: 404, code: "not_found", message: "Order not found."});
      }
    });

    it("does not let an organization's own owner cancel through the customer route (404)", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const result = await customerCancel(orgA.ownerId, order.id);

      expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
      expect((await order.ref.get()).data()?.status).toBe("confirmed");
    });

    it("refuses an invalid reason (400), including an organization's reason", async () => {
      const order = await seedOrder(orgA, "confirmed");

      for (const reason of ["item_unavailable", "nonsense", 7, null, {}]) {
        const result = await customerCancel(order.customerId, order.id, {reason});
        expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
      }
      expect((await order.ref.get()).data()?.status).toBe("confirmed");
    });

    it.each([
      ["preparing", "already being prepared"],
      ["ready", "ready for pickup"],
      ["picked_up", "already been picked up"],
      ["completed", "already been completed"],
    ])("refuses a %s order as a 409 conflict", async (status, message) => {
      const order = await seedOrder(orgA, status);

      const result = await customerCancel(order.customerId, order.id);

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict"});
      expect((result as {message: string}).message).toContain(message);
      expect((await order.ref.get()).data()?.status).toBe(status);
      expect(await refundsOf(order)).toEqual([]);
    });

    it("refuses a confirmed order once the menu's ordering deadline has passed (409), reading the deadline itself", async () => {
      const order = await seedOrder(orgA, "confirmed", {menuId: orgA.closedMenuId});

      const result = await customerCancel(order.customerId, order.id, {orderingClosesAt: "2999-01-01T00:00:00Z"});

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict"});
      expect((result as {message: string}).message).toMatch(/Ordering has closed/);
      expect((await order.ref.get()).data()?.status).toBe("confirmed");
      expect(await refundsOf(order)).toEqual([]);
    });
  });

  describe("POST /organizations/:organizationId/orders/:orderId/cancel", () => {
    it.each(["owner", "manager"] as const)("lets the %s cancel a preparing order (200), refunding it in full", async (role) => {
      const order = await seedOrder(orgA, "preparing");
      const userId = role === "owner" ? orgA.ownerId : orgA.managerId;

      const result = await orgCancel(userId, orgA.organizationId, order.id, {reason: "outlet_closed"});

      expect(result).toMatchObject({
        kind: "success",
        status: 200,
        data: {
          order: {id: order.id, status: "cancelled"},
          cancellation: {state: "cancelled", canCancel: false},
          refund: {status: "requested", amountInPaise: AMOUNT, currency: "INR"},
        },
      });
      const data = (result as {data: {refund: Record<string, unknown>}}).data;
      expect(Object.keys(data.refund).sort()).toEqual(["amountInPaise", "currency", "initiatedAt", "status"]);
      expectNothingInternal(data, order, [userId]);
      const refunds = await refundsOf(order);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({amountInPaise: AMOUNT, reason: "outlet_cancelled", initiatedBy: userId, initiatedByRole: "organization"});
      expect((await order.ref.get()).data()).toMatchObject({
        cancelledBy: userId, cancelledByRole: "organization", cancellationReason: "outlet_closed", cancelledFromStatus: "preparing",
      });
    });

    it("refuses staff (403) and changes nothing", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const result = await orgCancel(orgA.staffId, orgA.organizationId, order.id, {reason: "outlet_closed"});

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect((await order.ref.get()).data()?.status).toBe("confirmed");
      expect(await refundsOf(order)).toEqual([]);
    });

    it("refuses another organization's owner naming the order's organization (403) or their own (404)", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const asMemberless = await orgCancel(orgB.ownerId, orgA.organizationId, order.id, {reason: "outlet_closed"});
      const asOwnOrg = await orgCancel(orgB.ownerId, orgB.organizationId, order.id, {reason: "outlet_closed"});

      expect(asMemberless).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(asOwnOrg).toMatchObject({kind: "error", status: 404, code: "not_found"});
      expect((await order.ref.get()).data()?.status).toBe("confirmed");
      expect(await refundsOf(order)).toEqual([]);
    });

    it("refuses a customer who is not a member (403)", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const result = await orgCancel(order.customerId, orgA.organizationId, order.id, {reason: "outlet_closed"});

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });

    it("requires an organization reason (400)", async () => {
      const order = await seedOrder(orgA, "confirmed");

      for (const body of [undefined, {}, {reason: "changed_my_mind"}, {reason: "nonsense"}, {reason: 7}]) {
        const result = await orgCancel(orgA.ownerId, orgA.organizationId, order.id, body);
        expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
      }
      expect((await order.ref.get()).data()?.status).toBe("confirmed");
    });

    it("refuses an order already picked up (409 conflict)", async () => {
      const order = await seedOrder(orgA, "picked_up");

      const result = await orgCancel(orgA.ownerId, orgA.organizationId, order.id, {reason: "other"});

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict"});
    });

    it("repeats safely (200), and a stranger's repeat of a cancelled order is still refused", async () => {
      const order = await seedOrder(orgA, "confirmed");
      await orgCancel(orgA.ownerId, orgA.organizationId, order.id, {reason: "outlet_closed"});

      const again = await orgCancel(orgA.managerId, orgA.organizationId, order.id, {reason: "other"});
      const stranger = await orgCancel(orgB.ownerId, orgB.organizationId, order.id, {reason: "other"});

      expect(again).toMatchObject({kind: "success", status: 200, data: {order: {status: "cancelled"}}});
      expect(stranger).toMatchObject({kind: "error", status: 404});
      expect(await refundsOf(order)).toHaveLength(1);
      expect((await order.ref.get()).data()).toMatchObject({cancelledBy: orgA.ownerId, cancellationReason: "outlet_closed"});
    });

    it("ignores a refund amount in the body", async () => {
      const order = await seedOrder(orgA, "confirmed");

      await orgCancel(orgA.ownerId, orgA.organizationId, order.id, {reason: "outlet_closed", amountInPaise: 1, refund: {amountInPaise: 1}});

      expect((await refundsOf(order))[0]).toMatchObject({amountInPaise: AMOUNT});
    });
  });
});

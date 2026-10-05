// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import {listOwnedOrders} from "./orderHistory";
import {
  transitionOrderStatus,
  type FulfillmentTarget,
  type TransitionOrderStatusResult,
} from "./orderFulfillment";
import {getOwnedOrder, type OrderStatus} from "./orders";
import {listOrganizationOrders} from "./organizationOrders";
import {createMenu} from "./menus";
import {createOrganization} from "./organizations";
import {createOutlet, updateOutlet} from "./outlets";
import {markPaymentFailed, markPaymentSucceeded, preparePayment, verifyCheckoutPayment} from "./payments";
import {businessDateString} from "../time";

/**
 * `transitionOrderStatus` against a REAL Firestore emulator: the transaction,
 * the documents it actually writes (and the ones it must leave alone), tenant
 * scoping, concurrent callers, and — without changing any of it — that the
 * existing payment operations stay safe on an order that has moved on into
 * fulfillment. The organization/outlet/menu chain is built through the domain
 * functions; orders are written directly with the exact shape `createOrder`
 * writes, in whatever state a test needs.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own, not the one every other emulator suite
// shares. The emulator keeps each project's data apart, so this file's orders,
// its collection-group order lookups, and above all its deliberately contended
// transactions (the concurrency tests below wait seconds on locks and retries)
// cannot slow the other suites' order lookups down — measured: with the shared
// project these tests added ~12s to the whole suite. Data is still cleaned up
// after each test; the project id appears nowhere in the code under test.
const PROJECT_ID = "demo-zesto-fulfillment-domain";

let db: Firestore;

// Comfortably inside vitest's 5000ms default in isolation, but the full
// `npm run test:functions-emulator` suite shares one emulator instance across
// every test file at once, and every order lookup here is a collection-group
// query the emulator answers by scanning the whole `orders` group — enough
// contention to occasionally miss the default. The same reasoning, and the same
// per-file (not global) setting, as `payments.emulator.test.ts`.
vi.setConfig({testTimeout: 20000});

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

// Orders (and payment documents) written by `seedOrder`. The emulator answers a
// collection-group query by scanning every document in the group, so leftovers
// slow every other file's order lookups: delete them after each test.
const seededRefs: DocumentReference[] = [];

afterEach(async () => {
  const refs = seededRefs.splice(0);
  const batch = db.batch();
  for (const ref of refs) {
    batch.delete(ref);
  }
  await batch.commit();
});

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

function freshOrgInput() {
  const suffix = randomUUID();
  return {name: `Test Org ${suffix}`, slug: `test-org-${suffix}`};
}

function freshOutletInput(name: string) {
  return {name, slug: `outlet-${randomUUID()}`};
}

/** An active membership of `organizationId`, as `requireOrganizationRole` would return it. */
function member(organizationId: string, role: OrganizationMemberRole = "staff"): OrganizationMembership {
  return {userId: freshUserId(), organizationId, role, status: "active"};
}

async function createDraftMenu(organizationId: string, outletId: string, ownerId: string) {
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
  outletId: string;
  menuId: string;
  inactiveOutletId: string;
  inactiveMenuId: string;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  const outlet = await createOutlet(db, organization.id, ownerId, freshOutletInput(`${label} Main Canteen`));
  const inactive = await createOutlet(db, organization.id, ownerId, freshOutletInput(`${label} Old Annex`));
  const menu = await createDraftMenu(organization.id, outlet.id, ownerId);
  const inactiveMenu = await createDraftMenu(organization.id, inactive.id, ownerId);
  await updateOutlet(db, organization.id, inactive.id, {status: "inactive"});
  return {
    organizationId: organization.id,
    outletId: outlet.id,
    menuId: menu.id,
    inactiveOutletId: inactive.id,
    inactiveMenuId: inactiveMenu.id,
  };
}

const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));

interface SeedOrderInput {
  org: OrgFixture;
  status: OrderStatus;
  paymentStatus?: "pending" | "paid";
  userId?: string;
  /** Seed the order under the inactive outlet instead. */
  inactiveOutlet?: boolean;
  extra?: Record<string, unknown>;
}

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
}

async function seedOrder(input: SeedOrderInput): Promise<SeededOrder> {
  const {org} = input;
  const outletId = input.inactiveOutlet ? org.inactiveOutletId : org.outletId;
  const menuId = input.inactiveOutlet ? org.inactiveMenuId : org.menuId;
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("orders").doc();
  seededRefs.push(ref);
  const customerId = input.userId ?? freshUserId();
  const items = [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: 10000}];
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId,
    menuId,
    status: input.status,
    paymentStatus: input.paymentStatus ?? (input.status === "pending_payment" ? "pending" : "paid"),
    currency: "INR",
    subtotalInPaise: 10000,
    totalInPaise: 10000,
    items,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input.extra,
  });
  return {id: ref.id, ref, customerId};
}

async function rawOrder(order: SeededOrder): Promise<Record<string, unknown>> {
  const snapshot = await order.ref.get();
  const data = snapshot.data();
  if (!data) {
    throw new Error(`order ${order.id} is gone`);
  }
  return data;
}

/** `data` without the named fields. */
function without(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)));
}

function transition(
  who: OrganizationMembership,
  orderId: string,
  to: FulfillmentTarget,
): Promise<TransitionOrderStatusResult> {
  return transitionOrderStatus(db, {membership: who, orderId, to});
}

async function rejectionOf(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("transitionOrderStatus (Firestore emulator)", () => {
  let orgA: OrgFixture;
  let orgB: OrgFixture;

  beforeAll(async () => {
    orgA = await buildOrg("Org A");
    orgB = await buildOrg("Org B");
  });

  describe("the transitions", () => {
    it("moves a paid, confirmed order to preparing, recording who and when, and nothing else", async () => {
      const order = await seedOrder({org: orgA, status: "confirmed"});
      const actor = member(orgA.organizationId, "staff");
      const before = await rawOrder(order);

      const result = await transition(actor, order.id, "preparing");

      expect(result).toMatchObject({changed: true, previousStatus: "confirmed"});
      expect(result.order.status).toBe("preparing");
      const after = await rawOrder(order);
      expect(after.status).toBe("preparing");
      expect(after.preparingStartedBy).toBe(actor.userId);
      const startedAt = after.preparingStartedAt as Timestamp;
      expect(startedAt).toBeInstanceOf(Timestamp);
      expect(startedAt.toMillis()).toBeGreaterThan(CREATED_AT.toMillis());
      expect((after.updatedAt as Timestamp).toMillis()).toBe(startedAt.toMillis());
      expect(after.readyAt).toBeUndefined();
      expect(after.readyBy).toBeUndefined();
      // Everything the order is about is untouched: money, items, payment, ownership, history.
      expect(without(after, ["status", "updatedAt", "preparingStartedAt", "preparingStartedBy"]))
        .toEqual(without(before, ["status", "updatedAt"]));
    });

    it("moves a preparing order to ready, adding its own audit pair and keeping the earlier one", async () => {
      const order = await seedOrder({org: orgA, status: "confirmed"});
      const starter = member(orgA.organizationId, "staff");
      const finisher = member(orgA.organizationId, "manager");
      await transition(starter, order.id, "preparing");
      const preparing = await rawOrder(order);

      const result = await transition(finisher, order.id, "ready");

      expect(result).toMatchObject({changed: true, previousStatus: "preparing"});
      const after = await rawOrder(order);
      expect(after.status).toBe("ready");
      expect(after.readyBy).toBe(finisher.userId);
      expect((after.readyAt as Timestamp).toMillis()).toBeGreaterThanOrEqual(
        (preparing.preparingStartedAt as Timestamp).toMillis(),
      );
      expect(after.updatedAt).toEqual(after.readyAt);
      expect(after.preparingStartedBy).toBe(starter.userId);
      expect(after.preparingStartedAt).toEqual(preparing.preparingStartedAt);
    });

    it("works for an order of a since-deactivated outlet: customers already paid", async () => {
      const order = await seedOrder({org: orgA, status: "confirmed", inactiveOutlet: true});

      await transition(member(orgA.organizationId), order.id, "preparing");
      await transition(member(orgA.organizationId), order.id, "ready");

      expect((await rawOrder(order)).status).toBe("ready");
    });

    it.each<OrganizationMemberRole>(["owner", "manager", "staff"])("lets an %s do it", async (role) => {
      const order = await seedOrder({org: orgA, status: "confirmed"});
      const actor = member(orgA.organizationId, role);

      await transition(actor, order.id, "preparing");

      expect((await rawOrder(order)).preparingStartedBy).toBe(actor.userId);
    });
  });

  describe("refusals leave the order exactly as it was", () => {
    it.each<[OrderStatus, "pending" | "paid", FulfillmentTarget]>([
      ["confirmed", "paid", "ready"],
      ["pending_payment", "pending", "preparing"],
      ["pending_payment", "pending", "ready"],
      ["cancelled", "pending", "preparing"],
      ["cancelled", "paid", "preparing"],
      ["cancelled", "paid", "ready"],
      ["ready", "paid", "preparing"],
      // Completing is only ever the step after a pickup, never a way around it.
      ["confirmed", "paid", "completed"],
      ["preparing", "paid", "completed"],
      ["ready", "paid", "completed"],
      ["cancelled", "paid", "completed"],
      ["pending_payment", "pending", "completed"],
      // Nothing moves backwards out of picked_up.
      ["picked_up", "paid", "ready"],
      ["picked_up", "paid", "preparing"],
      // Not paid although past payment: no code path makes this, and it must not be fulfilled.
      ["confirmed", "pending", "preparing"],
      ["preparing", "pending", "ready"],
      ["picked_up", "pending", "completed"],
    ])("%s (%s) -> %s is a 409", async (status, paymentStatus, to) => {
      const order = await seedOrder({org: orgA, status, paymentStatus});
      const before = await rawOrder(order);

      const error = await rejectionOf(transition(member(orgA.organizationId), order.id, to));

      expect(error.code).toBe("aborted");
      expect(error.httpErrorCode.status).toBe(409);
      expect(await rawOrder(order)).toEqual(before);
    });

    // `picked_up` is the one that matters: it needs a pickup credential and must never
    // be reachable through a generic step (see orderPickup.emulator.test.ts).
    it("never moves an order to a status that is not a fulfillment target", async () => {
      const order = await seedOrder({org: orgA, status: "confirmed"});
      const before = await rawOrder(order);

      for (const to of ["confirmed", "cancelled", "picked_up", "pending_payment"]) {
        const error = await rejectionOf(transitionOrderStatus(db, {
          membership: member(orgA.organizationId),
          orderId: order.id,
          to: to as unknown as FulfillmentTarget,
        }));
        expect(error.code).toBe("invalid-argument");
      }
      expect(await rawOrder(order)).toEqual(before);
    });

    it.each(["invited", "revoked"] as const)("refuses a %s member and writes nothing", async (status) => {
      const order = await seedOrder({org: orgA, status: "confirmed"});
      const before = await rawOrder(order);

      const error = await rejectionOf(
        transition({...member(orgA.organizationId, "owner"), status}, order.id, "preparing"),
      );

      expect(error.code).toBe("permission-denied");
      expect(await rawOrder(order)).toEqual(before);
    });
  });

  describe("repeating an action", () => {
    it("is a no-op for preparing -> preparing: the first person stays on record", async () => {
      const order = await seedOrder({org: orgA, status: "confirmed"});
      const first = member(orgA.organizationId, "staff");
      await transition(first, order.id, "preparing");
      const afterFirst = await rawOrder(order);

      const repeat = await transition(member(orgA.organizationId, "owner"), order.id, "preparing");

      expect(repeat).toMatchObject({changed: false, previousStatus: "preparing"});
      expect(repeat.order.status).toBe("preparing");
      expect(await rawOrder(order)).toEqual(afterFirst);
      expect((await rawOrder(order)).preparingStartedBy).toBe(first.userId);
    });

    it("is a no-op for ready -> ready", async () => {
      const order = await seedOrder({org: orgA, status: "preparing"});
      await transition(member(orgA.organizationId), order.id, "ready");
      const afterFirst = await rawOrder(order);

      const repeat = await transition(member(orgA.organizationId, "manager"), order.id, "ready");

      expect(repeat).toMatchObject({changed: false, previousStatus: "ready"});
      expect(await rawOrder(order)).toEqual(afterFirst);
    });
  });

  describe("tenant scoping", () => {
    it("treats another organization's order exactly like one that does not exist (404), and writes nothing", async () => {
      const foreign = await seedOrder({org: orgB, status: "confirmed"});
      const before = await rawOrder(foreign);
      const intruder = member(orgA.organizationId, "owner");

      const missing = await rejectionOf(transition(intruder, "no-such-order-id", "preparing"));
      const crossTenant = await rejectionOf(transition(intruder, foreign.id, "preparing"));

      expect(missing.code).toBe("not-found");
      expect(crossTenant.code).toBe("not-found");
      expect(crossTenant.message).toBe(missing.message);
      expect(await rawOrder(foreign)).toEqual(before);
    });

    it("scopes to the membership's organization, so org B's own member can act on it", async () => {
      const order = await seedOrder({org: orgB, status: "confirmed"});

      await transition(member(orgB.organizationId), order.id, "preparing");

      expect((await rawOrder(order)).status).toBe("preparing");
    });
  });

  // Explicit timeout, the same convention as `payments.emulator.test.ts` and
  // `orders.emulator.test.ts`: transactions that contend on one document are slow
  // in the Firestore emulator (several seconds, against vitest's 5s default),
  // which is a property of the emulator's locking, not of the code under test.
  // Only these tests get more time; their assertions are untouched.
  describe("concurrent callers", {timeout: 30_000}, () => {
    it("lets two staff start the same order at once: one writes, the other repeats it", async () => {
      const order = await seedOrder({org: orgA, status: "confirmed"});
      const alice = member(orgA.organizationId, "staff");
      const bob = member(orgA.organizationId, "staff");

      const [a, b] = await Promise.all([
        transition(alice, order.id, "preparing"),
        transition(bob, order.id, "preparing"),
      ]);

      expect([a.changed, b.changed].sort()).toEqual([false, true]);
      const winner = a.changed ? alice : bob;
      const after = await rawOrder(order);
      expect(after.status).toBe("preparing");
      expect(after.preparingStartedBy).toBe(winner.userId);
      expect(after.updatedAt).toEqual(after.preparingStartedAt);
    });

    it("lets two staff mark the same order ready at once: one writes, the other repeats it", async () => {
      const order = await seedOrder({org: orgA, status: "preparing"});
      const alice = member(orgA.organizationId, "staff");
      const bob = member(orgA.organizationId, "manager");

      const [a, b] = await Promise.all([
        transition(alice, order.id, "ready"),
        transition(bob, order.id, "ready"),
      ]);

      expect([a.changed, b.changed].sort()).toEqual([false, true]);
      const after = await rawOrder(order);
      expect(after.status).toBe("ready");
      expect(after.readyBy).toBe((a.changed ? alice : bob).userId);
    });

    // Two sequential races (so both orders of arrival are likely to be seen),
    // each potentially several seconds of emulator lock waits that also slow
    // every other test file sharing the emulator — hence not more of them.
    it("never leaves an order ready without having been preparing when start and ready race", {timeout: 60_000}, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const order = await seedOrder({org: orgA, status: "confirmed"});
        const starter = member(orgA.organizationId, "staff");
        const finisher = member(orgA.organizationId, "manager");

        const [start, ready] = await Promise.allSettled([
          transition(starter, order.id, "preparing"),
          transition(finisher, order.id, "ready"),
        ]);

        expect(start.status).toBe("fulfilled");
        const after = await rawOrder(order);
        if (ready.status === "fulfilled") {
          // ready ran after start committed.
          expect(after.status).toBe("ready");
          expect(after.preparingStartedBy).toBe(starter.userId);
          expect(after.readyBy).toBe(finisher.userId);
        } else {
          // ready ran first, found the order still confirmed, and was refused.
          expect(ready.reason).toBeInstanceOf(HttpsError);
          expect((ready.reason as HttpsError).code).toBe("aborted");
          expect(after.status).toBe("preparing");
          expect(after.readyAt).toBeUndefined();
          expect(after.readyBy).toBeUndefined();
        }
      }
    });
  });
});

describe("payment operations on an order that has moved into fulfillment (Firestore emulator)", () => {
  let org: OrgFixture;

  beforeAll(async () => {
    org = await buildOrg("Payments");
  });

  /** A fulfilled-so-far order with its succeeded payment, as the real flow leaves them. */
  async function fulfilledOrderWithPayment(status: "preparing" | "ready") {
    const order = await seedOrder({
      org,
      status,
      extra: {
        preparingStartedAt: Timestamp.fromMillis(CREATED_AT.toMillis() + 60_000),
        preparingStartedBy: "U-staff-1",
        updatedAt: Timestamp.fromMillis(CREATED_AT.toMillis() + 120_000),
        ...(status === "ready" ?
          {readyAt: Timestamp.fromMillis(CREATED_AT.toMillis() + 120_000), readyBy: "U-staff-2"} :
          {}),
      },
    });
    const paymentRef = order.ref.collection("payments").doc(order.id);
    seededRefs.push(paymentRef);
    await paymentRef.create({
      id: order.id,
      orderId: order.id,
      userId: order.customerId,
      organizationId: org.organizationId,
      outletId: org.outletId,
      menuId: org.menuId,
      amountInPaise: 10000,
      currency: "INR",
      status: "succeeded",
      provider: "razorpay",
      providerOrderId: "order_replay",
      providerPaymentId: "pay_replay",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    return {order, paymentRef};
  }

  it.each(["preparing", "ready"] as const)(
    "replaying markPaymentSucceeded on a %s order changes neither the order nor the payment",
    async (status) => {
      const {order, paymentRef} = await fulfilledOrderWithPayment(status);
      const orderBefore = await rawOrder(order);
      const paymentBefore = (await paymentRef.get()).data();

      const result = await markPaymentSucceeded(db, {
        orderId: order.id,
        paymentId: order.id,
        amountInPaise: 10000,
        currency: "INR",
        providerPaymentId: "pay_replay",
      });

      expect(result.order.status).toBe(status);
      expect(await rawOrder(order)).toEqual(orderBefore);
      expect((await paymentRef.get()).data()).toEqual(paymentBefore);
    },
  );

  it.each(["preparing", "ready"] as const)(
    "a late payment-failure notification cannot move a %s order's payment backwards",
    async (status) => {
      const {order, paymentRef} = await fulfilledOrderWithPayment(status);
      const orderBefore = await rawOrder(order);
      const paymentBefore = (await paymentRef.get()).data();

      const payment = await markPaymentFailed(db, {orderId: order.id, paymentId: order.id, providerPaymentId: "pay_late"});

      expect(payment.status).toBe("succeeded");
      expect(await rawOrder(order)).toEqual(orderBefore);
      expect((await paymentRef.get()).data()).toEqual(paymentBefore);
    },
  );

  it.each(["preparing", "ready"] as const)(
    "replaying the customer's payment verification on a %s order succeeds with the order's real state",
    async (status) => {
      const {order} = await fulfilledOrderWithPayment(status);
      const orderBefore = await rawOrder(order);

      const result = await verifyCheckoutPayment(db, order.customerId, order.id, {
        razorpayPaymentId: "pay_replay",
        razorpayOrderId: "order_replay",
        razorpaySignature: "not-checked-for-a-replay",
      });

      expect(result.order.status).toBe(status);
      expect(result.order.paymentStatus).toBe("paid");
      expect(result.payment.status).toBe("succeeded");
      expect(await rawOrder(order)).toEqual(orderBefore);
    },
  );

  it("still refuses a verification replay that names a different payment", async () => {
    const {order} = await fulfilledOrderWithPayment("preparing");

    const error = await rejectionOf(verifyCheckoutPayment(db, order.customerId, order.id, {
      razorpayPaymentId: "pay_other",
      razorpayOrderId: "order_replay",
      razorpaySignature: "x",
    }));

    expect(error.code).toBe("already-exists");
  });

  it.each(["preparing", "ready"] as const)("a %s order is no longer awaiting payment", async (status) => {
    const {order} = await fulfilledOrderWithPayment(status);

    const error = await rejectionOf(preparePayment(db, order.customerId, order.id));

    expect(error.code).toBe("failed-precondition");
    expect(error.message).toBe("This order is not awaiting payment.");
  });
});

describe("customer and organization reads of fulfilled orders (Firestore emulator)", () => {
  let org: OrgFixture;

  beforeAll(async () => {
    org = await buildOrg("Reads");
  });

  it.each(["preparing", "ready"] as const)("the customer can still read their %s order", async (status) => {
    const order = await seedOrder({
      org,
      status,
      extra: {preparingStartedAt: CREATED_AT, preparingStartedBy: "U-secret-actor"},
    });

    const read = await getOwnedOrder(db, order.customerId, order.id);

    expect(read.status).toBe(status);
    expect(read.paymentStatus).toBe("paid");
  });

  it("the customer's history lists their preparing and ready orders", async () => {
    const customerId = freshUserId();
    const preparing = await seedOrder({org, status: "preparing", userId: customerId});
    const ready = await seedOrder({org, status: "ready", userId: customerId});

    const page = await listOwnedOrders(db, customerId, {});

    expect(page.orders.map((order) => [order.id, order.status]).sort()).toEqual(
      [[preparing.id, "preparing"], [ready.id, "ready"]].sort(),
    );
    expect(JSON.stringify(page)).not.toContain("preparingStarted");
  });

  it("the organization's list shows the new statuses, without any audit field or actor", async () => {
    const preparing = await seedOrder({
      org, status: "preparing", extra: {preparingStartedAt: CREATED_AT, preparingStartedBy: "U-secret-actor"},
    });
    const ready = await seedOrder({
      org, status: "ready",
      extra: {preparingStartedAt: CREATED_AT, preparingStartedBy: "U-secret-actor", readyAt: CREATED_AT, readyBy: "U-secret-actor"},
    });

    const page = await listOrganizationOrders(db, org.organizationId, {limit: 50});

    const statuses = new Map(page.orders.map((order) => [order.id, order.status]));
    expect(statuses.get(preparing.id)).toBe("preparing");
    expect(statuses.get(ready.id)).toBe("ready");
    expect(JSON.stringify(page)).not.toContain("U-secret-actor");
    expect(JSON.stringify(page)).not.toMatch(/preparingStarted|readyAt|readyBy/);
  });
});

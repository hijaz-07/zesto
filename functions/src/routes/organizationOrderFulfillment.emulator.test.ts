// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {createMenu} from "../domain/menus";
import type {OrderStatus} from "../domain/orders";
import {createOrganization} from "../domain/organizations";
import {createOutlet, updateOutlet} from "../domain/outlets";
import {toResponseBody} from "../http/envelope";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * `POST /organizations/{organizationId}/orders/{orderId}/start-preparing` and
 * `.../mark-ready` against a REAL Firestore emulator: the real membership
 * documents behind the owner/manager/staff/invited/revoked/non-member matrix,
 * the documents the routes actually change (and the ones they must not),
 * tenant isolation, and concurrent requests. Descope stays faked. The
 * organization/outlet/menu chain is built through the domain functions; orders
 * are written directly, in whatever state a test needs.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own, not the one every other emulator suite
// shares (see `orderFulfillment.emulator.test.ts` for why): the emulator keeps
// each project's data apart, so this file's orders, order lookups and contended
// transactions cannot slow the other suites down. The project id appears nowhere
// in the code under test.
const PROJECT_ID = "demo-zesto-fulfillment-routes";

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

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

// Orders written by `seedOrder`. The emulator answers a collection-group query
// by scanning every document in the group, so leftovers slow every other
// file's order lookups: delete them after each test.
const seededRefs: DocumentReference[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

type Action = "start-preparing" | "mark-ready";

function act(
  organizationId: string,
  orderId: string,
  action: Action,
  validator: SessionValidator,
  overrides: Partial<NormalizedRequest> = {},
): Promise<ApiResult> {
  const routes = createOrganizationOrderRoutes({db, validator});
  return handleRequest(
    routes,
    {
      method: "POST",
      path: `/organizations/${organizationId}/orders/${orderId}/${action}`,
      headers: {authorization: "Bearer token"},
      query: {},
      body: undefined,
      ...overrides,
    },
    () => {},
  );
}

function list(organizationId: string, userId: string): Promise<ApiResult> {
  return handleRequest(
    createOrganizationOrderRoutes({db, validator: acceptingValidator(userId)}),
    {
      method: "GET",
      path: `/organizations/${organizationId}/orders`,
      headers: {authorization: "Bearer token"},
      query: {limit: "50"},
      body: undefined,
    },
    () => {},
  );
}

interface OrderRow {
  id: string;
  outletId: string;
  menuId: string;
  outlet?: {name: string};
  menu?: {title: string; menuDate: string};
  status: string;
  paymentStatus: string;
  totalInPaise: number;
  itemCount: number;
  items: Array<{name: string; quantity: number}>;
  updatedAt: string;
}

function orderOf(result: ApiResult): OrderRow {
  if (result.kind !== "success") {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return (result.data as {order: OrderRow}).order;
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
  ownerId: string;
  outletId: string;
  outletName: string;
  menuId: string;
  inactiveOutletId: string;
  inactiveMenuId: string;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  const outletName = `${label} Main Canteen`;
  const outlet = await createOutlet(db, organization.id, ownerId, freshOutletInput(outletName));
  const inactive = await createOutlet(db, organization.id, ownerId, freshOutletInput(`${label} Old Annex`));
  // Never-published draft menus: fulfillment does not depend on menu state, and
  // it keeps the fixture out of the public Explore feed.
  const menu = await createDraftMenu(organization.id, outlet.id, ownerId);
  const inactiveMenu = await createDraftMenu(organization.id, inactive.id, ownerId);
  await updateOutlet(db, organization.id, inactive.id, {status: "inactive"});
  return {
    organizationId: organization.id,
    ownerId,
    outletId: outlet.id,
    outletName,
    menuId: menu.id,
    inactiveOutletId: inactive.id,
    inactiveMenuId: inactiveMenu.id,
  };
}

const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
}

async function seedOrder(
  org: OrgFixture,
  status: OrderStatus,
  options: {paymentStatus?: "pending" | "paid"; inactiveOutlet?: boolean; extra?: Record<string, unknown>} = {},
): Promise<SeededOrder> {
  const outletId = options.inactiveOutlet ? org.inactiveOutletId : org.outletId;
  const menuId = options.inactiveOutlet ? org.inactiveMenuId : org.menuId;
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("orders").doc();
  seededRefs.push(ref);
  const customerId = freshUserId();
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId,
    menuId,
    status,
    paymentStatus: options.paymentStatus ?? (status === "pending_payment" ? "pending" : "paid"),
    currency: "INR",
    subtotalInPaise: 10000,
    totalInPaise: 10000,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: 10000}],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...options.extra,
  });
  return {id: ref.id, ref, customerId};
}

async function rawOrder(order: SeededOrder): Promise<Record<string, unknown>> {
  const data = (await order.ref.get()).data();
  if (!data) {
    throw new Error(`order ${order.id} is gone`);
  }
  return data;
}

const ACTIONS: ReadonlyArray<{action: Action; from: OrderStatus; to: OrderStatus}> = [
  {action: "start-preparing", from: "confirmed", to: "preparing"},
  {action: "mark-ready", from: "preparing", to: "ready"},
];

describe("order fulfillment routes (Firestore emulator)", () => {
  let orgA: OrgFixture;
  let orgB: OrgFixture;
  let managerA: string;
  let staffA: string;
  let invitedA: string;
  let revokedA: string;
  let unknownRoleA: string;
  let customerOnly: string;

  beforeAll(async () => {
    orgA = await buildOrg("Org A");
    orgB = await buildOrg("Org B");
    managerA = freshUserId();
    staffA = freshUserId();
    invitedA = freshUserId();
    revokedA = freshUserId();
    unknownRoleA = freshUserId();
    customerOnly = freshUserId();
    await addMembership(orgA.organizationId, managerA, "manager");
    await addMembership(orgA.organizationId, staffA, "staff");
    await addMembership(orgA.organizationId, invitedA, "owner", "invited");
    await addMembership(orgA.organizationId, revokedA, "manager", "revoked");
    await addMembership(orgA.organizationId, unknownRoleA, "superadmin");
  });

  describe.each(ACTIONS)("$action: authentication and authorization", ({action, from}) => {
    // One order shared by the refusals below: each only asserts that the order is
    // exactly as it was, so none of them needs its own (fewer writes and order
    // lookups on the emulator all the other test files share). Taken out of the
    // per-test cleanup list so it survives until `afterAll`.
    let untouched: SeededOrder;
    beforeAll(async () => {
      untouched = await seedOrder(orgA, from);
      seededRefs.splice(seededRefs.indexOf(untouched.ref), 1);
    });
    afterAll(async () => {
      await untouched.ref.delete();
    });

    it("denies an unauthenticated caller (401) and changes nothing", async () => {
      const order = untouched;
      const before = await rawOrder(order);

      const result = await act(orgA.organizationId, order.id, action, rejectingValidator());

      expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
      expect(await rawOrder(order)).toEqual(before);
    });

    it("denies a request with no Authorization header (401) without consulting the validator", async () => {
      const order = untouched;
      const validator = acceptingValidator(orgA.ownerId);

      const result = await act(orgA.organizationId, order.id, action, validator, {headers: {}});

      expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
      expect(validator.validateSession).not.toHaveBeenCalled();
    });

    it.each([
      ["a non-member", () => customerOnly],
      ["another organization's owner", () => orgB.ownerId],
      ["a member whose membership is invited", () => invitedA],
      ["a member whose membership is revoked", () => revokedA],
      ["a member document with an unknown role", () => unknownRoleA],
    ])("denies %s (403) and changes nothing", async (_label, userId) => {
      const order = untouched;
      const before = await rawOrder(order);

      const result = await act(orgA.organizationId, order.id, action, acceptingValidator(userId()));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(await rawOrder(order)).toEqual(before);
    });

    it("denies the customer who placed the order (403): ordering gives no say over fulfillment", async () => {
      const order = untouched;
      const before = await rawOrder(order);

      const result = await act(orgA.organizationId, order.id, action, acceptingValidator(order.customerId));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(await rawOrder(order)).toEqual(before);
    });

    it.each([
      ["owner", () => orgA.ownerId],
      ["manager", () => managerA],
      ["staff", () => staffA],
    ])("lets an active %s do it (200)", async (_role, userId) => {
      const order = await seedOrder(orgA, from);
      const actor = userId();

      const result = await act(orgA.organizationId, order.id, action, acceptingValidator(actor));

      expect(result).toMatchObject({kind: "success", status: 200});
    });

    it("answers 403, not 404, for an organization the caller is not in even when the order id is real", async () => {
      const order = await seedOrder(orgB, from);

      const result = await act(orgB.organizationId, order.id, action, acceptingValidator(managerA));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    });
  });

  describe("the transitions", () => {
    it("start-preparing: 200 with the order's list row, and the document really changed", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const result = await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA));

      expect(result).toMatchObject({kind: "success", status: 200, userId: staffA});
      const row = orderOf(result);
      expect(row).toMatchObject({
        id: order.id,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        outlet: {name: orgA.outletName},
        status: "preparing",
        paymentStatus: "paid",
        totalInPaise: 10000,
        itemCount: 2,
        items: [{name: "Seed Dish", quantity: 2}],
      });
      const doc = await rawOrder(order);
      expect(doc).toMatchObject({status: "preparing", preparingStartedBy: staffA});
      expect(doc.readyAt).toBeUndefined();
      expect(row.updatedAt).toBe((doc.updatedAt as Timestamp).toDate().toISOString());
    });

    it("walks confirmed -> preparing -> ready with two different people, each on record", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const started = await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA));
      const finished = await act(orgA.organizationId, order.id, "mark-ready", acceptingValidator(managerA));

      expect(orderOf(started).status).toBe("preparing");
      expect(orderOf(finished).status).toBe("ready");
      const doc = await rawOrder(order);
      expect(doc).toMatchObject({status: "ready", preparingStartedBy: staffA, readyBy: managerA});
      expect((doc.readyAt as Timestamp).toMillis()).toBeGreaterThanOrEqual((doc.preparingStartedAt as Timestamp).toMillis());
    });

    it("is reflected by the order list the dashboard refreshes from", async () => {
      const order = await seedOrder(orgA, "confirmed");
      await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA));

      const result = await list(orgA.organizationId, staffA);

      const rows = (result as {data: {orders: OrderRow[]}}).data.orders;
      expect(rows.find((row) => row.id === order.id)?.status).toBe("preparing");
    });

    it("works for an order of a since-deactivated outlet", async () => {
      const order = await seedOrder(orgA, "confirmed", {inactiveOutlet: true});

      const result = await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA));

      expect(orderOf(result).status).toBe("preparing");
    });

    it("never exposes the customer, the actors, the organization or the audit fields", async () => {
      const order = await seedOrder(orgA, "confirmed");
      await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA));

      const result = await act(orgA.organizationId, order.id, "mark-ready", acceptingValidator(managerA));

      // What goes over the wire is the envelope's body; `result.userId` is only
      // the request log's field for the caller and never reaches the response.
      const responseBody = toResponseBody(result, "request-id");
      const body = JSON.stringify(responseBody);
      for (const secret of [order.customerId, staffA, managerA, orgA.organizationId]) {
        expect(body).not.toContain(secret);
      }
      expect(body).not.toMatch(/preparingStarted|readyAt|readyBy|userId|organizationId/);
      expect(Object.keys(responseBody)).toEqual(["data"]);
      expect(Object.keys((responseBody as {data: object}).data)).toEqual(["order"]);
    });
  });

  describe("refusals (409 conflict) leave the order untouched", () => {
    it.each<[Action, OrderStatus, "pending" | "paid", string]>([
      ["mark-ready", "confirmed", "paid", "This order is confirmed, so it can't be moved to ready."],
      ["start-preparing", "pending_payment", "pending", "This order has not been paid yet."],
      ["mark-ready", "pending_payment", "pending", "This order has not been paid yet."],
      ["start-preparing", "cancelled", "pending", "This order is cancelled, so it can't be moved to preparing."],
      ["start-preparing", "cancelled", "paid", "This order is cancelled, so it can't be moved to preparing."],
      ["mark-ready", "cancelled", "paid", "This order is cancelled, so it can't be moved to ready."],
      ["start-preparing", "ready", "paid", "This order is ready, so it can't be moved to preparing."],
      ["start-preparing", "confirmed", "pending", "This order has not been paid yet."],
    ])("%s on a %s (%s) order", async (action, status, paymentStatus, message) => {
      const order = await seedOrder(orgA, status, {paymentStatus});
      const before = await rawOrder(order);

      const result = await act(orgA.organizationId, order.id, action, acceptingValidator(staffA));

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict", message, userId: staffA});
      expect(await rawOrder(order)).toEqual(before);
    });
  });

  describe("repeating an action is a 200 that changes nothing", () => {
    it("start-preparing twice: the first person stays on record", async () => {
      const order = await seedOrder(orgA, "confirmed");
      const first = await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA));
      const afterFirst = await rawOrder(order);

      const second = await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(managerA));

      expect(second).toMatchObject({kind: "success", status: 200});
      expect(orderOf(second)).toEqual(orderOf(first));
      expect(await rawOrder(order)).toEqual(afterFirst);
      expect((await rawOrder(order)).preparingStartedBy).toBe(staffA);
    });

    it("mark-ready twice", async () => {
      const order = await seedOrder(orgA, "preparing");
      await act(orgA.organizationId, order.id, "mark-ready", acceptingValidator(staffA));
      const afterFirst = await rawOrder(order);

      const second = await act(orgA.organizationId, order.id, "mark-ready", acceptingValidator(managerA));

      expect(second).toMatchObject({kind: "success", status: 200});
      expect(orderOf(second).status).toBe("ready");
      expect(await rawOrder(order)).toEqual(afterFirst);
    });
  });

  describe("tenant isolation", () => {
    it("answers 404 for another organization's order, identically to one that does not exist", async () => {
      const foreign = await seedOrder(orgB, "confirmed");
      const before = await rawOrder(foreign);

      const missing = await act(orgA.organizationId, "no-such-order", "start-preparing", acceptingValidator(orgA.ownerId));
      const crossTenant = await act(orgA.organizationId, foreign.id, "start-preparing", acceptingValidator(orgA.ownerId));

      expect(missing).toMatchObject({kind: "error", status: 404, code: "not_found"});
      expect(crossTenant).toEqual(missing);
      expect(await rawOrder(foreign)).toEqual(before);
    });

    it("cannot be redirected by naming the other organization elsewhere in the request", async () => {
      const foreign = await seedOrder(orgB, "confirmed");
      const before = await rawOrder(foreign);

      const result = await act(orgA.organizationId, foreign.id, "start-preparing", acceptingValidator(orgA.ownerId), {
        query: {organizationId: orgB.organizationId, outletId: orgB.outletId},
        body: {organizationId: orgB.organizationId, outletId: orgB.outletId, orderId: foreign.id},
      });

      expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
      expect(await rawOrder(foreign)).toEqual(before);
    });

    it("lets org B's own owner fulfil org B's order, not org A's", async () => {
      const mine = await seedOrder(orgB, "confirmed");
      const theirs = await seedOrder(orgA, "confirmed");

      const ok = await act(orgB.organizationId, mine.id, "start-preparing", acceptingValidator(orgB.ownerId));
      const denied = await act(orgB.organizationId, theirs.id, "start-preparing", acceptingValidator(orgB.ownerId));

      expect(ok).toMatchObject({kind: "success", status: 200});
      expect(denied).toMatchObject({kind: "error", status: 404});
      expect((await rawOrder(theirs)).status).toBe("confirmed");
    });
  });

  describe("nothing in the request is trusted", () => {
    it("ignores a body and query that try to choose the status, the actor, the organization, the outlet", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const result = await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA), {
        query: {status: "ready", userId: "U-attacker", organizationId: orgB.organizationId, outletId: orgB.outletId},
        body: {
          status: "ready",
          paymentStatus: "paid",
          userId: "U-attacker",
          preparingStartedBy: "U-attacker",
          organizationId: orgB.organizationId,
          outletId: orgB.outletId,
          updatedAt: "2000-01-01T00:00:00Z",
        },
      });

      expect(orderOf(result).status).toBe("preparing");
      const doc = await rawOrder(order);
      expect(doc.status).toBe("preparing");
      expect(doc.preparingStartedBy).toBe(staffA);
      expect(doc.readyBy).toBeUndefined();
      expect(doc.userId).toBe(order.customerId);
      expect(doc.organizationId).toBe(orgA.organizationId);
    });

    it("cannot be used to mark an unpaid order paid or ready by claiming it in the body", async () => {
      const order = await seedOrder(orgA, "pending_payment");
      const before = await rawOrder(order);

      const result = await act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA), {
        body: {status: "confirmed", paymentStatus: "paid"},
      });

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict"});
      expect(await rawOrder(order)).toEqual(before);
    });

    it("re-checks membership on every request: a revoked member is refused at once", async () => {
      const temp = freshUserId();
      await addMembership(orgA.organizationId, temp, "staff");
      const first = await seedOrder(orgA, "confirmed");
      const second = await seedOrder(orgA, "confirmed");
      expect(orderOf(await act(orgA.organizationId, first.id, "start-preparing", acceptingValidator(temp))).status)
        .toBe("preparing");

      await addMembership(orgA.organizationId, temp, "staff", "revoked");
      const result = await act(orgA.organizationId, second.id, "start-preparing", acceptingValidator(temp));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect((await rawOrder(second)).status).toBe("confirmed");
    });
  });

  describe("malformed input", () => {
    it.each(["__x__", ".."])("rejects the order id %j (400) once authorized", async (orderId) => {
      const result = await act(orgA.organizationId, orderId, "start-preparing", acceptingValidator(staffA));

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    });
  });

  // Explicit timeout, the same convention as `payments.emulator.test.ts` and
  // `orders.emulator.test.ts`: transactions that contend on one document are slow
  // in the Firestore emulator (several seconds, against vitest's 5s default),
  // which is a property of the emulator's locking, not of the code under test.
  // Only these tests get more time; their assertions are untouched.
  describe("concurrent requests", {timeout: 30_000}, () => {
    it("two staff pressing start-preparing together both get 200, and exactly one is on record", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const [fromStaff, fromManager] = await Promise.all([
        act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA)),
        act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(managerA)),
      ]);

      expect(fromStaff).toMatchObject({kind: "success", status: 200});
      expect(fromManager).toMatchObject({kind: "success", status: 200});
      const doc = await rawOrder(order);
      expect(doc.status).toBe("preparing");
      expect([staffA, managerA]).toContain(doc.preparingStartedBy);
      expect(doc.updatedAt).toEqual(doc.preparingStartedAt);
    });

    it("a stale mark-ready racing a start-preparing is refused cleanly, never half-applied", async () => {
      const order = await seedOrder(orgA, "confirmed");

      const [start, ready] = await Promise.all([
        act(orgA.organizationId, order.id, "start-preparing", acceptingValidator(staffA)),
        act(orgA.organizationId, order.id, "mark-ready", acceptingValidator(managerA)),
      ]);

      expect(start).toMatchObject({kind: "success", status: 200});
      const doc = await rawOrder(order);
      if (ready.kind === "success") {
        expect(doc).toMatchObject({status: "ready", preparingStartedBy: staffA, readyBy: managerA});
      } else {
        expect(ready).toMatchObject({status: 409, code: "conflict"});
        expect(doc.status).toBe("preparing");
        expect(doc.readyBy).toBeUndefined();
      }
    });
  });
});

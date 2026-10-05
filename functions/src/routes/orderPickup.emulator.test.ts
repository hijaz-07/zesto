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
import {derivePickupCredentials} from "../domain/pickupCredential";
import {toResponseBody} from "../http/envelope";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createOrderRoutes} from "./orders";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * Pickup and completion over HTTP against a REAL Firestore emulator:
 *
 * - `POST /organizations/{organizationId}/pickups` and `.../orders/{orderId}/complete`
 *   — the real membership documents behind the owner/manager/staff/invited/
 *   revoked/non-member matrix, tenant isolation, the documents the routes
 *   actually change (and the ones they must not), what the response and log
 *   context may and may not contain, and concurrent requests;
 * - `GET /orders/{orderId}/pickup-credential` — who may fetch the credential
 *   (the order's own customer, and nobody else), and the whole customer ->
 *   staff -> customer lifecycle through the real routes.
 *
 * Descope stays faked. The organization/outlet/menu chain is built through the
 * domain functions; orders are written directly, in whatever state a test needs.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own (see `orderPickup.emulator.test.ts` in
// `domain/` for why): contended transactions must not slow the other suites.
const PROJECT_ID = "demo-zesto-pickup-routes";

// Made up for these tests; the real one lives only in Secret Manager.
const SECRET = "test-pickup-secret-0123456789-abcdefghij";
const pickupSecret = () => SECRET;

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
  const app = getApps().length > 0 ?
    getApps()[0] :
    initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

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

function baseRequest(overrides: Partial<NormalizedRequest>): NormalizedRequest {
  return {
    method: "POST",
    path: "/",
    headers: {authorization: "Bearer token"},
    query: {},
    body: undefined,
    ...overrides,
  };
}

/** `POST /organizations/{organizationId}/pickups`. */
function pickup(
  organizationId: string,
  validator: SessionValidator,
  body: unknown,
  overrides: Partial<NormalizedRequest> = {},
): Promise<ApiResult> {
  return handleRequest(
    createOrganizationOrderRoutes({db, validator, pickupSecret}),
    baseRequest({path: `/organizations/${organizationId}/pickups`, body, ...overrides}),
    () => {},
  );
}

/** `POST /organizations/{organizationId}/orders/{orderId}/complete`. */
function complete(
  organizationId: string,
  orderId: string,
  validator: SessionValidator,
  overrides: Partial<NormalizedRequest> = {},
): Promise<ApiResult> {
  return handleRequest(
    createOrganizationOrderRoutes({db, validator, pickupSecret}),
    baseRequest({path: `/organizations/${organizationId}/orders/${orderId}/complete`, ...overrides}),
    () => {},
  );
}

/** `GET /organizations/{organizationId}/orders`. */
function list(organizationId: string, userId: string): Promise<ApiResult> {
  return handleRequest(
    createOrganizationOrderRoutes({db, validator: acceptingValidator(userId), pickupSecret}),
    baseRequest({method: "GET", path: `/organizations/${organizationId}/orders`, query: {limit: "50"}}),
    () => {},
  );
}

/** `GET /orders/{orderId}/pickup-credential`. */
function credentialOf(orderId: string, validator: SessionValidator): Promise<ApiResult> {
  return handleRequest(
    createOrderRoutes({db, validator, pickupSecret}),
    baseRequest({method: "GET", path: `/orders/${orderId}/pickup-credential`}),
    () => {},
  );
}

/** `GET /orders/{orderId}`. */
function readOrder(orderId: string, userId: string): Promise<ApiResult> {
  return handleRequest(
    createOrderRoutes({db, validator: acceptingValidator(userId), pickupSecret}),
    baseRequest({method: "GET", path: `/orders/${orderId}`}),
    () => {},
  );
}

interface OrderRow {
  id: string;
  outletId: string;
  menuId: string;
  outlet?: {name: string};
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

function pickupOf(result: ApiResult): {qrPayload: string; code: string} {
  if (result.kind !== "success") {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return (result.data as {pickup: {qrPayload: string; code: string}}).pickup;
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
  otherOutletId: string;
  otherMenuId: string;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  const outletName = `${label} Main Canteen`;
  const outlet = await createOutlet(db, organization.id, ownerId, freshOutletInput(outletName));
  const other = await createOutlet(db, organization.id, ownerId, freshOutletInput(`${label} Old Annex`));
  const menu = await createDraftMenu(organization.id, outlet.id, ownerId);
  const otherMenu = await createDraftMenu(organization.id, other.id, ownerId);
  await updateOutlet(db, organization.id, other.id, {status: "inactive"});
  return {
    organizationId: organization.id,
    ownerId,
    outletId: outlet.id,
    outletName,
    menuId: menu.id,
    otherOutletId: other.id,
    otherMenuId: otherMenu.id,
  };
}

const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));
const READY_AT = Timestamp.fromDate(new Date("2026-09-01T07:00:00Z"));

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
}

async function seedOrder(
  org: OrgFixture,
  status: OrderStatus,
  options: {paymentStatus?: "pending" | "paid"; otherOutlet?: boolean; userId?: string; extra?: Record<string, unknown>} = {},
): Promise<SeededOrder> {
  const outletId = options.otherOutlet ? org.otherOutletId : org.outletId;
  const menuId = options.otherOutlet ? org.otherMenuId : org.menuId;
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("orders").doc();
  seededRefs.push(ref);
  const customerId = options.userId ?? freshUserId();
  const reachedReady = ["ready", "picked_up", "completed"].includes(status);
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
    updatedAt: reachedReady ? READY_AT : CREATED_AT,
    ...(reachedReady ? {readyAt: READY_AT, readyBy: "U-original-ready"} : {}),
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

const qrOf = (order: SeededOrder) => derivePickupCredentials(SECRET, order.id).qrPayload;
const codeOf = (order: SeededOrder) => derivePickupCredentials(SECRET, order.id).code;

const NO_MATCH = {kind: "error", status: 404, code: "not_found", message: "No order awaiting pickup matches this code."};

describe("pickup and completion routes (Firestore emulator)", () => {
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

  describe("POST .../pickups: authentication and authorization", () => {
    // One order shared by the refusals below: each only asserts that it is
    // exactly as it was. Taken out of the per-test cleanup list so it survives
    // until `afterAll`.
    let untouched: SeededOrder;
    beforeAll(async () => {
      untouched = await seedOrder(orgA, "ready");
      seededRefs.splice(seededRefs.indexOf(untouched.ref), 1);
    });
    afterAll(async () => {
      await untouched.ref.delete();
    });

    it("denies an unauthenticated caller (401) and changes nothing", async () => {
      const before = await rawOrder(untouched);

      const result = await pickup(orgA.organizationId, rejectingValidator(), {credential: qrOf(untouched)});

      expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
      expect(await rawOrder(untouched)).toEqual(before);
    });

    it("denies a request with no Authorization header (401) without consulting the validator", async () => {
      const validator = acceptingValidator(orgA.ownerId);

      const result = await pickup(orgA.organizationId, validator, {credential: qrOf(untouched)}, {headers: {}});

      expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
      expect(validator.validateSession).not.toHaveBeenCalled();
    });

    it.each([
      ["a non-member", () => customerOnly],
      ["another organization's owner", () => orgB.ownerId],
      ["a member whose membership is invited", () => invitedA],
      ["a member whose membership is revoked", () => revokedA],
      ["a member document with an unknown role", () => unknownRoleA],
    ])("denies %s (403) — even holding the genuine credential — and changes nothing", async (_label, userId) => {
      const before = await rawOrder(untouched);

      const viaQr = await pickup(orgA.organizationId, acceptingValidator(userId()), {credential: qrOf(untouched)});
      const viaCode = await pickup(orgA.organizationId, acceptingValidator(userId()), {credential: codeOf(untouched)});

      expect(viaQr).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(viaCode).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(await rawOrder(untouched)).toEqual(before);
    });

    it("denies the customer who placed the order (403): collecting it is not the same as handing it over", async () => {
      const before = await rawOrder(untouched);

      const result = await pickup(orgA.organizationId, acceptingValidator(untouched.customerId), {credential: qrOf(untouched)});

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(await rawOrder(untouched)).toEqual(before);
    });

    it("answers 403, not 404, for an organization the caller is not in, even when the credential is real", async () => {
      const foreign = await seedOrder(orgB, "ready");

      const result = await pickup(orgB.organizationId, acceptingValidator(managerA), {credential: qrOf(foreign)});

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect((await rawOrder(foreign)).status).toBe("ready");
    });

    it.each([
      ["owner", () => orgA.ownerId],
      ["manager", () => managerA],
      ["staff", () => staffA],
    ])("lets an active %s hand an order over (200)", async (_role, userId) => {
      const order = await seedOrder(orgA, "ready");

      const result = await pickup(orgA.organizationId, acceptingValidator(userId()), {credential: qrOf(order)});

      expect(result).toMatchObject({kind: "success", status: 200, userId: userId()});
      expect((await rawOrder(order)).pickedUpBy).toBe(userId());
    });

    it("re-checks membership on every request: a revoked member is refused at once", async () => {
      const temp = freshUserId();
      await addMembership(orgA.organizationId, temp, "staff");
      const first = await seedOrder(orgA, "ready");
      const second = await seedOrder(orgA, "ready");
      expect(orderOf(await pickup(orgA.organizationId, acceptingValidator(temp), {credential: qrOf(first)})).status)
        .toBe("picked_up");

      await addMembership(orgA.organizationId, temp, "staff", "revoked");
      const result = await pickup(orgA.organizationId, acceptingValidator(temp), {credential: qrOf(second)});

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect((await rawOrder(second)).status).toBe("ready");
    });
  });

  describe("POST .../pickups: the transition", () => {
    it("200 with the order's list row, and the document really changed", async () => {
      const order = await seedOrder(orgA, "ready");

      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: qrOf(order)});

      expect(result).toMatchObject({kind: "success", status: 200, userId: staffA});
      expect(orderOf(result)).toMatchObject({
        id: order.id,
        outletId: orgA.outletId,
        menuId: orgA.menuId,
        outlet: {name: orgA.outletName},
        status: "picked_up",
        paymentStatus: "paid",
        totalInPaise: 10000,
        itemCount: 2,
        items: [{name: "Seed Dish", quantity: 2}],
      });
      const doc = await rawOrder(order);
      expect(doc).toMatchObject({status: "picked_up", pickedUpBy: staffA});
      expect(orderOf(result).updatedAt).toBe((doc.updatedAt as Timestamp).toDate().toISOString());
    });

    it("accepts the typed backup code and says so in the log context", async () => {
      const order = await seedOrder(orgA, "ready");

      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: codeOf(order).toLowerCase()});

      expect(orderOf(result).status).toBe("picked_up");
      expect(result.logContext).toEqual({from: "ready", to: "picked_up", outcome: "picked_up", via: "code"});
    });

    it("is reflected by the order list the dashboard refreshes from", async () => {
      const order = await seedOrder(orgA, "ready");
      await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: qrOf(order)});

      const result = await list(orgA.organizationId, staffA);

      const rows = (result as {data: {orders: OrderRow[]}}).data.orders;
      expect(rows.find((row) => row.id === order.id)?.status).toBe("picked_up");
    });

    it("never exposes the customer, the actors, the organization, the audit fields or the credential", async () => {
      const order = await seedOrder(orgA, "ready");
      const credentials = derivePickupCredentials(SECRET, order.id);

      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: credentials.qrPayload});

      // What goes over the wire is the envelope's body; `result.userId` is only
      // the request log's field for the caller and never reaches the response.
      const responseBody = toResponseBody(result, "request-id");
      const body = JSON.stringify(responseBody);
      for (const secret of [order.customerId, staffA, orgA.organizationId, credentials.qrPayload, credentials.qrPayload.split(".")[2], credentials.code, SECRET]) {
        expect(body).not.toContain(secret);
      }
      expect(body).not.toMatch(/pickedUp|completed(At|By)|readyAt|readyBy|preparingStarted|userId|organizationId/);
      expect(Object.keys(responseBody)).toEqual(["data"]);
      expect(Object.keys((responseBody as {data: object}).data)).toEqual(["order"]);
    });

    it("keeps the credential out of the request log's context, on success and on refusal", async () => {
      const order = await seedOrder(orgA, "ready");
      const credentials = derivePickupCredentials(SECRET, order.id);

      const ok = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: credentials.qrPayload});
      const replay = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: credentials.qrPayload});
      const wrong = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: "0000-0000"});

      for (const result of [ok, replay, wrong]) {
        const logged = JSON.stringify({context: result.logContext, userId: result.userId});
        expect(logged).not.toContain(credentials.qrPayload);
        expect(logged).not.toContain(credentials.qrPayload.split(".")[2]);
        expect(logged).not.toContain(credentials.code);
        expect(logged).not.toContain("0000");
      }
      expect(replay.logContext).toEqual({to: "picked_up", outcome: "rejected"});
    });

    it("works for an order of a since-deactivated outlet", async () => {
      const order = await seedOrder(orgA, "ready", {otherOutlet: true});

      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: codeOf(order)});

      expect(orderOf(result).status).toBe("picked_up");
    });
  });

  describe("POST .../pickups: refusals leave the order untouched", () => {
    it.each<[OrderStatus, "pending" | "paid", string]>([
      ["confirmed", "paid", "This order is not ready for pickup yet."],
      ["preparing", "paid", "This order is not ready for pickup yet."],
      ["pending_payment", "pending", "This order has not been paid yet."],
      ["ready", "pending", "This order has not been paid yet."],
      ["cancelled", "paid", "This order was cancelled."],
      ["picked_up", "paid", "This order has already been picked up."],
      ["completed", "paid", "This order has already been picked up and completed."],
    ])("a %s (%s) order: 409 conflict, %s", async (status, paymentStatus, message) => {
      const order = await seedOrder(orgA, status, {paymentStatus});
      const before = await rawOrder(order);

      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: qrOf(order)});

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict", message, userId: staffA});
      expect(await rawOrder(order)).toEqual(before);
    });

    it("presenting the same credential twice is a 409 `conflict` the second time, never a second 200", async () => {
      const order = await seedOrder(orgA, "ready");
      const first = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: qrOf(order)});
      const afterFirst = await rawOrder(order);

      const second = await pickup(orgA.organizationId, acceptingValidator(managerA), {credential: qrOf(order)});
      const third = await pickup(orgA.organizationId, acceptingValidator(managerA), {credential: codeOf(order)});

      expect(first).toMatchObject({kind: "success", status: 200});
      for (const repeat of [second, third]) {
        expect(repeat).toMatchObject({kind: "error", status: 409, code: "conflict", message: "This order has already been picked up."});
      }
      expect(await rawOrder(order)).toEqual(afterFirst);
      expect(afterFirst.pickedUpBy).toBe(staffA);
    });

    it("a different outlet: 409 conflict when the counter named another outlet", async () => {
      const order = await seedOrder(orgA, "ready", {otherOutlet: true});
      const before = await rawOrder(order);

      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: qrOf(order), outletId: orgA.outletId});

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict", message: "This order is for a different outlet."});
      expect(await rawOrder(order)).toEqual(before);
    });
  });

  describe("POST .../pickups: tenant isolation and a bad credential are the same 404", () => {
    it("answers a foreign order's QR, its typed code, a forged QR, a missing order's QR and a wrong code identically", async () => {
      const foreign = await seedOrder(orgB, "ready");
      const mine = await seedOrder(orgA, "ready");
      const foreignBefore = await rawOrder(foreign);
      const caller = acceptingValidator(orgA.ownerId);

      const results = [
        await pickup(orgA.organizationId, caller, {credential: qrOf(foreign)}),
        await pickup(orgA.organizationId, caller, {credential: codeOf(foreign)}),
        await pickup(orgA.organizationId, caller, {credential: `ZP1.${mine.id}.${"A".repeat(22)}`}),
        await pickup(orgA.organizationId, caller, {credential: derivePickupCredentials(SECRET, "no-such-order").qrPayload}),
        await pickup(orgA.organizationId, caller, {credential: "0000-0000"}),
      ];

      for (const result of results) {
        expect(result).toMatchObject(NO_MATCH);
      }
      const bodies = results.map((result) => JSON.stringify(toResponseBody(result, "request-id")));
      expect(new Set(bodies).size).toBe(1);
      expect(await rawOrder(foreign)).toEqual(foreignBefore);
      expect((await rawOrder(mine)).status).toBe("ready");
    });

    it("cannot be redirected by naming the other organization elsewhere in the request", async () => {
      const foreign = await seedOrder(orgB, "ready");
      const before = await rawOrder(foreign);

      const result = await pickup(
        orgA.organizationId,
        acceptingValidator(orgA.ownerId),
        {credential: qrOf(foreign), organizationId: orgB.organizationId, outletId: orgB.outletId, orderId: foreign.id},
        {query: {organizationId: orgB.organizationId, outletId: orgB.outletId}},
      );

      expect(result).toMatchObject(NO_MATCH);
      expect(await rawOrder(foreign)).toEqual(before);
    });

    it("lets org B's own owner hand over org B's order, not org A's", async () => {
      const mine = await seedOrder(orgB, "ready");
      const theirs = await seedOrder(orgA, "ready");

      const ok = await pickup(orgB.organizationId, acceptingValidator(orgB.ownerId), {credential: qrOf(mine)});
      const denied = await pickup(orgB.organizationId, acceptingValidator(orgB.ownerId), {credential: qrOf(theirs)});

      expect(ok).toMatchObject({kind: "success", status: 200});
      expect(denied).toMatchObject(NO_MATCH);
      expect((await rawOrder(theirs)).status).toBe("ready");
    });
  });

  describe("POST .../pickups: nothing in the request is trusted", () => {
    it("ignores a body and query that try to choose the status, the actor, the organization, the order or the payment", async () => {
      const order = await seedOrder(orgA, "ready");
      const decoy = await seedOrder(orgA, "ready");

      const result = await pickup(
        orgA.organizationId,
        acceptingValidator(staffA),
        {
          credential: qrOf(order),
          status: "completed",
          paymentStatus: "paid",
          userId: "U-attacker",
          pickedUpBy: "U-attacker",
          completedBy: "U-attacker",
          organizationId: orgB.organizationId,
          orderId: decoy.id,
          updatedAt: "2000-01-01T00:00:00Z",
        },
        {query: {status: "completed", userId: "U-attacker", organizationId: orgB.organizationId, orderId: decoy.id}},
      );

      expect(orderOf(result).status).toBe("picked_up");
      const doc = await rawOrder(order);
      expect(doc.status).toBe("picked_up");
      expect(doc.pickedUpBy).toBe(staffA);
      expect(doc.completedAt).toBeUndefined();
      expect(doc.completedBy).toBeUndefined();
      expect(doc.userId).toBe(order.customerId);
      expect(doc.organizationId).toBe(orgA.organizationId);
      expect((await rawOrder(decoy)).status).toBe("ready");
    });

    it("cannot be used to mark an unpaid order picked up by claiming it paid in the body", async () => {
      const order = await seedOrder(orgA, "pending_payment");
      const before = await rawOrder(order);

      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {
        credential: qrOf(order), status: "ready", paymentStatus: "paid",
      });

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict"});
      expect(await rawOrder(order)).toEqual(before);
    });
  });

  describe("POST .../pickups: malformed input", () => {
    it.each([
      ["no body", undefined],
      ["no credential", {}],
      ["an empty credential", {credential: ""}],
      ["a numeric credential", {credential: 12345678}],
      ["a malformed outletId", {credential: "K7QX-4M2P", outletId: ".."}],
    ])("rejects %s (400) once authorized", async (_label, body) => {
      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), body);

      expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
    });

    it.each(["nope", "ABCD-EFG", "ZP1.", "ZP1.a.b"])("rejects the badly-shaped credential %j (400)", async (credential) => {
      const result = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential});

      expect(result).toMatchObject({kind: "error", status: 400, message: "That doesn't look like a Zesto pickup code."});
    });

    it("authorizes before it reads the body: a non-member gets 403, not a 400 about their body", async () => {
      const result = await pickup(orgA.organizationId, acceptingValidator(customerOnly), {credential: 12345678});

      expect(result).toMatchObject({kind: "error", status: 403});
    });
  });

  // Explicit timeout, the same convention as the fulfillment route suite:
  // transactions that contend on one document are slow in the Firestore emulator.
  describe("concurrent requests", {timeout: 30_000}, () => {
    it("two staff presenting the same QR at once: exactly one 200, the other a 409 conflict, one actor on record", async () => {
      const order = await seedOrder(orgA, "ready");

      const [fromStaff, fromManager] = await Promise.all([
        pickup(orgA.organizationId, acceptingValidator(staffA), {credential: qrOf(order)}),
        pickup(orgA.organizationId, acceptingValidator(managerA), {credential: qrOf(order)}),
      ]);

      const results = [fromStaff, fromManager];
      expect(results.filter((result) => result.kind === "success")).toHaveLength(1);
      const loser = results.find((result) => result.kind === "error");
      expect(loser).toMatchObject({kind: "error", status: 409, code: "conflict"});
      const doc = await rawOrder(order);
      expect(doc.status).toBe("picked_up");
      expect([staffA, managerA]).toContain(doc.pickedUpBy);
      expect(doc.updatedAt).toEqual(doc.pickedUpAt);
    });

    it("the same order by QR at one counter and by typed code at another: still exactly one 200", async () => {
      const order = await seedOrder(orgA, "ready");

      const results = await Promise.all([
        pickup(orgA.organizationId, acceptingValidator(staffA), {credential: qrOf(order)}),
        pickup(orgA.organizationId, acceptingValidator(managerA), {credential: codeOf(order)}),
      ]);

      expect(results.filter((result) => result.kind === "success")).toHaveLength(1);
      expect(results.find((result) => result.kind === "error")).toMatchObject({status: 409, code: "conflict"});
    });
  });

  describe("POST .../orders/:orderId/complete", () => {
    it.each([
      ["owner", () => orgA.ownerId],
      ["manager", () => managerA],
      ["staff", () => staffA],
    ])("lets an active %s complete a picked-up order (200)", async (_role, userId) => {
      const order = await seedOrder(orgA, "picked_up", {extra: {pickedUpAt: READY_AT, pickedUpBy: "U-picker"}});

      const result = await complete(orgA.organizationId, order.id, acceptingValidator(userId()));

      expect(result).toMatchObject({kind: "success", status: 200, userId: userId()});
      expect(orderOf(result).status).toBe("completed");
      const doc = await rawOrder(order);
      expect(doc).toMatchObject({status: "completed", completedBy: userId(), pickedUpBy: "U-picker"});
    });

    it.each([
      ["a non-member", () => customerOnly],
      ["another organization's owner", () => orgB.ownerId],
      ["a member whose membership is invited", () => invitedA],
      ["a member whose membership is revoked", () => revokedA],
      ["a member document with an unknown role", () => unknownRoleA],
    ])("denies %s (403) and changes nothing", async (_label, userId) => {
      const order = await seedOrder(orgA, "picked_up");
      const before = await rawOrder(order);

      const result = await complete(orgA.organizationId, order.id, acceptingValidator(userId()));

      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
      expect(await rawOrder(order)).toEqual(before);
    });

    it("denies the customer who placed the order (403)", async () => {
      const order = await seedOrder(orgA, "picked_up");

      const result = await complete(orgA.organizationId, order.id, acceptingValidator(order.customerId));

      expect(result).toMatchObject({kind: "error", status: 403});
      expect((await rawOrder(order)).status).toBe("picked_up");
    });

    it("repeating it is a 200 that changes nothing: the first person stays on record", async () => {
      const order = await seedOrder(orgA, "picked_up");
      const first = await complete(orgA.organizationId, order.id, acceptingValidator(staffA));
      const afterFirst = await rawOrder(order);

      const second = await complete(orgA.organizationId, order.id, acceptingValidator(managerA));

      expect(second).toMatchObject({kind: "success", status: 200});
      expect(orderOf(second)).toEqual(orderOf(first));
      expect(await rawOrder(order)).toEqual(afterFirst);
      expect(afterFirst.completedBy).toBe(staffA);
    });

    it.each<[OrderStatus, "pending" | "paid", string]>([
      ["confirmed", "paid", "This order has not been picked up yet."],
      ["preparing", "paid", "This order has not been picked up yet."],
      ["ready", "paid", "This order has not been picked up yet."],
      ["pending_payment", "pending", "This order has not been paid yet."],
      ["cancelled", "paid", "This order is cancelled, so it can't be moved to completed."],
    ])("a %s (%s) order: 409 conflict, %s", async (status, paymentStatus, message) => {
      const order = await seedOrder(orgA, status, {paymentStatus});
      const before = await rawOrder(order);

      const result = await complete(orgA.organizationId, order.id, acceptingValidator(staffA));

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict", message});
      expect(await rawOrder(order)).toEqual(before);
    });

    it("answers another organization's order exactly as a missing one (404)", async () => {
      const foreign = await seedOrder(orgB, "picked_up");
      const before = await rawOrder(foreign);

      const missing = await complete(orgA.organizationId, "no-such-order", acceptingValidator(orgA.ownerId));
      const crossTenant = await complete(orgA.organizationId, foreign.id, acceptingValidator(orgA.ownerId));

      expect(missing).toMatchObject({kind: "error", status: 404, code: "not_found"});
      expect(crossTenant).toEqual(missing);
      expect(await rawOrder(foreign)).toEqual(before);
    });

    it("ignores a body that tries to choose the status or the actor", async () => {
      const order = await seedOrder(orgA, "picked_up");

      const result = await complete(orgA.organizationId, order.id, acceptingValidator(staffA), {
        body: {status: "ready", completedBy: "U-attacker", userId: "U-attacker"},
        query: {organizationId: orgB.organizationId},
      });

      expect(orderOf(result).status).toBe("completed");
      expect((await rawOrder(order)).completedBy).toBe(staffA);
    });

    it("never exposes the customer, the actors or the audit fields", async () => {
      const order = await seedOrder(orgA, "picked_up", {extra: {pickedUpAt: READY_AT, pickedUpBy: "U-picker"}});

      const result = await complete(orgA.organizationId, order.id, acceptingValidator(staffA));

      const body = JSON.stringify(toResponseBody(result, "request-id"));
      for (const secret of [order.customerId, staffA, "U-picker", orgA.organizationId]) {
        expect(body).not.toContain(secret);
      }
      expect(body).not.toMatch(/pickedUp|completed(At|By)|readyAt|userId|organizationId/);
    });

    it("there is no route that completes an order that was never picked up, not even by naming its own ID", async () => {
      const order = await seedOrder(orgA, "ready");

      const viaComplete = await complete(orgA.organizationId, order.id, acceptingValidator(staffA));

      expect(viaComplete).toMatchObject({kind: "error", status: 409});
      expect((await rawOrder(order)).status).toBe("ready");
    });
  });

  describe("GET /orders/:orderId/pickup-credential (the customer)", () => {
    it("gives the order's own customer exactly {pickup: {qrPayload, code}} — nothing else", async () => {
      const order = await seedOrder(orgA, "ready");

      const result = await credentialOf(order.id, acceptingValidator(order.customerId));

      expect(result).toMatchObject({kind: "success", status: 200, userId: order.customerId});
      expect(toResponseBody(result, "request-id")).toEqual({data: {pickup: derivePickupCredentials(SECRET, order.id)}});
    });

    it("never exposes the customer, the audit fields, the organization, outlet or menu, or the secret", async () => {
      const order = await seedOrder(orgA, "ready");

      const result = await credentialOf(order.id, acceptingValidator(order.customerId));

      const text = JSON.stringify(toResponseBody(result, "request-id"));
      for (const forbidden of [order.customerId, "U-original-ready", orgA.organizationId, orgA.outletId, orgA.menuId, SECRET]) {
        expect(text).not.toContain(forbidden);
      }
      expect(text).not.toMatch(/readyAt|readyBy|userId|razorpay|provider/i);
    });

    it("answers an unrelated customer with the SAME 404 as an order that does not exist", async () => {
      const order = await seedOrder(orgA, "ready");
      const stranger = acceptingValidator(freshUserId());

      const wrongCustomer = await credentialOf(order.id, stranger);
      const missing = await credentialOf("no-such-order", stranger);

      expect(wrongCustomer).toMatchObject({kind: "error", status: 404, code: "not_found"});
      expect(toResponseBody(wrongCustomer, "request-id")).toEqual(toResponseBody(missing, "request-id"));
    });

    it.each([
      ["the organization's owner", () => orgA.ownerId],
      ["a manager", () => managerA],
      ["a staff member", () => staffA],
      ["another organization's owner", () => orgB.ownerId],
    ])("gives %s no access: they are not the order's customer (404)", async (_label, userId) => {
      const order = await seedOrder(orgA, "ready");

      const result = await credentialOf(order.id, acceptingValidator(userId()));

      expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
    });

    it("denies an unauthenticated caller (401)", async () => {
      const order = await seedOrder(orgA, "ready");

      const result = await credentialOf(order.id, rejectingValidator());

      expect(result).toMatchObject({kind: "error", status: 401, code: "unauthenticated"});
    });

    it("cannot be pointed at another customer by a userId in the query or a header", async () => {
      const order = await seedOrder(orgA, "ready");

      const result = await handleRequest(
        createOrderRoutes({db, validator: acceptingValidator(freshUserId()), pickupSecret}),
        baseRequest({
          method: "GET",
          path: `/orders/${order.id}/pickup-credential`,
          query: {userId: order.customerId},
          headers: {"authorization": "Bearer token", "x-user-id": order.customerId},
        }),
        () => {},
      );

      expect(result).toMatchObject({kind: "error", status: 404});
    });

    it.each<[OrderStatus, "pending" | "paid"]>([
      ["pending_payment", "pending"],
      ["confirmed", "paid"],
      ["preparing", "paid"],
      ["picked_up", "paid"],
      ["completed", "paid"],
      ["cancelled", "paid"],
    ])("answers the customer's own %s (%s) order with 409 `conflict`", async (status, paymentStatus) => {
      const order = await seedOrder(orgA, status, {paymentStatus});

      const result = await credentialOf(order.id, acceptingValidator(order.customerId));

      expect(result).toMatchObject({kind: "error", status: 409, code: "conflict", message: "This order isn't ready for pickup."});
    });

    it("is not part of the order the customer reads, nor of the order list", async () => {
      const customerId = freshUserId();
      const order = await seedOrder(orgA, "ready", {userId: customerId});
      const credentials = derivePickupCredentials(SECRET, order.id);

      const detail = JSON.stringify(toResponseBody(await readOrder(order.id, customerId), "request-id"));
      const staffList = JSON.stringify(toResponseBody(await list(orgA.organizationId, staffA), "request-id"));

      for (const text of [detail, staffList]) {
        expect(text).not.toContain(credentials.qrPayload);
        expect(text).not.toContain(credentials.qrPayload.split(".")[2]);
        expect(text).not.toContain(credentials.code);
        expect(text).not.toMatch(/qrPayload|pickup-credential|"code"/);
      }
    });

    it("writes nothing: fetching it leaves the order exactly as it was", async () => {
      const order = await seedOrder(orgA, "ready");
      const before = await rawOrder(order);

      await credentialOf(order.id, acceptingValidator(order.customerId));
      await credentialOf(order.id, acceptingValidator(order.customerId));

      expect(await rawOrder(order)).toEqual(before);
      expect(await order.ref.listCollections()).toHaveLength(0);
    });
  });

  describe("the whole lifecycle through the real routes", () => {
    it("ready -> customer shows the credential -> staff hand over -> credential dead -> completed -> nothing left to do", async () => {
      const customerId = freshUserId();
      const order = await seedOrder(orgA, "ready", {userId: customerId});

      /** The status the customer's own order detail reports. */
      const customerSees = async () => {
        const detail = await readOrder(order.id, customerId);
        if (detail.kind !== "success") {
          throw new Error(`expected success, got ${JSON.stringify(detail)}`);
        }
        return (detail.data as {order: OrderRow}).order.status;
      };

      // The customer's screen: the credential, and an order that says ready.
      const credentials = pickupOf(await credentialOf(order.id, acceptingValidator(customerId)));
      expect(await customerSees()).toBe("ready");

      // The counter: scan the QR.
      const handedOver = await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: credentials.qrPayload, outletId: orgA.outletId});
      expect(orderOf(handedOver).status).toBe("picked_up");

      // The customer's screen again: the credential is gone and the order says picked up.
      expect(await credentialOf(order.id, acceptingValidator(customerId))).toMatchObject({kind: "error", status: 409, code: "conflict"});
      expect(await customerSees()).toBe("picked_up");

      // A second counter presents the same credential (a screenshot, say): refused.
      expect(await pickup(orgA.organizationId, acceptingValidator(managerA), {credential: credentials.code}))
        .toMatchObject({kind: "error", status: 409, code: "conflict"});

      // Close out.
      const completed = await complete(orgA.organizationId, order.id, acceptingValidator(managerA));
      expect(orderOf(completed).status).toBe("completed");
      expect(await customerSees()).toBe("completed");

      // Terminal: nothing moves it again, and nothing is left to claim.
      expect(await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: credentials.qrPayload}))
        .toMatchObject({kind: "error", status: 409, message: "This order has already been picked up and completed."});
      expect(await pickup(orgA.organizationId, acceptingValidator(staffA), {credential: credentials.code}))
        .toMatchObject(NO_MATCH);
      expect(await credentialOf(order.id, acceptingValidator(customerId))).toMatchObject({status: 409});
      const doc = await rawOrder(order);
      expect(doc).toMatchObject({status: "completed", pickedUpBy: staffA, completedBy: managerA, readyBy: "U-original-ready"});
    });
  });
});

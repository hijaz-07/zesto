// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import {listOwnedOrders} from "./orderHistory";
import {transitionOrderStatus} from "./orderFulfillment";
import {
  getPickupCredentialForCustomer,
  redeemPickup,
  type RedeemPickupResult,
} from "./orderPickup";
import {getOwnedOrder, type OrderStatus} from "./orders";
import {listOrganizationOrders} from "./organizationOrders";
import {createMenu} from "./menus";
import {createOrganization} from "./organizations";
import {createOutlet, updateOutlet} from "./outlets";
import {markPaymentFailed, markPaymentSucceeded} from "./payments";
import {derivePickupCredentials} from "./pickupCredential";
import {businessDateString} from "../time";

/**
 * `redeemPickup`, `getPickupCredentialForCustomer` and the `completed`
 * fulfillment step against a REAL Firestore emulator: the transactions, the
 * documents they actually write (and the ones they must leave alone), tenant
 * scoping, replay, and concurrent callers. The organization/outlet/menu chain
 * is built through the domain functions; orders are written directly with the
 * exact shape `createOrder` writes, in whatever state a test needs.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own, not the one every other emulator suite
// shares — the same reasoning as `orderFulfillment.emulator.test.ts`: the
// deliberately contended transactions below must not slow other suites' order
// lookups down. The project id appears nowhere in the code under test.
const PROJECT_ID = "demo-zesto-pickup-domain";

// Made up for these tests; the real one lives only in Secret Manager.
const SECRET = "test-pickup-secret-0123456789-abcdefghij";
const getSecret = () => SECRET;

let db: Firestore;

// Per-file (not global) setting, the same convention and reasoning as
// `orderFulfillment.emulator.test.ts` / `payments.emulator.test.ts`.
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
// slow every lookup: delete them after each test.
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
  /** The outlet orders are seeded under by default. */
  outletId: string;
  menuId: string;
  /** A SECOND outlet of the same organization (deactivated), for outlet-narrowing tests. */
  otherOutletId: string;
  otherMenuId: string;
}

async function buildOrg(label: string): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  const outlet = await createOutlet(db, organization.id, ownerId, freshOutletInput(`${label} Main Canteen`));
  const other = await createOutlet(db, organization.id, ownerId, freshOutletInput(`${label} Old Annex`));
  const menu = await createDraftMenu(organization.id, outlet.id, ownerId);
  const otherMenu = await createDraftMenu(organization.id, other.id, ownerId);
  await updateOutlet(db, organization.id, other.id, {status: "inactive"});
  return {
    organizationId: organization.id,
    outletId: outlet.id,
    menuId: menu.id,
    otherOutletId: other.id,
    otherMenuId: otherMenu.id,
  };
}

const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));
const READY_AT = Timestamp.fromDate(new Date("2026-09-01T07:00:00Z"));

interface SeedOrderInput {
  org: OrgFixture;
  status: OrderStatus;
  paymentStatus?: "pending" | "paid";
  userId?: string;
  /** Seed the order under the organization's second outlet instead. */
  otherOutlet?: boolean;
  extra?: Record<string, unknown>;
}

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
  org: OrgFixture;
}

async function seedOrder(input: SeedOrderInput): Promise<SeededOrder> {
  const {org} = input;
  const outletId = input.otherOutlet ? org.otherOutletId : org.outletId;
  const menuId = input.otherOutlet ? org.otherMenuId : org.menuId;
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("orders").doc();
  seededRefs.push(ref);
  const customerId = input.userId ?? freshUserId();
  const reachedReady = ["ready", "picked_up", "completed"].includes(input.status);
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
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: 10000}],
    createdAt: CREATED_AT,
    updatedAt: reachedReady ? READY_AT : CREATED_AT,
    ...(reachedReady ? {readyAt: READY_AT, readyBy: "U-original-ready"} : {}),
    ...input.extra,
  });
  return {id: ref.id, ref, customerId, org};
}

async function rawOrder(order: SeededOrder): Promise<Record<string, unknown>> {
  const data = (await order.ref.get()).data();
  if (!data) {
    throw new Error(`order ${order.id} is gone`);
  }
  return data;
}

/** `data` without the named fields. */
function without(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)));
}

function qrOf(order: SeededOrder): string {
  return derivePickupCredentials(SECRET, order.id).qrPayload;
}

function codeOf(order: SeededOrder): string {
  return derivePickupCredentials(SECRET, order.id).code;
}

function redeem(
  who: OrganizationMembership,
  credential: unknown,
  extra: {outletId?: unknown} = {},
): Promise<RedeemPickupResult> {
  return redeemPickup(db, {membership: who, credential, getSecret, ...extra});
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

const NO_MATCH = "No order awaiting pickup matches this code.";

describe("redeemPickup (Firestore emulator)", () => {
  let orgA: OrgFixture;
  let orgB: OrgFixture;

  beforeAll(async () => {
    orgA = await buildOrg("Org A");
    orgB = await buildOrg("Org B");
  });

  describe("the transition", () => {
    it("moves a ready, paid order to picked_up with a QR payload, writing the actor and time and nothing else", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const before = await rawOrder(order);
      const actor = member(orgA.organizationId);

      const result = await redeem(actor, qrOf(order));

      expect(result.via).toBe("qr");
      expect(result.order).toMatchObject({id: order.id, status: "picked_up", pickedUpBy: actor.userId});
      const after = await rawOrder(order);
      expect(after).toMatchObject({status: "picked_up", pickedUpBy: actor.userId});
      expect(after.pickedUpAt).toBeInstanceOf(Timestamp);
      expect(after.updatedAt).toEqual(after.pickedUpAt);
      expect((after.updatedAt as Timestamp).toMillis()).toBeGreaterThan(READY_AT.toMillis());
      // Everything else — the customer, the money, the items, the earlier audit — is untouched.
      expect(without(after, ["status", "pickedUpAt", "pickedUpBy", "updatedAt"]))
        .toEqual(without(before, ["status", "updatedAt"]));
      expect(after.completedAt).toBeUndefined();
      expect(after.completedBy).toBeUndefined();
    });

    it.each([
      ["as displayed", (code: string) => code],
      ["in lower case", (code: string) => code.toLowerCase()],
      ["with spaces for the hyphen", (code: string) => code.replace("-", " ")],
      ["without the hyphen", (code: string) => code.replace("-", "")],
    ])("moves it with the typed backup code %s", async (_label, typed) => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const actor = member(orgA.organizationId);

      const result = await redeem(actor, typed(codeOf(order)));

      expect(result.via).toBe("code");
      expect(result.order.status).toBe("picked_up");
      expect(await rawOrder(order)).toMatchObject({status: "picked_up", pickedUpBy: actor.userId});
    });

    it("finds the right order among several awaiting pickup, and touches only that one", async () => {
      const target = await seedOrder({org: orgA, status: "ready"});
      const others = [
        await seedOrder({org: orgA, status: "ready"}),
        await seedOrder({org: orgA, status: "ready", otherOutlet: true}),
        await seedOrder({org: orgA, status: "ready"}),
      ];
      const othersBefore = await Promise.all(others.map(rawOrder));

      await redeem(member(orgA.organizationId), codeOf(target));

      expect((await rawOrder(target)).status).toBe("picked_up");
      expect(await Promise.all(others.map(rawOrder))).toEqual(othersBefore);
    });

    it.each(["owner", "manager", "staff"] as const)("lets an active %s do it", async (role) => {
      const order = await seedOrder({org: orgA, status: "ready"});

      await expect(redeem(member(orgA.organizationId, role), qrOf(order))).resolves.toMatchObject({via: "qr"});
    });

    it("works for an order of a since-deactivated outlet: its customer has already paid", async () => {
      const order = await seedOrder({org: orgA, status: "ready", otherOutlet: true});

      const result = await redeem(member(orgA.organizationId), codeOf(order));

      expect(result.order.status).toBe("picked_up");
    });

    it("records the VERIFIED member as the actor and keeps the earlier audit trail", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const actor = member(orgA.organizationId, "manager");

      await redeem(actor, qrOf(order));

      const doc = await rawOrder(order);
      expect(doc.pickedUpBy).toBe(actor.userId);
      expect(doc.readyBy).toBe("U-original-ready");
      expect(doc.readyAt).toEqual(READY_AT);
    });
  });

  describe("authorization", () => {
    it.each(["invited", "revoked"] as const)("refuses a %s membership (403) and changes nothing", async (status) => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const before = await rawOrder(order);

      const error = await rejectionOf(redeem({...member(orgA.organizationId), status}, qrOf(order)));

      expect(error.code).toBe("permission-denied");
      expect(await rawOrder(order)).toEqual(before);
    });

    it("refuses a role outside the pickup roles (403)", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const unknownRole = "superadmin" as unknown as OrganizationMemberRole;

      const error = await rejectionOf(redeem(member(orgA.organizationId, unknownRole), qrOf(order)));

      expect(error.code).toBe("permission-denied");
      expect((await rawOrder(order)).status).toBe("ready");
    });
  });

  describe("tenant isolation: another organization's order is indistinguishable from no order", () => {
    it("answers the same 404 for a QR of a foreign order, a forged QR, a QR for a missing order and a wrong code", async () => {
      const foreign = await seedOrder({org: orgB, status: "ready"});
      const mine = await seedOrder({org: orgA, status: "ready"});
      const foreignBefore = await rawOrder(foreign);
      const actor = member(orgA.organizationId);

      const crossTenant = await rejectionOf(redeem(actor, qrOf(foreign)));
      const forged = await rejectionOf(redeem(actor, `ZP1.${mine.id}.${"A".repeat(22)}`));
      const missing = await rejectionOf(redeem(actor, derivePickupCredentials(SECRET, "no-such-order-anywhere").qrPayload));
      const wrongCode = await rejectionOf(redeem(actor, "0000-0000"));

      for (const error of [crossTenant, forged, missing, wrongCode]) {
        expect(error.code).toBe("not-found");
        expect(error.message).toBe(NO_MATCH);
      }
      expect(await rawOrder(foreign)).toEqual(foreignBefore);
      expect((await rawOrder(mine)).status).toBe("ready");
    });

    it("cannot be opened by the foreign order's typed code either: it is never even a candidate", async () => {
      const foreign = await seedOrder({org: orgB, status: "ready"});
      const before = await rawOrder(foreign);

      const error = await rejectionOf(redeem(member(orgA.organizationId), codeOf(foreign)));

      expect(error).toMatchObject({code: "not-found", message: NO_MATCH});
      expect(await rawOrder(foreign)).toEqual(before);
    });

    it("lets org B's own staff hand over org B's order, not org A's", async () => {
      const mine = await seedOrder({org: orgB, status: "ready"});
      const theirs = await seedOrder({org: orgA, status: "ready"});
      const staffB = member(orgB.organizationId);

      await redeem(staffB, qrOf(mine));
      const denied = await rejectionOf(redeem(staffB, qrOf(theirs)));

      expect(denied.code).toBe("not-found");
      expect((await rawOrder(theirs)).status).toBe("ready");
    });

    it("does not reveal a foreign order's state: a picked-up foreign order is still just 'no match'", async () => {
      const foreign = await seedOrder({org: orgB, status: "picked_up", extra: {pickedUpAt: READY_AT, pickedUpBy: "U-x"}});

      const error = await rejectionOf(redeem(member(orgA.organizationId), qrOf(foreign)));

      expect(error.message).toBe(NO_MATCH);
    });
  });

  describe("the credential", () => {
    it("refuses a proof made with a different secret (as after a rotation) with the same 404", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const stale = derivePickupCredentials("a-previous-secret-0123456789-abcdefghijk", order.id);

      const viaQr = await rejectionOf(redeem(member(orgA.organizationId), stale.qrPayload));
      const viaCode = await rejectionOf(redeem(member(orgA.organizationId), stale.code));

      expect(viaQr.message).toBe(NO_MATCH);
      expect(viaCode.message).toBe(NO_MATCH);
      expect((await rawOrder(order)).status).toBe("ready");
    });

    it("refuses another order's genuine proof re-labelled with this order's ID", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const other = await seedOrder({org: orgA, status: "ready"});
      const stolenProof = qrOf(other).split(".")[2];

      const error = await rejectionOf(redeem(member(orgA.organizationId), `ZP1.${order.id}.${stolenProof}`));

      expect(error.code).toBe("not-found");
      expect((await rawOrder(order)).status).toBe("ready");
      expect((await rawOrder(other)).status).toBe("ready");
    });

    it("answers a guess made from the order's ID alone with the same 404", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});

      const error = await rejectionOf(
        redeem(member(orgA.organizationId), `ZP1.${order.id}.${Buffer.from(order.id).toString("base64url").slice(0, 22)}`),
      );

      expect(error.code).toBe("not-found");
      expect((await rawOrder(order)).status).toBe("ready");
    });

    it.each(["", "nope", "ZP1.", "ABCD-EFG", 12345678, null])("refuses the malformed credential %j (400)", async (credential) => {
      const error = await rejectionOf(redeem(member(orgA.organizationId), credential));

      expect(error.code).toBe("invalid-argument");
    });

    it("never stores the credential anywhere: not on the order, and not after a customer fetched it either", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const fetched = await getPickupCredentialForCustomer(db, order.customerId, order.id, getSecret);
      await redeem(member(orgA.organizationId), fetched.qrPayload);

      const text = JSON.stringify(await rawOrder(order));
      const proof = fetched.qrPayload.split(".")[2];
      expect(text).not.toContain(proof);
      expect(text).not.toContain(fetched.qrPayload);
      expect(text.toUpperCase()).not.toContain(fetched.code.replace("-", ""));
      expect(text).not.toContain(fetched.code);
      expect(text).not.toContain(SECRET);
      // Nothing was created under the order, either (no credential, no payment).
      expect((await order.ref.listCollections()).map((collection) => collection.id)).toEqual([]);
    });
  });

  describe("the outlet check only ever narrows", () => {
    it("refuses an order of a different outlet (409) when the counter named another, and changes nothing", async () => {
      const order = await seedOrder({org: orgA, status: "ready", otherOutlet: true});
      const before = await rawOrder(order);

      const error = await rejectionOf(redeem(member(orgA.organizationId), qrOf(order), {outletId: orgA.outletId}));

      expect(error).toMatchObject({code: "aborted", message: "This order is for a different outlet."});
      expect(await rawOrder(order)).toEqual(before);
    });

    it("applies the same check to a typed code", async () => {
      const order = await seedOrder({org: orgA, status: "ready", otherOutlet: true});

      const error = await rejectionOf(redeem(member(orgA.organizationId), codeOf(order), {outletId: orgA.outletId}));

      expect(error.message).toBe("This order is for a different outlet.");
      expect((await rawOrder(order)).status).toBe("ready");
    });

    it("accepts the order's own outlet, and an unspecified one", async () => {
      const named = await seedOrder({org: orgA, status: "ready"});
      const unnamed = await seedOrder({org: orgA, status: "ready", otherOutlet: true});

      await redeem(member(orgA.organizationId), qrOf(named), {outletId: orgA.outletId});
      await redeem(member(orgA.organizationId), qrOf(unnamed));

      expect((await rawOrder(named)).status).toBe("picked_up");
      expect((await rawOrder(unnamed)).status).toBe("picked_up");
    });

    it("cannot be used to reach another organization's order by naming that organization's outlet", async () => {
      const foreign = await seedOrder({org: orgB, status: "ready"});

      const error = await rejectionOf(redeem(member(orgA.organizationId), qrOf(foreign), {outletId: orgB.outletId}));

      expect(error.message).toBe(NO_MATCH);
      expect((await rawOrder(foreign)).status).toBe("ready");
    });

    it("says nothing about the outlet to a caller without the genuine credential", async () => {
      const order = await seedOrder({org: orgA, status: "ready", otherOutlet: true});

      const error = await rejectionOf(
        redeem(member(orgA.organizationId), `ZP1.${order.id}.${"A".repeat(22)}`, {outletId: orgA.outletId}),
      );

      expect(error.message).toBe(NO_MATCH);
    });
  });

  describe("eligibility: only a paid, ready order can be handed over", () => {
    it.each<[OrderStatus, "pending" | "paid", string]>([
      ["confirmed", "paid", "This order is not ready for pickup yet."],
      ["preparing", "paid", "This order is not ready for pickup yet."],
      ["pending_payment", "pending", "This order has not been paid yet."],
      ["ready", "pending", "This order has not been paid yet."],
      ["cancelled", "paid", "This order was cancelled."],
      ["cancelled", "pending", "This order was cancelled."],
      ["picked_up", "paid", "This order has already been picked up."],
      ["completed", "paid", "This order has already been picked up and completed."],
    ])("refuses a %s (%s) order with a 409 and changes nothing: %s", async (status, paymentStatus, message) => {
      const order = await seedOrder({org: orgA, status, paymentStatus});
      const before = await rawOrder(order);

      const viaQr = await rejectionOf(redeem(member(orgA.organizationId), qrOf(order)));

      expect(viaQr).toMatchObject({code: "aborted", message});
      expect(viaQr.httpErrorCode.status).toBe(409);
      expect(await rawOrder(order)).toEqual(before);
    });
  });

  describe("replay: a second claim is a 409, never a second success", () => {
    it("refuses the same QR again and leaves the first pickup on record", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const first = member(orgA.organizationId);
      await redeem(first, qrOf(order));
      const afterFirst = await rawOrder(order);

      const error = await rejectionOf(redeem(member(orgA.organizationId, "manager"), qrOf(order)));

      expect(error).toMatchObject({code: "aborted", message: "This order has already been picked up."});
      expect(await rawOrder(order)).toEqual(afterFirst);
      expect(afterFirst.pickedUpBy).toBe(first.userId);
    });

    it("refuses the same typed code again: 'already picked up' while the order is picked up, 'no match' once completed", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const staff = member(orgA.organizationId);
      await redeem(staff, codeOf(order));

      const whilePickedUp = await rejectionOf(redeem(staff, codeOf(order)));
      await transitionOrderStatus(db, {membership: staff, orderId: order.id, to: "completed"});
      const afterCompletion = await rejectionOf(redeem(staff, codeOf(order)));

      expect(whilePickedUp.message).toBe("This order has already been picked up.");
      expect(afterCompletion.message).toBe(NO_MATCH);
      expect((await rawOrder(order)).status).toBe("completed");
    });

    it("refuses a QR for a completed order with 'already picked up and completed'", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const staff = member(orgA.organizationId);
      await redeem(staff, qrOf(order));
      await transitionOrderStatus(db, {membership: staff, orderId: order.id, to: "completed"});

      const error = await rejectionOf(redeem(staff, qrOf(order)));

      expect(error.message).toBe("This order has already been picked up and completed.");
    });
  });

  // Explicit timeout, the same convention as `orderFulfillment.emulator.test.ts`:
  // transactions that contend on one document are slow in the Firestore emulator.
  describe("concurrent requests", {timeout: 30_000}, () => {
    it("two staff presenting the same QR at once: exactly one pickup, the other refused, one actor on record", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const alice = member(orgA.organizationId);
      const bob = member(orgA.organizationId, "manager");

      const results = await Promise.allSettled([redeem(alice, qrOf(order)), redeem(bob, qrOf(order))]);

      const winners = results.filter((result) => result.status === "fulfilled");
      const losers = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].reason).toBeInstanceOf(HttpsError);
      expect((losers[0].reason as HttpsError).httpErrorCode.status).toBe(409);
      expect((losers[0].reason as HttpsError).message).toMatch(
        /^(This order has already been picked up\.|This order was just changed by someone else\. Refresh and try again\.)$/,
      );
      const doc = await rawOrder(order);
      expect(doc.status).toBe("picked_up");
      expect([alice.userId, bob.userId]).toContain(doc.pickedUpBy);
      expect(doc.updatedAt).toEqual(doc.pickedUpAt);
    });

    it("the same order presented by QR to one counter and by typed code to another: still exactly one pickup", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const alice = member(orgA.organizationId);
      const bob = member(orgA.organizationId);

      const results = await Promise.allSettled([redeem(alice, qrOf(order)), redeem(bob, codeOf(order))]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect((loser?.reason as HttpsError).httpErrorCode.status).toBe(409);
      expect([alice.userId, bob.userId]).toContain((await rawOrder(order)).pickedUpBy);
    });

    // Three racers (QR and typed code mixed) already prove "exactly one wins" beyond two; every
    // extra racer only adds lock contention in the emulator, which is why it is not five.
    it("three counters at once: exactly one wins and the other two are refused cleanly", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const staff = Array.from({length: 3}, () => member(orgA.organizationId));

      const results = await Promise.allSettled(staff.map((who, index) => redeem(who, index % 2 === 0 ? qrOf(order) : codeOf(order))));

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(HttpsError);
          expect((result.reason as HttpsError).httpErrorCode.status).toBe(409);
        }
      }
      expect((await rawOrder(order)).status).toBe("picked_up");
    });

    it("different orders picked up at the same time do not interfere", async () => {
      const orders = await Promise.all([1, 2, 3].map(() => seedOrder({org: orgA, status: "ready"})));

      const results = await Promise.all(orders.map((order) => redeem(member(orgA.organizationId), qrOf(order))));

      expect(results.map((result) => result.order.status)).toEqual(["picked_up", "picked_up", "picked_up"]);
    });

    it("a completion racing a pickup on a ready order can never complete an order that was not picked up", async () => {
      const order = await seedOrder({org: orgA, status: "ready"});
      const picker = member(orgA.organizationId);
      const closer = member(orgA.organizationId);

      const [pickup, completion] = await Promise.allSettled([
        redeem(picker, qrOf(order)),
        transitionOrderStatus(db, {membership: closer, orderId: order.id, to: "completed"}),
      ]);

      expect(pickup.status).toBe("fulfilled");
      const doc = await rawOrder(order);
      if (completion.status === "fulfilled") {
        // The completion ran after the pickup committed: legitimate, and both are on record in order.
        expect(doc).toMatchObject({status: "completed", pickedUpBy: picker.userId, completedBy: closer.userId});
        expect((doc.completedAt as Timestamp).toMillis()).toBeGreaterThanOrEqual((doc.pickedUpAt as Timestamp).toMillis());
      } else {
        expect((completion.reason as HttpsError).httpErrorCode.status).toBe(409);
        expect(doc.status).toBe("picked_up");
        expect(doc.completedAt).toBeUndefined();
      }
      expect(doc.pickedUpAt).toBeInstanceOf(Timestamp);
    });
  });
});

describe("completing an order (Firestore emulator)", () => {
  let org: OrgFixture;
  let otherOrg: OrgFixture;

  beforeAll(async () => {
    org = await buildOrg("Complete");
    otherOrg = await buildOrg("Complete other");
  });

  const complete = (who: OrganizationMembership, orderId: string) =>
    transitionOrderStatus(db, {membership: who, orderId, to: "completed"});

  it("moves a picked-up, paid order to completed, writing the actor and time and nothing else", async () => {
    const order = await seedOrder({org, status: "picked_up", extra: {pickedUpAt: READY_AT, pickedUpBy: "U-picker"}});
    const before = await rawOrder(order);
    const actor = member(org.organizationId);

    const result = await complete(actor, order.id);

    expect(result).toMatchObject({changed: true, previousStatus: "picked_up"});
    const after = await rawOrder(order);
    expect(after).toMatchObject({status: "completed", completedBy: actor.userId});
    expect(after.updatedAt).toEqual(after.completedAt);
    expect(without(after, ["status", "completedAt", "completedBy", "updatedAt"]))
      .toEqual(without(before, ["status", "updatedAt"]));
  });

  it.each(["owner", "manager", "staff"] as const)("lets an active %s do it", async (role) => {
    const order = await seedOrder({org, status: "picked_up"});

    await expect(complete(member(org.organizationId, role), order.id)).resolves.toMatchObject({changed: true});
  });

  it("repeating it is a no-op: the first person stays on record and nothing moves", async () => {
    const order = await seedOrder({org, status: "picked_up"});
    const first = member(org.organizationId);
    await complete(first, order.id);
    const afterFirst = await rawOrder(order);

    const repeat = await complete(member(org.organizationId, "manager"), order.id);

    expect(repeat).toMatchObject({changed: false, previousStatus: "completed"});
    expect(await rawOrder(order)).toEqual(afterFirst);
    expect(afterFirst.completedBy).toBe(first.userId);
  });

  it.each<[OrderStatus, "pending" | "paid", string]>([
    ["confirmed", "paid", "This order has not been picked up yet."],
    ["preparing", "paid", "This order has not been picked up yet."],
    ["ready", "paid", "This order has not been picked up yet."],
    ["pending_payment", "pending", "This order has not been paid yet."],
    ["cancelled", "paid", "This order is cancelled, so it can't be moved to completed."],
    ["picked_up", "pending", "This order has not been paid yet."],
  ])("refuses a %s (%s) order with a 409 and changes nothing: %s", async (status, paymentStatus, message) => {
    const order = await seedOrder({org, status, paymentStatus});
    const before = await rawOrder(order);

    const error = await rejectionOf(complete(member(org.organizationId), order.id));

    expect(error).toMatchObject({code: "aborted", message});
    expect(await rawOrder(order)).toEqual(before);
  });

  it("answers another organization's order exactly as a missing one (404)", async () => {
    const foreign = await seedOrder({org: otherOrg, status: "picked_up"});
    const before = await rawOrder(foreign);
    const staff = member(org.organizationId);

    const crossTenant = await rejectionOf(complete(staff, foreign.id));
    const missing = await rejectionOf(complete(staff, "no-such-order"));

    expect(crossTenant.code).toBe("not-found");
    expect(crossTenant.message).toBe(missing.message);
    expect(await rawOrder(foreign)).toEqual(before);
  });

  it("refuses an invited or revoked member (403)", async () => {
    const order = await seedOrder({org, status: "picked_up"});

    for (const status of ["invited", "revoked"] as const) {
      const error = await rejectionOf(complete({...member(org.organizationId), status}, order.id));
      expect(error.code).toBe("permission-denied");
    }
    expect((await rawOrder(order)).status).toBe("picked_up");
  });

  it("nothing goes backwards out of picked_up or completed", async () => {
    const pickedUp = await seedOrder({org, status: "picked_up"});
    const completed = await seedOrder({org, status: "completed"});
    const staff = member(org.organizationId);

    for (const [order, to] of [[pickedUp, "ready"], [pickedUp, "preparing"], [completed, "ready"], [completed, "preparing"]] as const) {
      const error = await rejectionOf(transitionOrderStatus(db, {membership: staff, orderId: order.id, to}));
      expect(error.code).toBe("aborted");
    }
    expect((await rawOrder(pickedUp)).status).toBe("picked_up");
    expect((await rawOrder(completed)).status).toBe("completed");
  });

  it("picked_up cannot be reached through the generic fulfillment step", async () => {
    const order = await seedOrder({org, status: "ready"});

    const error = await rejectionOf(transitionOrderStatus(db, {
      membership: member(org.organizationId), orderId: order.id, to: "picked_up" as never,
    }));

    expect(error.code).toBe("invalid-argument");
    expect((await rawOrder(order)).status).toBe("ready");
  });

  describe("concurrent requests", {timeout: 30_000}, () => {
    it("two people completing at once both get a success, and exactly one is on record", async () => {
      const order = await seedOrder({org, status: "picked_up"});
      const alice = member(org.organizationId);
      const bob = member(org.organizationId, "manager");

      const [fromAlice, fromBob] = await Promise.all([complete(alice, order.id), complete(bob, order.id)]);

      expect([fromAlice.changed, fromBob.changed].sort()).toEqual([false, true]);
      const doc = await rawOrder(order);
      expect(doc.status).toBe("completed");
      expect([alice.userId, bob.userId]).toContain(doc.completedBy);
      expect(doc.updatedAt).toEqual(doc.completedAt);
    });
  });
});

describe("the customer's credential (Firestore emulator)", () => {
  let org: OrgFixture;
  let otherOrg: OrgFixture;

  beforeAll(async () => {
    org = await buildOrg("Customer");
    otherOrg = await buildOrg("Customer other");
  });

  it("gives the order's own customer a QR payload and code that the organization's staff can then redeem", async () => {
    const order = await seedOrder({org, status: "ready"});

    const credentials = await getPickupCredentialForCustomer(db, order.customerId, order.id, getSecret);

    expect(credentials).toEqual(derivePickupCredentials(SECRET, order.id));
    expect(Object.keys(credentials).sort()).toEqual(["code", "qrPayload"]);
    const viaQr = await redeem(member(org.organizationId), credentials.qrPayload);
    expect(viaQr.order.id).toBe(order.id);
  });

  it("gives the same credential on every fetch (a reloaded screen shows the same QR) and writes nothing", async () => {
    const order = await seedOrder({org, status: "ready"});
    const before = await rawOrder(order);

    const first = await getPickupCredentialForCustomer(db, order.customerId, order.id, getSecret);
    const second = await getPickupCredentialForCustomer(db, order.customerId, order.id, getSecret);

    expect(second).toEqual(first);
    expect(await rawOrder(order)).toEqual(before);
    expect((await order.ref.listCollections())).toHaveLength(0);
  });

  it("answers an unrelated customer with the same 404 as an order that does not exist: knowing the ID is not enough", async () => {
    const order = await seedOrder({org, status: "ready"});
    const stranger = freshUserId();

    const wrongCustomer = await rejectionOf(getPickupCredentialForCustomer(db, stranger, order.id, getSecret));
    const missing = await rejectionOf(getPickupCredentialForCustomer(db, stranger, "no-such-order", getSecret));

    expect(wrongCustomer.code).toBe("not-found");
    expect(wrongCustomer.message).toBe(missing.message);
  });

  it("gives the organization's own owner, manager and staff no access: they are not the customer", async () => {
    const order = await seedOrder({org, status: "ready"});
    const staff = [member(org.organizationId, "owner"), member(org.organizationId, "manager"), member(org.organizationId, "staff")];

    for (const who of staff) {
      const error = await rejectionOf(getPickupCredentialForCustomer(db, who.userId, order.id, getSecret));
      expect(error.code).toBe("not-found");
    }
  });

  it("gives another organization's customer, and another organization's order, no access either", async () => {
    const order = await seedOrder({org, status: "ready"});
    const foreignOrder = await seedOrder({org: otherOrg, status: "ready"});

    const error = await rejectionOf(getPickupCredentialForCustomer(db, foreignOrder.customerId, order.id, getSecret));

    expect(error.code).toBe("not-found");
  });

  it.each<[OrderStatus, "pending" | "paid"]>([
    ["pending_payment", "pending"],
    ["confirmed", "paid"],
    ["preparing", "paid"],
    ["ready", "pending"],
    ["picked_up", "paid"],
    ["completed", "paid"],
    ["cancelled", "paid"],
  ])("refuses the customer's own %s (%s) order with a 409: there is nothing to collect", async (status, paymentStatus) => {
    const order = await seedOrder({org, status, paymentStatus});

    const error = await rejectionOf(getPickupCredentialForCustomer(db, order.customerId, order.id, getSecret));

    expect(error.code).toBe("aborted");
    expect(error.message).toBe("This order isn't ready for pickup.");
  });

  it("stops offering the credential the moment the order is picked up", async () => {
    const order = await seedOrder({org, status: "ready"});
    const credentials = await getPickupCredentialForCustomer(db, order.customerId, order.id, getSecret);
    await redeem(member(org.organizationId), credentials.code);

    const error = await rejectionOf(getPickupCredentialForCustomer(db, order.customerId, order.id, getSecret));
    const replay = await rejectionOf(redeem(member(org.organizationId), credentials.qrPayload));

    expect(error.code).toBe("aborted");
    expect(replay.message).toBe("This order has already been picked up.");
  });
});

describe("existing reads and payments with picked_up / completed orders (Firestore emulator)", () => {
  let org: OrgFixture;

  beforeAll(async () => {
    org = await buildOrg("Compat");
  });

  const AUDIT = {pickedUpAt: READY_AT, pickedUpBy: "U-secret-actor", completedAt: READY_AT, completedBy: "U-secret-actor"};

  it.each(["picked_up", "completed"] as const)("the customer can still read their %s order, without any audit field", async (status) => {
    const order = await seedOrder({org, status, extra: AUDIT});

    const read = await getOwnedOrder(db, order.customerId, order.id);

    expect(read.status).toBe(status);
    expect(read.paymentStatus).toBe("paid");
  });

  it("the customer's history and the organization's list include them, with no audit field or actor", async () => {
    const customerId = freshUserId();
    const pickedUp = await seedOrder({org, status: "picked_up", userId: customerId, extra: AUDIT});
    const completed = await seedOrder({org, status: "completed", userId: customerId, extra: AUDIT});

    const history = await listOwnedOrders(db, customerId, {});
    const organizationList = await listOrganizationOrders(db, org.organizationId, {limit: 50});

    expect(history.orders.map((order) => [order.id, order.status]).sort()).toEqual(
      [[pickedUp.id, "picked_up"], [completed.id, "completed"]].sort(),
    );
    const statuses = new Map(organizationList.orders.map((order) => [order.id, order.status]));
    expect(statuses.get(pickedUp.id)).toBe("picked_up");
    expect(statuses.get(completed.id)).toBe("completed");
    for (const page of [history, organizationList]) {
      expect(JSON.stringify(page)).not.toContain("U-secret-actor");
      expect(JSON.stringify(page)).not.toMatch(/pickedUp(At|By)|completed(At|By)/);
    }
  });

  it.each(["picked_up", "completed"] as const)(
    "replaying a payment-success or payment-failure notification on a %s order changes nothing",
    async (status) => {
      const order = await seedOrder({org, status, extra: AUDIT});
      const paymentRef = order.ref.collection("payments").doc(order.id);
      seededRefs.push(paymentRef);
      await paymentRef.create({
        id: order.id, orderId: order.id, userId: order.customerId,
        organizationId: org.organizationId, outletId: org.outletId, menuId: org.menuId,
        amountInPaise: 10000, currency: "INR", status: "succeeded", provider: "razorpay",
        providerOrderId: "order_replay", providerPaymentId: "pay_replay",
        createdAt: CREATED_AT, updatedAt: CREATED_AT,
      });
      const orderBefore = await rawOrder(order);
      const paymentBefore = (await paymentRef.get()).data();

      const succeeded = await markPaymentSucceeded(db, {
        orderId: order.id, paymentId: order.id, amountInPaise: 10000, currency: "INR", providerPaymentId: "pay_replay",
      });
      const failed = await markPaymentFailed(db, {orderId: order.id, paymentId: order.id, providerPaymentId: "pay_late"});

      expect(succeeded.order.status).toBe(status);
      expect(failed.status).toBe("succeeded");
      expect(await rawOrder(order)).toEqual(orderBefore);
      expect((await paymentRef.get()).data()).toEqual(paymentBefore);
    },
  );
});

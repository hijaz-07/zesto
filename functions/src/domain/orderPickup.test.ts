// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it, vi} from "vitest";
import type {OrganizationMembership} from "../auth/membership";
import {
  ORDER_PICKUP_ROLES,
  PICKUP_CODE_LOOKUP_LIMIT,
  assertOrderCanBePickedUp,
  getPickupCredentialForCustomer,
  redeemPickup,
  redeemPickupBodySchema,
} from "./orderPickup";
import type {Order, OrderStatus} from "./orders";
import {derivePickupCredentials, pickupCodeFor} from "./pickupCredential";

const SECRET = "test-pickup-secret-0123456789-abcdefghij";
const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const OUTLET_ID = "outlet-1";
const OTHER_OUTLET_ID = "outlet-2";
const MENU_ID = "menu-1";
const ORDER_ID = "order-1";
const STAFF_ID = "U-staff";
const CUSTOMER_ID = "U-customer";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    userId: CUSTOMER_ID,
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuId: MENU_ID,
    status: "ready",
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: 24000,
    totalInPaise: 24000,
    items: [
      {itemId: "item-1", name: "Chicken Biriyani", priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000},
    ],
    createdAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    ...overrides,
  };
}

function membership(overrides: Partial<OrganizationMembership> = {}): OrganizationMembership {
  return {userId: STAFF_ID, organizationId: ORG_ID, role: "staff", status: "active", ...overrides};
}

/** A Firestore stand-in that throws on any property access. */
function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

/** The parent chain `resolveOrderById`/`getOwnedOrder` walk, around a stored order. */
function fakeOrderDoc(stored: Order) {
  const organizationRef = {id: stored.organizationId};
  const outletRef = {id: stored.outletId, parent: {parent: organizationRef}};
  const menuRef = {id: stored.menuId, parent: {parent: outletRef}};
  const path =
    `organizations/${stored.organizationId}/outlets/${stored.outletId}/menus/${stored.menuId}/orders/${stored.id}`;
  return {id: stored.id, ref: {path, parent: {parent: menuRef}}, data: () => ({...stored})};
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be refused");
}

async function httpsErrorOf(promise: Promise<unknown>): Promise<HttpsError> {
  const error = await errorOf(promise);
  if (error instanceof HttpsError) {
    return error;
  }
  throw error;
}

/**
 * A Firestore whose single order lookup returns `stored` (or nothing), run
 * through a fake transaction — enough to execute `redeemPickup`'s whole
 * transaction body without an emulator. `updates` records every write.
 *
 * @param {Order | undefined} stored The order the collection-group lookup finds.
 * @return {{db: Firestore, updates: unknown[]}} The fake and its recorded writes.
 */
function fakeDbHolding(stored: Order | undefined): {db: Firestore; updates: unknown[]} {
  const updates: unknown[] = [];
  // Also answers the typed-code lookup (`.where().where().orderBy().limit().get()`) with the same order.
  const candidates = stored ? [fakeOrderDoc(stored)] : [];
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    get: async () => ({size: candidates.length, docs: candidates}),
  };
  const tx = {
    get: async () => ({size: stored ? 1 : 0, docs: stored ? [fakeOrderDoc(stored)] : []}),
    update: (...args: unknown[]) => {
      updates.push(args);
    },
  };
  const db = {
    collectionGroup: () => query,
    runTransaction: async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as Firestore;
  return {db, updates};
}

describe("ORDER_PICKUP_ROLES", () => {
  it("is exactly owner, manager and staff", () => {
    expect([...ORDER_PICKUP_ROLES].sort()).toEqual(["manager", "owner", "staff"]);
  });
});

describe("assertOrderCanBePickedUp", () => {
  it("allows a ready, paid order — and only that", () => {
    expect(() => assertOrderCanBePickedUp(order({status: "ready", paymentStatus: "paid"}))).not.toThrow();
  });

  it.each<[OrderStatus, "pending" | "paid", string]>([
    ["ready", "pending", "This order has not been paid yet."],
    ["pending_payment", "pending", "This order has not been paid yet."],
    ["confirmed", "paid", "This order is not ready for pickup yet."],
    ["preparing", "paid", "This order is not ready for pickup yet."],
    ["picked_up", "paid", "This order has already been picked up."],
    ["completed", "paid", "This order has already been picked up and completed."],
    ["cancelled", "paid", "This order was cancelled."],
    ["cancelled", "pending", "This order was cancelled."],
  ])("refuses a %s order (%s) with a 409 conflict: %s", async (status, paymentStatus, message) => {
    let thrown: unknown;
    try {
      assertOrderCanBePickedUp(order({status, paymentStatus}));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("aborted");
    expect((thrown as HttpsError).httpErrorCode.status).toBe(409);
    expect((thrown as HttpsError).message).toBe(message);
  });

  it("has no 'already done, so succeed quietly' case: picked_up is a refusal, never a success", () => {
    expect(() => assertOrderCanBePickedUp(order({status: "picked_up"}))).toThrow(HttpsError);
  });
});

describe("redeemPickupBodySchema", () => {
  it("accepts a credential, with or without an outlet", () => {
    expect(redeemPickupBodySchema.safeParse({credential: "K7QX-4M2P"}).success).toBe(true);
    expect(redeemPickupBodySchema.safeParse({credential: "K7QX-4M2P", outletId: "outlet-1"}).success).toBe(true);
  });

  it("trims the credential", () => {
    expect(redeemPickupBodySchema.parse({credential: "  K7QX-4M2P \n"}).credential).toBe("K7QX-4M2P");
  });

  it("strips every other field: a status, user, organization, order or payment claim is never read", () => {
    const parsed = redeemPickupBodySchema.parse({
      credential: "K7QX-4M2P",
      status: "picked_up",
      paymentStatus: "paid",
      userId: "U-attacker",
      pickedUpBy: "U-attacker",
      organizationId: "org-attacker",
      orderId: "order-attacker",
    });

    expect(Object.keys(parsed)).toEqual(["credential"]);
  });

  it.each([
    ["no body", undefined],
    ["a null body", null],
    ["a string body", "K7QX-4M2P"],
    ["an array body", ["K7QX-4M2P"]],
    ["no credential", {}],
    ["an empty credential", {credential: ""}],
    ["a blank credential", {credential: "   "}],
    ["a numeric credential", {credential: 12345678}],
    ["an array credential", {credential: ["K7QX-4M2P"]}],
    ["an object credential", {credential: {code: "K7QX-4M2P"}}],
    ["an over-long credential", {credential: "A".repeat(201)}],
    ["a numeric outletId", {credential: "K7QX-4M2P", outletId: 7}],
  ])("rejects %s", (_label, body) => {
    expect(redeemPickupBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("redeemPickup — refused before any Firestore access", () => {
  const qr = derivePickupCredentials(SECRET, ORDER_ID).qrPayload;
  const input = (overrides: Record<string, unknown> = {}) => ({
    membership: membership(),
    credential: qr,
    getSecret: () => SECRET,
    ...overrides,
  });

  it.each(["invited", "revoked"] as const)("refuses a %s membership (403)", async (status) => {
    const error = await httpsErrorOf(redeemPickup(untouchedDb(), input({membership: membership({status})})));

    expect(error.code).toBe("permission-denied");
  });

  it("refuses a role outside the pickup roles (403), even on an active membership", async () => {
    const unknownRole = "superadmin" as unknown as OrganizationMembership["role"];

    const error = await httpsErrorOf(redeemPickup(untouchedDb(), input({membership: membership({role: unknownRole})})));

    expect(error.code).toBe("permission-denied");
  });

  it("checks the role BEFORE the credential: a revoked member never learns whether the code was well formed", async () => {
    const error = await httpsErrorOf(
      redeemPickup(untouchedDb(), input({membership: membership({status: "revoked"}), credential: "!!!"})),
    );

    expect(error.code).toBe("permission-denied");
  });

  it.each(["", "a/b", "..", ".", "__x__", 5, null, {}])("refuses the malformed outlet ID %j (400)", async (outletId) => {
    const error = await httpsErrorOf(redeemPickup(untouchedDb(), input({outletId})));

    expect(error.code).toBe("invalid-argument");
    expect(error.message).toBe("Invalid outlet ID.");
  });

  it.each(["", "   ", "nope", "ZP1.", "ZP1.a.b", "ABCD-EFGH-IJKL", 12345678, undefined, null, {}])(
    "refuses the malformed credential %j (400)",
    async (credential) => {
      const error = await httpsErrorOf(redeemPickup(untouchedDb(), input({credential})));

      expect(error.code).toBe("invalid-argument");
      expect(error.message).toBe("That doesn't look like a Zesto pickup code.");
    },
  );

  it("asks for the secret only AFTER the membership, outlet ID and credential format pass", async () => {
    const getSecret = vi.fn(() => SECRET);
    const refusals: Array<Record<string, unknown>> = [
      {membership: membership({status: "revoked"})},
      {membership: membership({role: "superadmin" as unknown as OrganizationMembership["role"]})},
      {outletId: "a/b"},
      {credential: "nope"},
    ];

    for (const overrides of refusals) {
      await httpsErrorOf(redeemPickup(untouchedDb(), input({getSecret, ...overrides})));
    }

    expect(getSecret).not.toHaveBeenCalled();
  });

  it("is a 400/403 rather than a 500 for a refused request even when the secret is not configured", async () => {
    const unconfigured = () => {
      throw new Error("PICKUP_CREDENTIAL_SECRET is not configured.");
    };

    const malformed = await httpsErrorOf(redeemPickup(untouchedDb(), input({getSecret: unconfigured, credential: "nope"})));

    expect(malformed.code).toBe("invalid-argument");
  });
});

describe("redeemPickup — the transaction, against a fake transaction", () => {
  const qr = derivePickupCredentials(SECRET, ORDER_ID).qrPayload;
  const code = derivePickupCredentials(SECRET, ORDER_ID).code;
  const NO_MATCH = "No order awaiting pickup matches this code.";

  function redeem(db: Firestore, overrides: Record<string, unknown> = {}) {
    return redeemPickup(db, {membership: membership(), credential: qr, getSecret: () => SECRET, ...overrides});
  }

  it("moves a ready, paid order to picked_up, writing the status, the audit pair and updatedAt together", async () => {
    const {db, updates} = fakeDbHolding(order());

    const result = await redeem(db);

    expect(result.via).toBe("qr");
    expect(result.order).toMatchObject({status: "picked_up", pickedUpBy: STAFF_ID});
    expect(updates).toHaveLength(1);
    const [, written] = updates[0] as [unknown, Record<string, unknown>];
    expect(Object.keys(written).sort()).toEqual(["pickedUpAt", "pickedUpBy", "status", "updatedAt"]);
    expect(written).toMatchObject({status: "picked_up", pickedUpBy: STAFF_ID});
    expect(written.pickedUpAt).toBe(written.updatedAt);
    expect(result.order.pickedUpAt).toBe(written.pickedUpAt);
  });

  it("records the VERIFIED member as the actor — there is nowhere for a request to name another", async () => {
    const {db} = fakeDbHolding(order());

    const result = await redeem(db, {membership: membership({userId: "U-someone-else", role: "manager"})});

    expect(result.order.pickedUpBy).toBe("U-someone-else");
  });

  it.each(["owner", "manager", "staff"] as const)("lets an active %s do it", async (role) => {
    const {db} = fakeDbHolding(order());

    await expect(redeem(db, {membership: membership({role})})).resolves.toMatchObject({via: "qr"});
  });

  it("accepts the typed backup code too, and says so", async () => {
    const {db, updates} = fakeDbHolding(order());

    const result = await redeemPickup(db, {membership: membership(), credential: code, getSecret: () => SECRET});

    expect(result.via).toBe("code");
    expect(result.order.status).toBe("picked_up");
    expect(updates).toHaveLength(1);
  });

  it("answers the SAME 404 for an order that does not exist, another organization's, and a wrong proof", async () => {
    const missing = await httpsErrorOf(redeem(fakeDbHolding(undefined).db));
    const foreign = fakeDbHolding(order({organizationId: OTHER_ORG_ID}));
    const crossTenant = await httpsErrorOf(redeem(foreign.db));
    const wrongProof = fakeDbHolding(order());
    const forgedPayload = `ZP1.${ORDER_ID}.${"A".repeat(22)}`;
    const forged = await httpsErrorOf(redeem(wrongProof.db, {credential: forgedPayload}));
    const wrongSecret = fakeDbHolding(order());
    const rotated = await httpsErrorOf(redeem(wrongSecret.db, {getSecret: () => "a-completely-different-secret-0123456789"}));

    for (const error of [missing, crossTenant, forged, rotated]) {
      expect(error.code).toBe("not-found");
      expect(error.httpErrorCode.status).toBe(404);
      expect(error.message).toBe(NO_MATCH);
    }
    expect(foreign.updates).toEqual([]);
    expect(wrongProof.updates).toEqual([]);
    expect(wrongSecret.updates).toEqual([]);
  });

  it("never reveals a foreign order's state: a cross-tenant picked_up order is still just 'no match'", async () => {
    const {db} = fakeDbHolding(order({organizationId: OTHER_ORG_ID, status: "picked_up"}));

    const error = await httpsErrorOf(redeem(db));

    expect(error.message).toBe(NO_MATCH);
  });

  it("refuses a different outlet with 409 — but only to a caller holding the genuine credential", async () => {
    const genuine = fakeDbHolding(order({outletId: OTHER_OUTLET_ID}));
    const refused = await httpsErrorOf(redeem(genuine.db, {outletId: OUTLET_ID}));
    const forged = await httpsErrorOf(
      redeem(fakeDbHolding(order({outletId: OTHER_OUTLET_ID})).db, {outletId: OUTLET_ID, credential: `ZP1.${ORDER_ID}.${"A".repeat(22)}`}),
    );

    expect(refused).toMatchObject({code: "aborted", message: "This order is for a different outlet."});
    expect(genuine.updates).toEqual([]);
    expect(forged.message).toBe(NO_MATCH);
  });

  it("treats the outlet as a narrowing check only: naming the order's own outlet changes nothing", async () => {
    const {db} = fakeDbHolding(order());

    await expect(redeem(db, {outletId: OUTLET_ID})).resolves.toMatchObject({order: {status: "picked_up"}});
  });

  it.each<[OrderStatus, string]>([
    ["confirmed", "This order is not ready for pickup yet."],
    ["preparing", "This order is not ready for pickup yet."],
    ["picked_up", "This order has already been picked up."],
    ["completed", "This order has already been picked up and completed."],
    ["cancelled", "This order was cancelled."],
  ])("refuses a genuine credential for a %s order (409) and writes nothing", async (status, message) => {
    const {db, updates} = fakeDbHolding(order({status}));

    const error = await httpsErrorOf(redeem(db));

    expect(error).toMatchObject({code: "aborted", message});
    expect(updates).toEqual([]);
  });

  it("refuses an unpaid order even when it is somehow ready, and an unpaid pending order", async () => {
    const readyUnpaid = fakeDbHolding(order({status: "ready", paymentStatus: "pending"}));
    const pending = fakeDbHolding(order({status: "pending_payment", paymentStatus: "pending"}));

    expect((await httpsErrorOf(redeem(readyUnpaid.db))).message).toBe("This order has not been paid yet.");
    expect((await httpsErrorOf(redeem(pending.db))).message).toBe("This order has not been paid yet.");
    expect(readyUnpaid.updates).toEqual([]);
    expect(pending.updates).toEqual([]);
  });

  it("does not overwrite the original pickup record when it is refused a second time", async () => {
    const first = Timestamp.fromDate(new Date("2026-09-27T06:00:00Z"));
    const {db, updates} = fakeDbHolding(order({status: "picked_up", pickedUpAt: first, pickedUpBy: "U-first"}));

    await httpsErrorOf(redeem(db, {membership: membership({userId: "U-second"})}));

    expect(updates).toEqual([]);
  });
});

describe("redeemPickup — a transaction Firestore gives up on", () => {
  const qr = derivePickupCredentials(SECRET, ORDER_ID).qrPayload;

  function dbFailingWith(error: unknown): Firestore {
    return {runTransaction: async () => {
      throw error;
    }} as unknown as Firestore;
  }

  it.each([
    ["the numeric gRPC ABORTED code", Object.assign(new Error("10 ABORTED: Too much contention."), {code: 10})],
    ["the string code", Object.assign(new Error("aborted"), {code: "aborted"})],
  ])("is reported as a 409 conflict (not a 500) for %s", async (_label, error) => {
    const result = await httpsErrorOf(
      redeemPickup(dbFailingWith(error), {membership: membership(), credential: qr, getSecret: () => SECRET}),
    );

    expect(result.code).toBe("aborted");
    expect(result.httpErrorCode.status).toBe(409);
    expect(result.message).toBe("This order was just changed by someone else. Refresh and try again.");
  });

  it.each([
    ["an unrelated Firestore failure", Object.assign(new Error("14 UNAVAILABLE"), {code: 14})],
    ["a plain error", new Error("boom")],
  ])("lets %s through untouched, so it is still a 500", async (_label, error) => {
    await expect(
      redeemPickup(dbFailingWith(error), {membership: membership(), credential: qr, getSecret: () => SECRET}),
    ).rejects.toBe(error);
  });

  it("surfaces a missing or too-short secret as a plain Error (a 500), not as a bad credential", async () => {
    const {db} = fakeDbHolding(order());

    const error = await errorOf(redeemPickup(db, {membership: membership(), credential: qr, getSecret: () => "short"}));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpsError);
    expect((error as Error).message).not.toContain("short");
  });
});

describe("redeemPickup — finding the order for a typed backup code", () => {
  const code = derivePickupCredentials(SECRET, ORDER_ID).code;

  /** Records the query's constraints; the transaction (if reached) throws a sentinel. */
  function fakeLookupDb(docs: unknown[]) {
    const calls: unknown[][] = [];
    const query = {
      where: (...args: unknown[]) => {
        calls.push(["where", ...args]);
        return query;
      },
      orderBy: (...args: unknown[]) => {
        calls.push(["orderBy", ...args]);
        return query;
      },
      limit: (n: number) => {
        calls.push(["limit", n]);
        return query;
      },
      get: async () => ({size: docs.length, docs}),
    };
    const reached: string[] = [];
    const db = {
      collectionGroup: (name: string) => {
        calls.push(["collectionGroup", name]);
        return query;
      },
      runTransaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        // Run the body with a transaction that finds nothing: it records which order was asked for.
        reached.push("transaction");
        return callback({get: async () => ({size: 0, docs: []}), update: () => undefined});
      },
    } as unknown as Firestore;
    return {db, calls, reached};
  }

  it("searches ONLY the caller's own organization's ready and picked-up orders, newest first, bounded", async () => {
    const {db, calls} = fakeLookupDb([]);

    await httpsErrorOf(redeemPickup(db, {membership: membership({organizationId: "org-verified"}), credential: code, getSecret: () => SECRET}));

    expect(calls).toEqual([
      ["collectionGroup", "orders"],
      ["where", "organizationId", "==", "org-verified"],
      ["where", "status", "in", ["ready", "picked_up"]],
      ["orderBy", "createdAt", "desc"],
      ["limit", PICKUP_CODE_LOOKUP_LIMIT + 1],
    ]);
  });

  it("answers 404 and never opens a transaction when no candidate matches", async () => {
    const other = fakeOrderDoc(order({id: "order-other"}));
    const {db, reached} = fakeLookupDb([other]);

    const error = await httpsErrorOf(redeemPickup(db, {membership: membership(), credential: code, getSecret: () => SECRET}));

    expect(error).toMatchObject({code: "not-found", message: "No order awaiting pickup matches this code."});
    expect(reached).toEqual([]);
  });

  it("hands the one matching candidate to the transaction, which then re-verifies it itself", async () => {
    const candidate = fakeOrderDoc(order());
    const decoy = fakeOrderDoc(order({id: "order-decoy"}));
    const {db, calls, reached} = fakeLookupDb([decoy, candidate]);

    const error = await httpsErrorOf(redeemPickup(db, {membership: membership(), credential: code, getSecret: () => SECRET}));

    expect(reached).toEqual(["transaction"]);
    // The transaction's own read asked for exactly the matching order (and, here, found nothing).
    expect(calls).toContainEqual(["where", "id", "==", ORDER_ID]);
    expect(calls).not.toContainEqual(["where", "id", "==", "order-decoy"]);
    expect(error.message).toBe("No order awaiting pickup matches this code.");
  });

  it("ignores a candidate whose path is outside the caller's organization, even if its code matches", async () => {
    const foreign = fakeOrderDoc(order({organizationId: OTHER_ORG_ID}));
    const {db, reached} = fakeLookupDb([foreign]);

    const error = await httpsErrorOf(redeemPickup(db, {membership: membership(), credential: code, getSecret: () => SECRET}));

    expect(error.code).toBe("not-found");
    expect(reached).toEqual([]);
  });

  it("matches a typed code however it was typed", async () => {
    const candidate = fakeOrderDoc(order());
    for (const typed of [code, code.toLowerCase(), code.replace("-", " ")]) {
      const {db, reached} = fakeLookupDb([candidate]);

      await httpsErrorOf(redeemPickup(db, {membership: membership(), credential: typed, getSecret: () => SECRET}));

      expect(reached).toEqual(["transaction"]);
    }
  });

  it("refuses to search a partial result: more than the limit is a plain Error and nothing is opened", async () => {
    const many = Array.from({length: PICKUP_CODE_LOOKUP_LIMIT + 1}, (_unused, i) => fakeOrderDoc(order({id: `order-${i}`})));
    const {db, reached} = fakeLookupDb(many);

    const error = await errorOf(redeemPickup(db, {membership: membership(), credential: code, getSecret: () => SECRET}));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpsError);
    expect(reached).toEqual([]);
  });

  it("accepts exactly the limit's worth of candidates", async () => {
    const exactly = Array.from({length: PICKUP_CODE_LOOKUP_LIMIT}, (_unused, i) => fakeOrderDoc(order({id: `order-${i}`})));
    const {db} = fakeLookupDb(exactly);

    await expect(
      redeemPickup(db, {membership: membership(), credential: code, getSecret: () => SECRET}),
    ).rejects.toMatchObject({code: "not-found"});
  });

  it("derives candidates' codes from their own IDs: the code of a different order never selects this one", () => {
    expect(pickupCodeFor(SECRET, ORDER_ID)).not.toBe(pickupCodeFor(SECRET, "order-other"));
  });
});

describe("getPickupCredentialForCustomer", () => {
  /** A Firestore whose `orders.id` lookup returns `stored` (or nothing). */
  function dbFinding(stored: Order | undefined): Firestore {
    const query = {
      where: () => query,
      limit: () => query,
      get: async () => ({size: stored ? 1 : 0, docs: stored ? [fakeOrderDoc(stored)] : []}),
    };
    return {collectionGroup: () => query} as unknown as Firestore;
  }

  it("returns the QR payload and backup code — exactly those two things — to the order's own customer", async () => {
    const result = await getPickupCredentialForCustomer(dbFinding(order()), CUSTOMER_ID, ORDER_ID, () => SECRET);

    expect(result).toEqual(derivePickupCredentials(SECRET, ORDER_ID));
    expect(Object.keys(result).sort()).toEqual(["code", "qrPayload"]);
  });

  it("gives an unrelated customer the SAME 404 as for an order that does not exist — knowing the ID is not enough", async () => {
    const getSecret = vi.fn(() => SECRET);
    const stranger = await httpsErrorOf(
      getPickupCredentialForCustomer(dbFinding(order()), "U-stranger", ORDER_ID, getSecret),
    );
    const missing = await httpsErrorOf(
      getPickupCredentialForCustomer(dbFinding(undefined), "U-stranger", ORDER_ID, getSecret),
    );

    expect(stranger.code).toBe("not-found");
    expect(stranger.httpErrorCode.status).toBe(404);
    expect(stranger.message).toBe(missing.message);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("gives the organization's own staff no access either: they are not the customer", async () => {
    // STAFF_ID is an active organization member in these tests, but the order's `userId` is the customer's.
    const error = await httpsErrorOf(
      getPickupCredentialForCustomer(dbFinding(order()), STAFF_ID, ORDER_ID, () => SECRET),
    );

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
  ])("refuses the customer's own %s (%s) order with a 409 — there is nothing to collect", async (status, paymentStatus) => {
    const getSecret = vi.fn(() => SECRET);

    const error = await httpsErrorOf(
      getPickupCredentialForCustomer(dbFinding(order({status, paymentStatus})), CUSTOMER_ID, ORDER_ID, getSecret),
    );

    expect(error.code).toBe("aborted");
    expect(error.httpErrorCode.status).toBe(409);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it.each(["", "a/b", "..", ".", "__x__", 5, undefined, null])("refuses the malformed order ID %j (400) without touching Firestore", async (orderId) => {
    const error = await httpsErrorOf(getPickupCredentialForCustomer(untouchedDb(), CUSTOMER_ID, orderId, () => SECRET));

    expect(error.code).toBe("invalid-argument");
  });

  it("asks for the secret only after ownership and state have passed, and propagates a missing one as a plain Error", async () => {
    const missingSecret = () => {
      throw new Error("PICKUP_CREDENTIAL_SECRET is not configured.");
    };

    const error = await errorOf(getPickupCredentialForCustomer(dbFinding(order()), CUSTOMER_ID, ORDER_ID, missingSecret));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpsError);
  });
});

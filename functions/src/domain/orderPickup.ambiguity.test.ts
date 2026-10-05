// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it, vi} from "vitest";
import {redeemPickup} from "./orderPickup";

/**
 * Two orders whose 40-bit backup codes collide cannot be produced with a real
 * HMAC (that is the point of 40 bits), so this file replaces the matcher with
 * one that says "yes" to every code, to prove the lookup FAILS CLOSED rather
 * than choosing between them. It lives in its own file because `vi.mock`
 * replaces the module for the whole file.
 */
vi.mock("./pickupCredential", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pickupCredential")>();
  return {
    ...original,
    pickupCredentialMatches: (_secret: string, _orderId: string, credential: {kind: string}) =>
      credential.kind === "code",
  };
});

const SECRET = "test-pickup-secret-0123456789-abcdefghij";

function fakeDoc(id: string) {
  return {
    id,
    ref: {path: `organizations/org-1/outlets/o-1/menus/m-1/orders/${id}`},
    data: () => ({id, createdAt: Timestamp.now()}),
  };
}

describe("redeemPickup — a backup code that matches more than one order", () => {
  it("opens neither: the same 404 as no match, and no transaction is ever started", async () => {
    const runTransaction = vi.fn();
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: async () => ({size: 2, docs: [fakeDoc("order-a"), fakeDoc("order-b")]}),
    };
    const db = {collectionGroup: () => query, runTransaction} as unknown as Firestore;

    const error = await redeemPickup(db, {
      membership: {userId: "U-staff", organizationId: "org-1", role: "staff", status: "active"},
      credential: "K7QX-4M2P",
      getSecret: () => SECRET,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpsError);
    expect(error).toMatchObject({code: "not-found", message: "No order awaiting pickup matches this code."});
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("still hands over the order when exactly one matches (the mock is not simply refusing everything)", async () => {
    const runTransaction = vi.fn(async () => {
      throw new Error("sentinel: reached the transaction");
    });
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: async () => ({size: 1, docs: [fakeDoc("order-a")]}),
    };
    const db = {collectionGroup: () => query, runTransaction} as unknown as Firestore;

    const error = await redeemPickup(db, {
      membership: {userId: "U-staff", organizationId: "org-1", role: "staff", status: "active"},
      credential: "K7QX-4M2P",
      getSecret: () => SECRET,
    }).catch((caught: unknown) => caught);

    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toBe("sentinel: reached the transaction");
  });
});

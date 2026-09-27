// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {describe, expect, it, vi} from "vitest";
import {getOrCreateUserProfile, toUserProfileResponse} from "./users";

/**
 * A fake Admin Firestore serving `users/{userId}` through `runTransaction`,
 * matching the one document real code under test actually touches.
 *
 * @param {Record<string, unknown> | undefined} existing The stored document,
 *   or undefined if none exists yet.
 * @return {{db: Firestore, create: ReturnType<typeof vi.fn>, getStored: () => unknown}}
 *   The fake and hooks to inspect its state.
 */
function fakeDb(existing: Record<string, unknown> | undefined) {
  let stored = existing;
  const ref = {};
  const create = vi.fn((_ref: unknown, data: Record<string, unknown>) => {
    stored = data;
  });
  const tx = {
    get: vi.fn(async () => ({
      exists: stored !== undefined,
      data: () => stored,
    })),
    create,
  };
  const db = {
    collection: () => ({doc: () => ref}),
    runTransaction: vi.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };
  return {
    db: db as unknown as Firestore,
    create,
    getStored: () => stored,
  };
}

describe("getOrCreateUserProfile", () => {
  it("creates a new profile when none exists", async () => {
    const {db, create} = fakeDb(undefined);

    const profile = await getOrCreateUserProfile(db, "U-1");

    expect(profile.id).toBe("U-1");
    expect(profile.createdAt).toBeInstanceOf(Timestamp);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns the existing profile without creating a new one", async () => {
    const createdAt = Timestamp.fromDate(new Date("2020-01-01T00:00:00Z"));
    const {db, create} = fakeDb({id: "U-1", createdAt});

    const profile = await getOrCreateUserProfile(db, "U-1");

    expect(profile).toEqual({id: "U-1", createdAt});
    expect(create).not.toHaveBeenCalled();
  });

  it("never overwrites an existing createdAt", async () => {
    const original = Timestamp.fromDate(new Date("2020-01-01T00:00:00Z"));
    const {db} = fakeDb({id: "U-1", createdAt: original});

    const profile = await getOrCreateUserProfile(db, "U-1");

    expect(profile.createdAt.isEqual(original)).toBe(true);
  });

  it("rejects a stored document whose id does not match the caller " +
    "(generic error, no details leaked)", async () => {
    const {db} = fakeDb({id: "U-OTHER", createdAt: Timestamp.now()});

    await expect(getOrCreateUserProfile(db, "U-1")).rejects.toThrow();
  });

  it("rejects a stored document missing createdAt", async () => {
    const {db} = fakeDb({id: "U-1"});

    await expect(getOrCreateUserProfile(db, "U-1")).rejects.toThrow();
  });

  it("rejects a stored document whose createdAt is not a Timestamp", async () => {
    const {db} = fakeDb({id: "U-1", createdAt: "2020-01-01"});

    await expect(getOrCreateUserProfile(db, "U-1")).rejects.toThrow();
  });
});

describe("toUserProfileResponse", () => {
  it("renders createdAt as an ISO 8601 string", () => {
    const createdAt = Timestamp.fromDate(new Date("2026-09-25T10:00:00Z"));

    expect(toUserProfileResponse({id: "U-1", createdAt})).toEqual({
      id: "U-1",
      createdAt: "2026-09-25T10:00:00.000Z",
    });
  });
});

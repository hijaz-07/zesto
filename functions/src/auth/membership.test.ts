// @vitest-environment node
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it, vi} from "vitest";
import {requireOrganizationRole} from "./membership";
import type {VerifiedSession} from "./session";

const session: VerifiedSession = {userId: "U-123", claims: {sub: "U-123"}};

/**
 * Fake Admin Firestore that serves one membership document (or none) and
 * records the path segments used to reach it.
 *
 * @param {Record<string, unknown> | undefined} membership Stored document.
 * @return {{db: Firestore, path: string[]}} The fake and recorded path.
 */
function fakeDb(membership: Record<string, unknown> | undefined) {
  const path: string[] = [];
  const get = vi.fn(async () => ({
    exists: membership !== undefined,
    data: () => membership,
  }));
  const doc = (id: string) => {
    path.push(id);
    return {collection, get};
  };
  const collection = (id: string) => {
    path.push(id);
    return {doc};
  };
  return {db: {collection} as unknown as Firestore, path, get};
}

/**
 * @param {Promise<unknown>} promise A promise expected to reject.
 * @return {Promise<HttpsError>} The HttpsError it rejected with.
 */
async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpsError);
    return error as HttpsError;
  }
  throw new Error("Expected the promise to reject.");
}

describe("requireOrganizationRole", () => {
  it("reads organizations/{orgId}/members/{verified userId}", async () => {
    const {db, path} = fakeDb({status: "active", role: "owner"});

    const membership = await requireOrganizationRole(
      db, session, "org-a", ["owner"],
    );

    expect(path).toEqual(["organizations", "org-a", "members", "U-123"]);
    expect(membership).toEqual({
      userId: "U-123",
      organizationId: "org-a",
      role: "owner",
      status: "active",
    });
  });

  it("denies a caller with no membership in the organization", async () => {
    const {db} = fakeDb(undefined);

    const error = await rejection(
      requireOrganizationRole(db, session, "org-a", ["owner", "staff"]),
    );

    expect(error.code).toBe("permission-denied");
  });

  it.each(["invited", "revoked"])(
    "denies a %s (non-active) member",
    async (status) => {
      const {db} = fakeDb({status, role: "owner"});

      const error = await rejection(
        requireOrganizationRole(db, session, "org-a", ["owner"]),
      );

      expect(error.code).toBe("permission-denied");
    },
  );

  it("denies an active member whose role is not allowed", async () => {
    const {db} = fakeDb({status: "active", role: "staff"});

    const error = await rejection(
      requireOrganizationRole(db, session, "org-a", ["owner", "manager"]),
    );

    expect(error.code).toBe("permission-denied");
  });

  it("denies an unrecognized stored role", async () => {
    const {db} = fakeDb({status: "active", role: "admin"});

    const error = await rejection(
      requireOrganizationRole(db, session, "org-a", ["owner"]),
    );

    expect(error.code).toBe("permission-denied");
  });

  it.each(["", "org-a/members/U-999", ".", "..", "__org__", 42])(
    "rejects a malformed organization ID (%j) before reading Firestore",
    async (organizationId) => {
      const {db, get} = fakeDb({status: "active", role: "owner"});

      const error = await rejection(
        requireOrganizationRole(db, session, organizationId, ["owner"]),
      );

      expect(error.code).toBe("invalid-argument");
      expect(get).not.toHaveBeenCalled();
    },
  );
});

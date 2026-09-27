// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it, vi} from "vitest";
import {
  createOrganization,
  createOrganizationBodySchema,
  listOrganizationsForUser,
  toOrganizationMembershipResponse,
  toOrganizationResponse,
} from "./organizations";

/**
 * A fake Admin Firestore for `createOrganization`: supports exactly the
 * calls it makes — `collection().doc()` for the pre-allocated org ref,
 * `collection().doc(slug)` for the slug reservation ref, `orgRef.collection
 * ("members").doc(userId)` for the membership ref, and a `runTransaction`
 * whose `tx` records every `create` and reports whether the slug already
 * exists.
 *
 * @param {boolean} slugExists Whether `organizationSlugs/{slug}` should
 *   already exist when the transaction reads it.
 * @return {{db: Firestore, creates: Array<{path: string, data: unknown}>, orgAutoId: string}}
 *   The fake and the writes it recorded.
 */
function fakeCreateDb(slugExists: boolean) {
  const orgAutoId = "org-auto-1";
  const creates: Array<{path: string; data: unknown}> = [];

  const orgRef = {
    id: orgAutoId,
    path: `organizations/${orgAutoId}`,
    collection: (name: string) => ({
      doc: (id: string) => ({id, path: `organizations/${orgAutoId}/${name}/${id}`}),
    }),
  };

  const tx = {
    get: vi.fn(async (ref: {path: string}) => ({
      exists: slugExists && ref.path.startsWith("organizationSlugs/"),
    })),
    create: vi.fn((ref: {path: string}, data: unknown) => {
      creates.push({path: ref.path, data});
    }),
  };

  const db = {
    collection: (name: string) => ({
      doc: (id?: string) => (name === "organizations" ? orgRef : {
        id: id as string,
        path: `${name}/${id}`,
      }),
    }),
    runTransaction: vi.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };

  return {db: db as unknown as Firestore, creates, orgAutoId, get: tx.get};
}

describe("createOrganizationBodySchema", () => {
  it("accepts a valid name and slug", () => {
    const result = createOrganizationBodySchema.safeParse({
      name: "Test Canteen",
      slug: "test-canteen",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["", "empty name"],
    [" ".repeat(5), "whitespace-only name"],
    ["x".repeat(101), "name over 100 chars"],
  ])("rejects an invalid name (%s)", (name) => {
    const result = createOrganizationBodySchema.safeParse({
      name,
      slug: "valid-slug",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "ab",
    "x".repeat(51),
    "Has-Uppercase",
    "has_underscore",
    "-leading-hyphen",
    "trailing-hyphen-",
    "double--hyphen",
    "has space",
  ])("rejects an invalid slug (%s)", (slug) => {
    const result = createOrganizationBodySchema.safeParse({
      name: "Valid Name",
      slug,
    });
    expect(result.success).toBe(false);
  });

  it("trims the name but does not alter the slug", () => {
    const result = createOrganizationBodySchema.safeParse({
      name: "  Test Canteen  ",
      slug: "test-canteen",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Test Canteen");
      expect(result.data.slug).toBe("test-canteen");
    }
  });
});

describe("createOrganization", () => {
  it("creates the organization, slug reservation, and owner membership atomically", async () => {
    const {db, creates, orgAutoId} = fakeCreateDb(false);

    const {organization, membership} = await createOrganization(db, "U-1", {
      name: "Test Canteen",
      slug: "test-canteen",
    });

    expect(creates).toHaveLength(3);
    expect(organization).toMatchObject({
      id: orgAutoId,
      name: "Test Canteen",
      slug: "test-canteen",
      createdBy: "U-1",
    });
    expect(membership).toMatchObject({
      userId: "U-1",
      organizationId: orgAutoId,
      role: "owner",
      status: "active",
    });
  });

  it("uses the pre-allocated Firestore auto-ID as the organization ID, never anything from the input", async () => {
    const {db, orgAutoId} = fakeCreateDb(false);

    const {organization} = await createOrganization(db, "U-1", {
      name: "Test Canteen",
      slug: "test-canteen",
    });

    expect(organization.id).toBe(orgAutoId);
  });

  it("makes the caller (not any input field) the owner and createdBy", async () => {
    const {db} = fakeCreateDb(false);

    const {organization, membership} = await createOrganization(db, "U-caller", {
      name: "Test Canteen",
      slug: "test-canteen",
    });

    expect(organization.createdBy).toBe("U-caller");
    expect(membership.userId).toBe("U-caller");
    expect(membership.role).toBe("owner");
  });

  it("checks the slug reservation before writing anything", async () => {
    const {db, get} = fakeCreateDb(false);

    await createOrganization(db, "U-1", {name: "Test Canteen", slug: "test-canteen"});

    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({path: "organizationSlugs/test-canteen"}),
    );
  });

  it("throws already-exists and creates nothing when the slug is already taken", async () => {
    const {db, creates} = fakeCreateDb(true);

    await expect(
      createOrganization(db, "U-1", {name: "Test Canteen", slug: "test-canteen"}),
    ).rejects.toMatchObject({code: "already-exists"});
    expect(creates).toHaveLength(0);
  });

  it("throws an HttpsError instance on slug conflict", async () => {
    const {db} = fakeCreateDb(true);

    await expect(
      createOrganization(db, "U-1", {name: "Test Canteen", slug: "test-canteen"}),
    ).rejects.toBeInstanceOf(HttpsError);
  });
});

describe("toOrganizationResponse", () => {
  it("renders createdAt as an ISO 8601 string", () => {
    const createdAt = Timestamp.fromDate(new Date("2026-09-27T10:00:00Z"));

    expect(toOrganizationResponse({
      id: "org-1",
      name: "Test Canteen",
      slug: "test-canteen",
      createdAt,
      createdBy: "U-1",
    })).toEqual({
      id: "org-1",
      name: "Test Canteen",
      slug: "test-canteen",
      createdAt: "2026-09-27T10:00:00.000Z",
      createdBy: "U-1",
    });
  });
});

describe("toOrganizationMembershipResponse", () => {
  it("renders createdAt as an ISO 8601 string", () => {
    const createdAt = Timestamp.fromDate(new Date("2026-09-27T10:00:00Z"));

    expect(toOrganizationMembershipResponse({
      userId: "U-1",
      organizationId: "org-1",
      role: "owner",
      status: "active",
      createdAt,
    })).toEqual({
      userId: "U-1",
      organizationId: "org-1",
      role: "owner",
      status: "active",
      createdAt: "2026-09-27T10:00:00.000Z",
    });
  });
});

/** A membership doc as returned by the collection-group query, with a `ref` pointing at its parent organization. */
interface FakeMembershipDoc {
  data: Record<string, unknown>;
  orgId: string;
}

/** The chainable `where`/`orderBy`/`get` surface `listOrganizationsForUser` calls on the collection-group query. */
interface FakeMembershipQuery {
  where: () => FakeMembershipQuery;
  orderBy: () => FakeMembershipQuery;
  get: () => Promise<{empty: boolean; docs: unknown[]}>;
}

/**
 * A fake Admin Firestore for `listOrganizationsForUser`: a collection-group
 * query returning `memberships`, and `getAll` resolving each membership's
 * parent organization from `orgDocs` (keyed by organization ID; `undefined`
 * simulates a missing document).
 *
 * @param {FakeMembershipDoc[]} memberships The membership docs the query returns.
 * @param {Record<string, Record<string, unknown> | undefined>} orgDocs Organization doc data by ID.
 * @return {{db: Firestore, getAll: ReturnType<typeof vi.fn>}} The fake.
 */
function fakeListDb(
  memberships: FakeMembershipDoc[],
  orgDocs: Record<string, Record<string, unknown> | undefined>,
) {
  const docs = memberships.map((m) => ({
    data: () => m.data,
    ref: {parent: {parent: {id: m.orgId}}},
  }));

  const query: FakeMembershipQuery = {
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    get: vi.fn(async () => ({empty: docs.length === 0, docs})),
  };

  const getAll = vi.fn(async (...refs: Array<{id: string}>) =>
    refs.map((ref) => ({
      exists: orgDocs[ref.id] !== undefined,
      id: ref.id,
      data: () => orgDocs[ref.id],
    })));

  const db = {
    collectionGroup: vi.fn(() => query),
    getAll,
  };

  return {db: db as unknown as Firestore, getAll};
}

const validOrgDoc = (id: string) => ({
  id,
  name: "Test Canteen",
  slug: `test-canteen-${id}`,
  createdAt: Timestamp.now(),
  createdBy: "U-owner",
});

const validMembership = (orgId: string, overrides: Record<string, unknown> = {}) => ({
  data: {
    userId: "U-1",
    organizationId: orgId,
    role: "owner",
    status: "active",
    createdAt: Timestamp.now(),
    ...overrides,
  },
  orgId,
});

describe("listOrganizationsForUser", () => {
  it("returns [] and never calls getAll when there are no active memberships", async () => {
    const {db, getAll} = fakeListDb([], {});

    const result = await listOrganizationsForUser(db, "U-1");

    expect(result).toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("returns each organization with the caller's role, in query order", async () => {
    const {db} = fakeListDb(
      [validMembership("org-a"), validMembership("org-b", {role: "manager"})],
      {"org-a": validOrgDoc("org-a"), "org-b": validOrgDoc("org-b")},
    );

    const result = await listOrganizationsForUser(db, "U-1");

    expect(result.map((r) => r.id)).toEqual(["org-a", "org-b"]);
    expect(result[0].role).toBe("owner");
    expect(result[1].role).toBe("manager");
  });

  it("throws when an active membership points at a missing organization document", async () => {
    const {db} = fakeListDb([validMembership("org-missing")], {"org-missing": undefined});

    await expect(listOrganizationsForUser(db, "U-1")).rejects.toThrow();
  });

  it("throws when the organization document is malformed", async () => {
    const {db} = fakeListDb(
      [validMembership("org-a")],
      {"org-a": {id: "org-a", name: "Test"}},
    );

    await expect(listOrganizationsForUser(db, "U-1")).rejects.toThrow();
  });

  it("throws when the membership document itself is malformed", async () => {
    const {db, getAll} = fakeListDb(
      [validMembership("org-a", {role: "admin"})],
      {"org-a": validOrgDoc("org-a")},
    );

    await expect(listOrganizationsForUser(db, "U-1")).rejects.toThrow();
    expect(getAll).not.toHaveBeenCalled();
  });
});

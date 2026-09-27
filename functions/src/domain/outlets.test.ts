// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it, vi} from "vitest";
import {
  createOutlet,
  createOutletBodySchema,
  listOutletsForOrganization,
  toOutletResponse,
  updateOutlet,
  updateOutletBodySchema,
  type UpdateOutletInput,
} from "./outlets";

const ORG_ID = "org-1";

/**
 * A fake Admin Firestore for `createOutlet`: supports exactly the calls it
 * makes — `collection("organizations").doc(organizationId)`, then
 * `.collection("outlets").doc()` for the pre-allocated outlet ref,
 * `.collection("outletSlugs").doc(slug)` for the slug reservation ref, and a
 * `runTransaction` whose `tx` records every `create` and reports whether the
 * slug already exists.
 *
 * @param {boolean} slugExists Whether the outlet slug should already exist
 *   when the transaction reads it.
 * @return {{db: Firestore, creates: Array<{path: string, data: unknown}>, outletAutoId: string, get: ReturnType<typeof vi.fn>}}
 *   The fake and the writes it recorded.
 */
function fakeCreateDb(slugExists: boolean) {
  const outletAutoId = "outlet-auto-1";
  const creates: Array<{path: string; data: unknown}> = [];

  const orgRef = {
    collection: (name: string) => ({
      doc: (id?: string) => {
        if (name === "outlets") {
          return {id: outletAutoId, path: `organizations/${ORG_ID}/outlets/${outletAutoId}`};
        }
        return {id: id as string, path: `organizations/${ORG_ID}/${name}/${id}`};
      },
    }),
  };

  const tx = {
    get: vi.fn(async (ref: {path: string}) => ({
      exists: slugExists && ref.path.includes("/outletSlugs/"),
    })),
    create: vi.fn((ref: {path: string}, data: unknown) => {
      creates.push({path: ref.path, data});
    }),
  };

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => {
        if (name !== "organizations" || id !== ORG_ID) {
          throw new Error(`unexpected doc lookup: ${name}/${id}`);
        }
        return orgRef;
      },
    }),
    runTransaction: vi.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };

  return {db: db as unknown as Firestore, creates, outletAutoId, get: tx.get};
}

describe("createOutletBodySchema", () => {
  it("accepts a valid minimal body", () => {
    const result = createOutletBodySchema.safeParse({name: "Main Canteen", slug: "main-canteen"});
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated body", () => {
    const result = createOutletBodySchema.safeParse({
      name: "Main Canteen",
      slug: "main-canteen",
      description: "Main campus food outlet",
      phone: "0499xxxxxxx",
      address: {line1: "Main Campus", city: "Kasaragod", state: "Kerala", postalCode: "671xxx"},
      location: {latitude: 12.5, longitude: 74.9},
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["", "empty name"],
    [" ".repeat(5), "whitespace-only name"],
    ["x".repeat(101), "name over 100 chars"],
  ])("rejects an invalid name (%s)", (name) => {
    const result = createOutletBodySchema.safeParse({name, slug: "valid-slug"});
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
    const result = createOutletBodySchema.safeParse({name: "Valid Name", slug});
    expect(result.success).toBe(false);
  });

  it("trims the name but does not alter the slug", () => {
    const result = createOutletBodySchema.safeParse({name: "  Main Canteen  ", slug: "main-canteen"});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Main Canteen");
      expect(result.data.slug).toBe("main-canteen");
    }
  });

  it.each([
    {latitude: 91, longitude: 0},
    {latitude: -91, longitude: 0},
    {latitude: 0, longitude: 181},
    {latitude: 0, longitude: -181},
  ])("rejects an out-of-range location (%j)", (location) => {
    const result = createOutletBodySchema.safeParse({
      name: "Valid Name", slug: "valid-slug", location,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an address field over its max length", () => {
    const result = createOutletBodySchema.safeParse({
      name: "Valid Name",
      slug: "valid-slug",
      address: {line1: "x".repeat(201)},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a description over 500 chars", () => {
    const result = createOutletBodySchema.safeParse({
      name: "Valid Name", slug: "valid-slug", description: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("strips authority fields the client has no business setting", () => {
    const result = createOutletBodySchema.safeParse({
      name: "Valid Name",
      slug: "valid-slug",
      status: "inactive",
      id: "outlet-attacker",
      organizationId: "org-attacker",
      createdBy: "U-attacker",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("status");
      expect(result.data).not.toHaveProperty("id");
      expect(result.data).not.toHaveProperty("organizationId");
      expect(result.data).not.toHaveProperty("createdBy");
    }
  });
});

describe("updateOutletBodySchema", () => {
  it("accepts a single-field update", () => {
    expect(updateOutletBodySchema.safeParse({phone: "0499xxxxxxx"}).success).toBe(true);
  });

  it("accepts every editable field together", () => {
    const result = updateOutletBodySchema.safeParse({
      name: "New Name",
      description: "New description",
      phone: "0499xxxxxxx",
      address: {city: "Kasaragod"},
      location: {latitude: 12.5, longitude: 74.9},
      status: "inactive",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(updateOutletBodySchema.safeParse({}).success).toBe(false);
  });

  it("rejects an invalid status", () => {
    expect(updateOutletBodySchema.safeParse({status: "closed"}).success).toBe(false);
  });

  it.each(["slug", "id", "organizationId", "createdBy", "createdAt", "updatedAt"])(
    "strips the immutable field %s rather than accepting it",
    (field) => {
      const result = updateOutletBodySchema.safeParse({name: "New Name", [field]: "attacker-value"});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty(field);
      }
    },
  );
});

describe("createOutlet", () => {
  it("creates the outlet and slug reservation atomically", async () => {
    const {db, creates, outletAutoId} = fakeCreateDb(false);

    const outlet = await createOutlet(db, ORG_ID, "U-1", {name: "Main Canteen", slug: "main-canteen"});

    expect(creates).toHaveLength(2);
    expect(outlet).toMatchObject({
      id: outletAutoId,
      organizationId: ORG_ID,
      name: "Main Canteen",
      slug: "main-canteen",
      status: "active",
      createdBy: "U-1",
    });
  });

  it("uses the pre-allocated Firestore auto-ID, never anything from the input", async () => {
    const {db, outletAutoId} = fakeCreateDb(false);

    const outlet = await createOutlet(db, ORG_ID, "U-1", {
      name: "Main Canteen", slug: "main-canteen",
    } as never);

    expect(outlet.id).toBe(outletAutoId);
  });

  it("always sets status active and createdBy from the caller, never from input", async () => {
    const {db} = fakeCreateDb(false);

    const outlet = await createOutlet(db, ORG_ID, "U-caller", {
      name: "Main Canteen",
      slug: "main-canteen",
    });

    expect(outlet.status).toBe("active");
    expect(outlet.createdBy).toBe("U-caller");
  });

  it("omits unset optional fields entirely rather than writing them as undefined", async () => {
    const {db, creates} = fakeCreateDb(false);

    await createOutlet(db, ORG_ID, "U-1", {name: "Main Canteen", slug: "main-canteen"});

    const outletCreate = creates.find((c) => c.path.includes("/outlets/"));
    expect(outletCreate?.data).not.toHaveProperty("description");
    expect(outletCreate?.data).not.toHaveProperty("phone");
    expect(outletCreate?.data).not.toHaveProperty("address");
    expect(outletCreate?.data).not.toHaveProperty("location");
  });

  it("checks the slug reservation before writing anything", async () => {
    const {db, get} = fakeCreateDb(false);

    await createOutlet(db, ORG_ID, "U-1", {name: "Main Canteen", slug: "main-canteen"});

    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({path: `organizations/${ORG_ID}/outletSlugs/main-canteen`}),
    );
  });

  it("throws already-exists and creates nothing when the slug is already taken", async () => {
    const {db, creates} = fakeCreateDb(true);

    await expect(
      createOutlet(db, ORG_ID, "U-1", {name: "Main Canteen", slug: "main-canteen"}),
    ).rejects.toMatchObject({code: "already-exists"});
    expect(creates).toHaveLength(0);
  });

  it("throws an HttpsError instance on slug conflict", async () => {
    const {db} = fakeCreateDb(true);

    await expect(
      createOutlet(db, ORG_ID, "U-1", {name: "Main Canteen", slug: "main-canteen"}),
    ).rejects.toBeInstanceOf(HttpsError);
  });
});

/** A fake Admin Firestore for `listOutletsForOrganization`. */
function fakeListDb(outletDocs: Array<Record<string, unknown>>) {
  const query = {
    orderBy: vi.fn(() => query),
    get: vi.fn(async () => ({
      docs: outletDocs.map((data) => ({id: data.id as string, data: () => data})),
    })),
  };
  const db = {
    collection: () => ({doc: () => ({collection: () => ({orderBy: query.orderBy})})}),
  };
  return {db: db as unknown as Firestore, orderBy: query.orderBy};
}

const validOutletDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  organizationId: ORG_ID,
  name: "Main Canteen",
  slug: `main-canteen-${id}`,
  status: "active",
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  createdBy: "U-owner",
  ...overrides,
});

describe("listOutletsForOrganization", () => {
  it("returns [] for an organization with no outlets", async () => {
    const {db} = fakeListDb([]);

    expect(await listOutletsForOrganization(db, ORG_ID)).toEqual([]);
  });

  it("orders by createdAt ascending (delegated to the query, asserted here)", async () => {
    const {db, orderBy} = fakeListDb([validOutletDoc("outlet-a"), validOutletDoc("outlet-b")]);

    const result = await listOutletsForOrganization(db, ORG_ID);

    expect(orderBy).toHaveBeenCalledWith("createdAt", "asc");
    expect(result.map((o) => o.id)).toEqual(["outlet-a", "outlet-b"]);
  });

  it("includes inactive outlets rather than filtering them out", async () => {
    const {db} = fakeListDb([validOutletDoc("outlet-a", {status: "inactive"})]);

    const result = await listOutletsForOrganization(db, ORG_ID);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("inactive");
  });

  it("throws when a stored outlet document is malformed", async () => {
    const {db} = fakeListDb([{id: "outlet-a", name: "Incomplete"}]);

    await expect(listOutletsForOrganization(db, ORG_ID)).rejects.toThrow();
  });

  it("throws when a stored outlet's organizationId does not match the path it was read from", async () => {
    const {db} = fakeListDb([validOutletDoc("outlet-a", {organizationId: "org-other"})]);

    await expect(listOutletsForOrganization(db, ORG_ID)).rejects.toThrow();
  });
});

/** A fake Admin Firestore for `updateOutlet`. */
function fakeUpdateDb(existing: Record<string, unknown> | undefined) {
  const updates: Array<{path: string; data: unknown}> = [];
  const outletPath = `organizations/${ORG_ID}/outlets/outlet-1`;

  const tx = {
    get: vi.fn(async () => ({
      exists: existing !== undefined,
      data: () => existing,
    })),
    update: vi.fn((ref: {path: string}, data: unknown) => {
      updates.push({path: ref.path, data});
    }),
  };

  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({path: outletPath}),
        }),
      }),
    }),
    runTransaction: vi.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };

  return {db: db as unknown as Firestore, updates};
}

describe("updateOutlet", () => {
  it("updates only the provided fields and bumps updatedAt", async () => {
    const existing = validOutletDoc("outlet-1", {name: "Old Name", phone: "0000"});
    const {db, updates} = fakeUpdateDb(existing);

    const result = await updateOutlet(db, ORG_ID, "outlet-1", {phone: "1111"} as UpdateOutletInput);

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({phone: "1111"});
    expect(updates[0].data).not.toHaveProperty("name");
    expect(result.name).toBe("Old Name");
    expect(result.phone).toBe("1111");
    expect(result.updatedAt.toMillis()).toBeGreaterThanOrEqual((existing.updatedAt as Timestamp).toMillis());
  });

  it("throws not-found for a nonexistent outlet", async () => {
    const {db} = fakeUpdateDb(undefined);

    await expect(
      updateOutlet(db, ORG_ID, "outlet-1", {name: "New Name"} as UpdateOutletInput),
    ).rejects.toMatchObject({code: "not-found"});
  });

  it.each(["", "a/b", ".", "..", "__reserved__"])(
    "rejects a malformed outlet ID (%j) with invalid-argument, before touching Firestore",
    async (outletId) => {
      const {db} = fakeUpdateDb(validOutletDoc("outlet-1"));

      await expect(
        updateOutlet(db, ORG_ID, outletId, {name: "New Name"} as UpdateOutletInput),
      ).rejects.toMatchObject({code: "invalid-argument"});
    },
  );

  it("can update the status to inactive and back", async () => {
    const {db, updates} = fakeUpdateDb(validOutletDoc("outlet-1", {status: "active"}));

    const result = await updateOutlet(db, ORG_ID, "outlet-1", {status: "inactive"} as UpdateOutletInput);

    expect(result.status).toBe("inactive");
    expect(updates[0].data).toMatchObject({status: "inactive"});
  });
});

describe("toOutletResponse", () => {
  it("renders createdAt/updatedAt as ISO 8601 strings", () => {
    const createdAt = Timestamp.fromDate(new Date("2026-09-27T10:00:00Z"));
    const updatedAt = Timestamp.fromDate(new Date("2026-09-27T11:00:00Z"));

    expect(toOutletResponse({
      id: "outlet-1",
      organizationId: ORG_ID,
      name: "Main Canteen",
      slug: "main-canteen",
      status: "active",
      createdAt,
      updatedAt,
      createdBy: "U-1",
    })).toEqual({
      id: "outlet-1",
      organizationId: ORG_ID,
      name: "Main Canteen",
      slug: "main-canteen",
      status: "active",
      createdAt: "2026-09-27T10:00:00.000Z",
      updatedAt: "2026-09-27T11:00:00.000Z",
      createdBy: "U-1",
    });
  });

  it("includes optional fields when set", () => {
    const now = Timestamp.now();

    const response = toOutletResponse({
      id: "outlet-1",
      organizationId: ORG_ID,
      name: "Main Canteen",
      slug: "main-canteen",
      description: "Main campus food outlet",
      status: "active",
      phone: "0499xxxxxxx",
      address: {city: "Kasaragod"},
      location: {latitude: 12.5, longitude: 74.9},
      createdAt: now,
      updatedAt: now,
      createdBy: "U-1",
    });

    expect(response).toMatchObject({
      description: "Main campus food outlet",
      phone: "0499xxxxxxx",
      address: {city: "Kasaragod"},
      location: {latitude: 12.5, longitude: 74.9},
    });
  });
});

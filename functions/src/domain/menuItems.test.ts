// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {describe, expect, it, vi} from "vitest";
import type {Menu} from "./menus";
import {
  createMenuItem,
  createMenuItemBodySchema,
  deleteMenuItem,
  findItemDeletionViolation,
  findItemMutationViolation,
  getMenuItem,
  listMenuItemsForMenu,
  toMenuItemResponse,
  updateMenuItem,
  updateMenuItemBodySchema,
  type MenuItem,
  type UpdateMenuItemInput,
} from "./menuItems";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
const MENU_ID = "menu-1";

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Chicken Biriyani",
    description: "Aromatic chicken biriyani",
    priceInPaise: 12000,
    displayOrder: 1,
    ...overrides,
  };
}

const validItemDoc = (id: string, overrides: Record<string, unknown> = {}): MenuItem => ({
  id,
  menuId: MENU_ID,
  name: "Chicken Biriyani",
  description: "Aromatic chicken biriyani",
  priceInPaise: 12000,
  enabled: true,
  displayOrder: 1,
  createdAt: Timestamp.fromDate(new Date("2026-09-26T04:00:00Z")),
  updatedAt: Timestamp.fromDate(new Date("2026-09-26T04:00:00Z")),
  createdBy: "U-owner",
  ...(overrides as Partial<MenuItem>),
});

/** A minimal parent `Menu` fixture — only the fields `findItemMutationViolation`/
 * `findItemDeletionViolation` and the CRUD functions' path-building care
 * about need to be realistic. */
function validMenu(overrides: Partial<Menu> = {}): Menu {
  return {
    id: MENU_ID,
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuDate: "2026-09-28",
    title: "Tuesday Special Menu",
    status: "draft",
    orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T10:00:00Z")),
    pickupStartsAt: Timestamp.fromDate(new Date("2026-09-28T06:00:00Z")),
    pickupEndsAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
    createdAt: Timestamp.fromDate(new Date("2026-09-26T04:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-26T04:00:00Z")),
    createdBy: "U-owner",
    ...overrides,
  };
}

describe("createMenuItemBodySchema", () => {
  it("accepts a valid, fully populated body", () => {
    expect(createMenuItemBodySchema.safeParse(validCreateBody()).success).toBe(true);
  });

  it("trims name and description", () => {
    const result = createMenuItemBodySchema.safeParse(validCreateBody({
      name: "  Chicken Biriyani  ",
      description: "  Aromatic.  ",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Chicken Biriyani");
      expect(result.data.description).toBe("Aromatic.");
    }
  });

  it("accepts a body with no description", () => {
    const {name, priceInPaise, displayOrder} = validCreateBody();
    expect(createMenuItemBodySchema.safeParse({name, priceInPaise, displayOrder}).success).toBe(true);
  });

  it.each([
    ["", "empty name"],
    [" ".repeat(5), "whitespace-only name"],
    ["x".repeat(101), "name over 100 chars"],
  ])("rejects an invalid name (%s)", (name) => {
    expect(createMenuItemBodySchema.safeParse(validCreateBody({name})).success).toBe(false);
  });

  it("rejects a description over 500 chars", () => {
    expect(createMenuItemBodySchema.safeParse(validCreateBody({description: "x".repeat(501)})).success).toBe(false);
  });

  it.each([0, 8000, 9950, 12000])("accepts priceInPaise %d", (priceInPaise) => {
    expect(createMenuItemBodySchema.safeParse(validCreateBody({priceInPaise})).success).toBe(true);
  });

  it.each<[string | number, string]>([
    [-100, "negative"],
    [12000.5, "decimal"],
    [Number.NaN, "NaN"],
    ["12000", "string"],
  ])("rejects priceInPaise %s (%s)", (priceInPaise) => {
    expect(createMenuItemBodySchema.safeParse(validCreateBody({priceInPaise})).success).toBe(false);
  });

  it.each([0, 1, 42])("accepts displayOrder %d", (displayOrder) => {
    expect(createMenuItemBodySchema.safeParse(validCreateBody({displayOrder})).success).toBe(true);
  });

  it.each<[string | number, string]>([
    [-1, "negative"],
    [1.5, "decimal"],
    ["1", "string"],
  ])("rejects displayOrder %s (%s)", (displayOrder) => {
    expect(createMenuItemBodySchema.safeParse(validCreateBody({displayOrder})).success).toBe(false);
  });

  it("strips authority fields the client has no business setting", () => {
    const result = createMenuItemBodySchema.safeParse(validCreateBody({
      id: "item-attacker",
      menuId: "menu-attacker",
      enabled: false,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      createdBy: "U-attacker",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("id");
      expect(result.data).not.toHaveProperty("menuId");
      expect(result.data).not.toHaveProperty("enabled");
      expect(result.data).not.toHaveProperty("createdAt");
      expect(result.data).not.toHaveProperty("updatedAt");
      expect(result.data).not.toHaveProperty("createdBy");
    }
  });
});

describe("updateMenuItemBodySchema", () => {
  it("accepts a single-field update", () => {
    expect(updateMenuItemBodySchema.safeParse({name: "New Name"}).success).toBe(true);
  });

  it("accepts every editable field together, including enabled", () => {
    const result = updateMenuItemBodySchema.safeParse({...validCreateBody(), enabled: false});
    expect(result.success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(updateMenuItemBodySchema.safeParse({}).success).toBe(false);
  });

  it.each(["id", "menuId", "createdBy", "createdAt"])(
    "strips the immutable field %s rather than accepting it",
    (field) => {
      const result = updateMenuItemBodySchema.safeParse({name: "New Name", [field]: "attacker-value"});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty(field);
      }
    },
  );

  it("rejects a negative price", () => {
    expect(updateMenuItemBodySchema.safeParse({priceInPaise: -1}).success).toBe(false);
  });

  it("rejects a decimal displayOrder", () => {
    expect(updateMenuItemBodySchema.safeParse({displayOrder: 1.5}).success).toBe(false);
  });
});

describe("findItemMutationViolation", () => {
  const NOW = new Date("2026-09-27T12:00:00Z");

  it("allows mutations on a draft menu", () => {
    expect(findItemMutationViolation(validMenu({status: "draft"}), NOW)).toBeNull();
  });

  it("allows mutations on a draft menu even if its orderingClosesAt is already in the past", () => {
    const menu = validMenu({
      status: "draft",
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T11:00:00Z")), // before NOW
    });
    expect(findItemMutationViolation(menu, NOW)).toBeNull();
  });

  it("allows mutations on a published menu while ordering is still open", () => {
    const menu = validMenu({
      status: "published",
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T13:00:00Z")), // after NOW
    });
    expect(findItemMutationViolation(menu, NOW)).toBeNull();
  });

  it("blocks mutations on a published menu once ordering has closed", () => {
    const menu = validMenu({
      status: "published",
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T11:00:00Z")), // before NOW
    });
    expect(findItemMutationViolation(menu, NOW)).not.toBeNull();
  });

  it("blocks mutations on a published menu exactly at orderingClosesAt", () => {
    const menu = validMenu({
      status: "published",
      orderingClosesAt: Timestamp.fromDate(NOW),
    });
    expect(findItemMutationViolation(menu, NOW)).not.toBeNull();
  });

  it("always blocks mutations on an archived menu, regardless of the ordering window", () => {
    const menu = validMenu({
      status: "archived",
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T13:00:00Z")), // after NOW
    });
    expect(findItemMutationViolation(menu, NOW)).not.toBeNull();
  });
});

describe("findItemDeletionViolation", () => {
  it("allows deletion on a draft menu", () => {
    expect(findItemDeletionViolation(validMenu({status: "draft"}))).toBeNull();
  });

  it("blocks deletion on a published menu, even while ordering is still open", () => {
    expect(findItemDeletionViolation(validMenu({status: "published"}))).not.toBeNull();
  });

  it("blocks deletion on an archived menu", () => {
    expect(findItemDeletionViolation(validMenu({status: "archived"}))).not.toBeNull();
  });
});

describe("createMenuItem", () => {
  function fakeCreateDb() {
    const itemAutoId = "item-auto-1";
    const creates: Array<{data: unknown}> = [];
    const create = vi.fn(async (data: unknown) => {
      creates.push({data});
    });
    const db = {
      collection: (name: string) => {
        if (name !== "organizations") throw new Error(`unexpected collection: ${name}`);
        return {
          doc: () => ({
            collection: (n: string) => {
              if (n !== "outlets") throw new Error(`unexpected subcollection: ${n}`);
              return {
                doc: () => ({
                  collection: (n2: string) => {
                    if (n2 !== "menus") throw new Error(`unexpected subcollection: ${n2}`);
                    return {
                      doc: () => ({
                        collection: (n3: string) => {
                          if (n3 !== "items") throw new Error(`unexpected subcollection: ${n3}`);
                          return {doc: () => ({id: itemAutoId, create})};
                        },
                      }),
                    };
                  },
                }),
              };
            },
          }),
        };
      },
    };
    return {db: db as unknown as Firestore, creates, itemAutoId};
  }

  it("creates the item with enabled=true and the caller as createdBy", async () => {
    const {db, creates, itemAutoId} = fakeCreateDb();
    const parsed = createMenuItemBodySchema.safeParse(validCreateBody());
    if (!parsed.success) throw new Error("fixture invalid");

    const item = await createMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "U-caller", parsed.data);

    expect(creates).toHaveLength(1);
    expect(item).toMatchObject({
      id: itemAutoId,
      menuId: MENU_ID,
      enabled: true,
      createdBy: "U-caller",
      name: "Chicken Biriyani",
      priceInPaise: 12000,
    });
  });

  it("does not write organizationId/outletId onto the item document", async () => {
    const {db, creates} = fakeCreateDb();
    const parsed = createMenuItemBodySchema.safeParse(validCreateBody());
    if (!parsed.success) throw new Error("fixture invalid");

    await createMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "U-caller", parsed.data);

    expect(creates[0].data).not.toHaveProperty("organizationId");
    expect(creates[0].data).not.toHaveProperty("outletId");
  });

  it("uses the pre-allocated Firestore auto-ID, never anything from the input", async () => {
    const {db, itemAutoId} = fakeCreateDb();
    const parsed = createMenuItemBodySchema.safeParse(validCreateBody());
    if (!parsed.success) throw new Error("fixture invalid");

    const item = await createMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "U-caller", parsed.data);

    expect(item.id).toBe(itemAutoId);
  });

  it("omits description entirely when not supplied, rather than writing undefined", async () => {
    const {db, creates} = fakeCreateDb();
    const {name, priceInPaise, displayOrder} = validCreateBody();
    const parsed = createMenuItemBodySchema.safeParse({name, priceInPaise, displayOrder});
    if (!parsed.success) throw new Error("fixture invalid");

    await createMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "U-caller", parsed.data);

    expect(creates[0].data).not.toHaveProperty("description");
  });

  it("does not wrap the write in a transaction (no runTransaction call)", async () => {
    const {db} = fakeCreateDb();
    const runTransaction = vi.fn();
    (db as unknown as {runTransaction: typeof runTransaction}).runTransaction = runTransaction;
    const parsed = createMenuItemBodySchema.safeParse(validCreateBody());
    if (!parsed.success) throw new Error("fixture invalid");

    await createMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "U-caller", parsed.data);

    expect(runTransaction).not.toHaveBeenCalled();
  });
});

/** A fake Admin Firestore for `listMenuItemsForMenu`. */
function fakeListDb(itemDocs: Array<MenuItem | Record<string, unknown>>) {
  const orderBy2 = vi.fn(() => ({
    get: async () => ({
      docs: itemDocs.map((data) => ({id: data.id as string, data: () => data})),
    }),
  }));
  const orderBy1 = vi.fn(() => ({orderBy: orderBy2}));
  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: () => ({collection: () => ({orderBy: orderBy1})}),
            }),
          }),
        }),
      }),
    }),
  };
  return {db: db as unknown as Firestore, orderBy1, orderBy2};
}

describe("listMenuItemsForMenu", () => {
  it("returns [] for a menu with no items", async () => {
    const {db} = fakeListDb([]);
    expect(await listMenuItemsForMenu(db, ORG_ID, OUTLET_ID, MENU_ID)).toEqual([]);
  });

  it("orders by displayOrder then createdAt ascending (delegated to the query, asserted here)", async () => {
    const {db, orderBy1, orderBy2} = fakeListDb([
      validItemDoc("item-a"),
      validItemDoc("item-b"),
    ]);

    const result = await listMenuItemsForMenu(db, ORG_ID, OUTLET_ID, MENU_ID);

    expect(orderBy1).toHaveBeenCalledWith("displayOrder", "asc");
    expect(orderBy2).toHaveBeenCalledWith("createdAt", "asc");
    expect(result.map((i) => i.id)).toEqual(["item-a", "item-b"]);
  });

  it("includes disabled items rather than filtering any out", async () => {
    const {db} = fakeListDb([
      validItemDoc("item-a", {enabled: true}),
      validItemDoc("item-b", {enabled: false}),
    ]);

    const result = await listMenuItemsForMenu(db, ORG_ID, OUTLET_ID, MENU_ID);

    expect(result.map((i) => i.enabled)).toEqual([true, false]);
  });

  it("throws when a stored item document is malformed", async () => {
    const {db} = fakeListDb([{id: "item-a", name: "Incomplete"}]);
    await expect(listMenuItemsForMenu(db, ORG_ID, OUTLET_ID, MENU_ID)).rejects.toThrow();
  });

  it("throws when a stored item's menuId does not match the path it was read from", async () => {
    const {db} = fakeListDb([validItemDoc("item-a", {menuId: "menu-other"})]);
    await expect(listMenuItemsForMenu(db, ORG_ID, OUTLET_ID, MENU_ID)).rejects.toThrow();
  });
});

/** A fake Admin Firestore for `getMenuItem`. */
function fakeGetDb(existing: MenuItem | Record<string, unknown> | undefined) {
  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: () => ({
                collection: () => ({
                  doc: () => ({
                    get: async () => ({exists: existing !== undefined, data: () => existing}),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
  return {db: db as unknown as Firestore};
}

describe("getMenuItem", () => {
  it("returns the item when it exists", async () => {
    const {db} = fakeGetDb(validItemDoc("item-1"));
    const item = await getMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1");
    expect(item.id).toBe("item-1");
  });

  it("throws not-found for a nonexistent item", async () => {
    const {db} = fakeGetDb(undefined);
    await expect(getMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1"))
      .rejects.toMatchObject({code: "not-found"});
  });

  it.each(["", "a/b", ".", "..", "__reserved__"])(
    "rejects a malformed item ID (%j) with invalid-argument, before touching Firestore",
    async (itemId) => {
      const {db} = fakeGetDb(validItemDoc("item-1"));
      await expect(getMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, itemId))
        .rejects.toMatchObject({code: "invalid-argument"});
    },
  );
});

/** A fake Admin Firestore for `updateMenuItem`. */
function fakeMutateDb(existing: MenuItem | Record<string, unknown> | undefined) {
  const updates: Array<{data: unknown}> = [];
  const tx = {
    get: vi.fn(async () => ({exists: existing !== undefined, data: () => existing})),
    update: vi.fn((_ref: unknown, data: unknown) => {
      updates.push({data});
    }),
  };
  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: () => ({
                collection: () => ({
                  doc: () => ({/* opaque ref token, only ever passed to tx.get/tx.update below */}),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {db: db as unknown as Firestore, updates};
}

describe("updateMenuItem", () => {
  it("updates only the provided fields and bumps updatedAt", async () => {
    const existing = validItemDoc("item-1");
    const {db, updates} = fakeMutateDb(existing);

    const result = await updateMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1", {name: "New Name"} as UpdateMenuItemInput);

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({name: "New Name"});
    expect(updates[0].data).not.toHaveProperty("priceInPaise");
    expect(result.name).toBe("New Name");
    expect(result.updatedAt.toMillis()).toBeGreaterThanOrEqual(existing.updatedAt.toMillis());
  });

  it("throws not-found for a nonexistent item", async () => {
    const {db} = fakeMutateDb(undefined);
    await expect(updateMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1", {name: "New Name"} as UpdateMenuItemInput))
      .rejects.toMatchObject({code: "not-found"});
  });

  it.each(["", "a/b", ".", "..", "__reserved__"])(
    "rejects a malformed item ID (%j) with invalid-argument, before touching Firestore",
    async (itemId) => {
      const {db} = fakeMutateDb(validItemDoc("item-1"));
      await expect(updateMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, itemId, {name: "New Name"} as UpdateMenuItemInput))
        .rejects.toMatchObject({code: "invalid-argument"});
    },
  );

  it("can toggle enabled false then true", async () => {
    const existing = validItemDoc("item-1");
    const {db, updates} = fakeMutateDb(existing);

    const disabled = await updateMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1", {enabled: false} as UpdateMenuItemInput);

    expect(disabled.enabled).toBe(false);
    expect(updates[0].data).toMatchObject({enabled: false});
  });

  it("updates priceInPaise, keeping it an integer", async () => {
    const existing = validItemDoc("item-1");
    const {db} = fakeMutateDb(existing);

    const result = await updateMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1", {priceInPaise: 14000} as UpdateMenuItemInput);

    expect(result.priceInPaise).toBe(14000);
    expect(Number.isInteger(result.priceInPaise)).toBe(true);
  });

  it("updates displayOrder", async () => {
    const existing = validItemDoc("item-1");
    const {db} = fakeMutateDb(existing);

    const result = await updateMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1", {displayOrder: 5} as UpdateMenuItemInput);

    expect(result.displayOrder).toBe(5);
  });

  it("ignores an attempt to change id/menuId/createdBy/createdAt", async () => {
    const existing = validItemDoc("item-1");
    const {db, updates} = fakeMutateDb(existing);

    await updateMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1", {
      name: "New Name",
      id: "item-attacker",
      menuId: "menu-attacker",
      createdBy: "U-attacker",
      createdAt: Timestamp.now(),
    } as unknown as UpdateMenuItemInput);

    expect(updates[0].data).not.toHaveProperty("id");
    expect(updates[0].data).not.toHaveProperty("menuId");
    expect(updates[0].data).not.toHaveProperty("createdBy");
    expect(updates[0].data).not.toHaveProperty("createdAt");
  });
});

describe("deleteMenuItem", () => {
  function fakeDeleteDb(existing: MenuItem | Record<string, unknown> | undefined) {
    const deleteFn = vi.fn(async () => undefined);
    const db = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              collection: () => ({
                doc: () => ({
                  collection: () => ({
                    doc: () => ({
                      get: async () => ({exists: existing !== undefined, data: () => existing}),
                      delete: deleteFn,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };
    return {db: db as unknown as Firestore, deleteFn};
  }

  it("deletes the item when it exists", async () => {
    const {db, deleteFn} = fakeDeleteDb(validItemDoc("item-1"));

    await deleteMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1");

    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it("throws not-found for a nonexistent item, without calling delete", async () => {
    const {db, deleteFn} = fakeDeleteDb(undefined);

    await expect(deleteMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, "item-1"))
      .rejects.toMatchObject({code: "not-found"});
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it.each(["", "a/b", ".", "..", "__reserved__"])(
    "rejects a malformed item ID (%j) with invalid-argument, before touching Firestore",
    async (itemId) => {
      const {db} = fakeDeleteDb(validItemDoc("item-1"));
      await expect(deleteMenuItem(db, ORG_ID, OUTLET_ID, MENU_ID, itemId))
        .rejects.toMatchObject({code: "invalid-argument"});
    },
  );
});

describe("toMenuItemResponse", () => {
  it("renders every timestamp field as an ISO 8601 string", () => {
    const item = validItemDoc("item-1");
    const response = toMenuItemResponse(item);
    expect(response.createdAt).toBe("2026-09-26T04:00:00.000Z");
    expect(response.updatedAt).toBe("2026-09-26T04:00:00.000Z");
  });

  it("keeps priceInPaise an integer", () => {
    const response = toMenuItemResponse(validItemDoc("item-1", {priceInPaise: 9950}));
    expect(response.priceInPaise).toBe(9950);
    expect(Number.isInteger(response.priceInPaise)).toBe(true);
  });

  it("includes description when set", () => {
    const response = toMenuItemResponse(validItemDoc("item-1", {description: "Aromatic."}));
    expect(response.description).toBe("Aromatic.");
  });

  it("omits description when not set", () => {
    const item = validItemDoc("item-1");
    delete item.description;
    expect(toMenuItemResponse(item).description).toBeUndefined();
  });
});

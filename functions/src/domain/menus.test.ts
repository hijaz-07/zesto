// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  archiveMenu,
  createMenu,
  createMenuBodySchema,
  findScheduleViolation,
  getMenu,
  listMenusForOutlet,
  publishMenu,
  toMenuResponse,
  updateMenu,
  updateMenuBodySchema,
  type Menu,
  type UpdateMenuInput,
} from "./menus";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";

// "Now" is pinned for every test in this file so past/future and
// ordering-window-lock checks (which read the real clock, matching
// domain/outlets.ts's no-injected-clock convention) are deterministic
// regardless of when the suite actually runs. 12:00Z is 17:30 IST, still
// calendar day 2026-09-27 in Kolkata.
const FIXED_NOW = new Date("2026-09-27T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A self-consistent, valid request body: menuDate is "tomorrow" relative to `FIXED_NOW`. */
function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    menuDate: "2026-09-28",
    title: "Tuesday Special Menu",
    description: "Freshly prepared lunch menu.",
    orderingOpensAt: "2026-09-27T04:00:00Z",
    orderingClosesAt: "2026-09-27T10:00:00Z",
    pickupStartsAt: "2026-09-28T06:00:00Z",
    pickupEndsAt: "2026-09-28T10:00:00Z",
    ...overrides,
  };
}

const validMenuDoc = (id: string, overrides: Record<string, unknown> = {}): Menu => ({
  id,
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
  ...(overrides as Partial<Menu>),
});

describe("createMenuBodySchema", () => {
  it("accepts a valid, fully populated body", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody());
    expect(result.success).toBe(true);
  });

  it("transforms the 4 schedule fields into Firestore Timestamps", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orderingOpensAt).toBeInstanceOf(Timestamp);
      expect(result.data.orderingClosesAt).toBeInstanceOf(Timestamp);
      expect(result.data.pickupStartsAt).toBeInstanceOf(Timestamp);
      expect(result.data.pickupEndsAt).toBeInstanceOf(Timestamp);
    }
  });

  it("accepts a timestamp with a numeric UTC offset instead of Z", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      orderingOpensAt: "2026-09-27T09:30:00+05:30",
    }));
    expect(result.success).toBe(true);
  });

  it("trims title and description", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      title: "  Tuesday Special Menu  ",
      description: "  Freshly prepared.  ",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Tuesday Special Menu");
      expect(result.data.description).toBe("Freshly prepared.");
    }
  });

  it("accepts a body with no description", () => {
    const {menuDate, title, orderingOpensAt, orderingClosesAt, pickupStartsAt, pickupEndsAt} = validCreateBody();
    const result = createMenuBodySchema.safeParse({
      menuDate, title, orderingOpensAt, orderingClosesAt, pickupStartsAt, pickupEndsAt,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["", "empty menuDate"],
    ["2026/09/28", "wrong separator"],
    ["28-09-2026", "wrong field order"],
    ["2026-9-28", "unpadded month"],
    ["2026-02-30", "nonexistent calendar date"],
    ["2023-02-29", "nonexistent leap day"],
    ["not-a-date", "garbage"],
  ])("rejects an invalid menuDate (%s: %s)", (menuDate) => {
    const result = createMenuBodySchema.safeParse(validCreateBody({menuDate}));
    expect(result.success).toBe(false);
  });

  it("accepts a real leap day", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      menuDate: "2028-02-29",
      pickupStartsAt: "2028-02-29T06:00:00Z",
      pickupEndsAt: "2028-02-29T10:00:00Z",
      orderingOpensAt: "2028-02-28T04:00:00Z",
      orderingClosesAt: "2028-02-28T10:00:00Z",
    }));
    expect(result.success).toBe(true);
  });

  it("rejects a menuDate before today in Asia/Kolkata", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      menuDate: "2026-09-26",
      pickupStartsAt: "2026-09-26T06:00:00Z",
      pickupEndsAt: "2026-09-26T10:00:00Z",
    }));
    expect(result.success).toBe(false);
  });

  it("accepts a menuDate of today (today is not \"in the past\")", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      menuDate: "2026-09-27",
      pickupStartsAt: "2026-09-27T14:00:00Z",
      pickupEndsAt: "2026-09-27T18:00:00Z",
    }));
    expect(result.success).toBe(true);
  });

  it.each([
    ["", "empty title"],
    [" ".repeat(5), "whitespace-only title"],
    ["x".repeat(101), "title over 100 chars"],
  ])("rejects an invalid title (%s)", (title) => {
    const result = createMenuBodySchema.safeParse(validCreateBody({title}));
    expect(result.success).toBe(false);
  });

  it("rejects a description over 500 chars", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      description: "x".repeat(501),
    }));
    expect(result.success).toBe(false);
  });

  it.each([
    "orderingOpensAt",
    "orderingClosesAt",
    "pickupStartsAt",
    "pickupEndsAt",
  ])("rejects a malformed %s", (field) => {
    const result = createMenuBodySchema.safeParse(validCreateBody({[field]: "not-a-timestamp"}));
    expect(result.success).toBe(false);
  });

  it("rejects orderingOpensAt >= orderingClosesAt", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      orderingOpensAt: "2026-09-27T10:00:00Z",
      orderingClosesAt: "2026-09-27T10:00:00Z",
    }));
    expect(result.success).toBe(false);
  });

  it("rejects pickupStartsAt >= pickupEndsAt", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      pickupStartsAt: "2026-09-28T10:00:00Z",
      pickupEndsAt: "2026-09-28T10:00:00Z",
    }));
    expect(result.success).toBe(false);
  });

  it("rejects orderingClosesAt after pickupStartsAt", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      orderingClosesAt: "2026-09-28T07:00:00Z",
      pickupStartsAt: "2026-09-28T06:00:00Z",
    }));
    expect(result.success).toBe(false);
  });

  it("accepts orderingClosesAt exactly equal to pickupStartsAt", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      orderingClosesAt: "2026-09-28T06:00:00Z",
      pickupStartsAt: "2026-09-28T06:00:00Z",
    }));
    expect(result.success).toBe(true);
  });

  it("rejects a pickup window starting before the menu's service date", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      menuDate: "2026-09-29",
      orderingOpensAt: "2026-09-27T04:00:00Z",
      orderingClosesAt: "2026-09-27T10:00:00Z",
      pickupStartsAt: "2026-09-28T06:00:00Z",
      pickupEndsAt: "2026-09-28T10:00:00Z",
    }));
    expect(result.success).toBe(false);
  });

  it("accepts a pickup date after the menu's service date", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      menuDate: "2026-09-27",
      orderingOpensAt: "2026-09-26T04:00:00Z",
      orderingClosesAt: "2026-09-26T10:00:00Z",
      pickupStartsAt: "2026-09-28T06:00:00Z",
      pickupEndsAt: "2026-09-28T10:00:00Z",
    }));
    expect(result.success).toBe(true);
  });

  it("strips authority fields the client has no business setting", () => {
    const result = createMenuBodySchema.safeParse(validCreateBody({
      status: "published",
      id: "menu-attacker",
      organizationId: "org-attacker",
      outletId: "outlet-attacker",
      createdBy: "U-attacker",
      publishedAt: "2026-09-01T00:00:00Z",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("status");
      expect(result.data).not.toHaveProperty("id");
      expect(result.data).not.toHaveProperty("organizationId");
      expect(result.data).not.toHaveProperty("outletId");
      expect(result.data).not.toHaveProperty("createdBy");
      expect(result.data).not.toHaveProperty("publishedAt");
    }
  });
});

describe("updateMenuBodySchema", () => {
  it("accepts a single-field update", () => {
    expect(updateMenuBodySchema.safeParse({title: "New Title"}).success).toBe(true);
  });

  it("accepts every editable field together", () => {
    const result = updateMenuBodySchema.safeParse(validCreateBody());
    expect(result.success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(updateMenuBodySchema.safeParse({}).success).toBe(false);
  });

  it("does not cross-validate schedule fields against each other at the schema level", () => {
    // orderingOpensAt alone, with no orderingClosesAt to compare against —
    // must not spuriously fail; cross-field validation happens in
    // updateMenu against the merged stored document instead.
    const result = updateMenuBodySchema.safeParse({
      orderingOpensAt: "2026-09-27T04:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it.each(["status", "id", "organizationId", "outletId", "createdBy", "createdAt", "publishedAt"])(
    "strips the immutable/authority field %s rather than accepting it",
    (field) => {
      const result = updateMenuBodySchema.safeParse({title: "New Title", [field]: "attacker-value"});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty(field);
      }
    },
  );

  it("rejects an invalid menuDate", () => {
    expect(updateMenuBodySchema.safeParse({menuDate: "2026-02-30"}).success).toBe(false);
  });
});

describe("findScheduleViolation", () => {
  function schedule(overrides: Partial<{
    menuDate: string;
    orderingOpensAt: Timestamp;
    orderingClosesAt: Timestamp;
    pickupStartsAt: Timestamp;
    pickupEndsAt: Timestamp;
  }> = {}) {
    return {
      menuDate: "2026-09-28",
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T10:00:00Z")),
      pickupStartsAt: Timestamp.fromDate(new Date("2026-09-28T06:00:00Z")),
      pickupEndsAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
      ...overrides,
    };
  }

  it("returns null for a valid schedule", () => {
    expect(findScheduleViolation(schedule())).toBeNull();
  });

  it("flags orderingOpensAt >= orderingClosesAt", () => {
    const violation = findScheduleViolation(schedule({
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T10:00:00Z")),
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T10:00:00Z")),
    }));
    expect(violation).not.toBeNull();
  });

  it("flags pickupStartsAt >= pickupEndsAt", () => {
    const violation = findScheduleViolation(schedule({
      pickupStartsAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
      pickupEndsAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
    }));
    expect(violation).not.toBeNull();
  });

  it("flags orderingClosesAt after pickupStartsAt", () => {
    const violation = findScheduleViolation(schedule({
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-28T07:00:00Z")),
      pickupStartsAt: Timestamp.fromDate(new Date("2026-09-28T06:00:00Z")),
    }));
    expect(violation).not.toBeNull();
  });

  it("flags a pickup window before the menu's service date", () => {
    const violation = findScheduleViolation(schedule({menuDate: "2026-09-29"}));
    expect(violation).not.toBeNull();
  });

  it("allows a pickup date strictly after the menu's service date", () => {
    const violation = findScheduleViolation(schedule({
      menuDate: "2026-09-27",
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-26T04:00:00Z")),
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-26T10:00:00Z")),
    }));
    expect(violation).toBeNull();
  });
});

describe("createMenu", () => {
  function fakeCreateDb() {
    const menuAutoId = "menu-auto-1";
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
                    return {doc: () => ({id: menuAutoId, create})};
                  },
                }),
              };
            },
          }),
        };
      },
    };
    return {db: db as unknown as Firestore, creates, menuAutoId};
  }

  it("creates the menu with status draft and the caller as createdBy", async () => {
    const {db, creates, menuAutoId} = fakeCreateDb();
    const parsed = createMenuBodySchema.safeParse(validCreateBody());
    if (!parsed.success) throw new Error("fixture invalid");

    const menu = await createMenu(db, ORG_ID, OUTLET_ID, "U-caller", parsed.data);

    expect(creates).toHaveLength(1);
    expect(menu).toMatchObject({
      id: menuAutoId,
      organizationId: ORG_ID,
      outletId: OUTLET_ID,
      status: "draft",
      createdBy: "U-caller",
      title: "Tuesday Special Menu",
    });
  });

  it("uses the pre-allocated Firestore auto-ID, never anything from the input", async () => {
    const {db, menuAutoId} = fakeCreateDb();
    const parsed = createMenuBodySchema.safeParse(validCreateBody());
    if (!parsed.success) throw new Error("fixture invalid");

    const menu = await createMenu(db, ORG_ID, OUTLET_ID, "U-caller", parsed.data);

    expect(menu.id).toBe(menuAutoId);
  });

  it("omits description entirely when not supplied, rather than writing undefined", async () => {
    const {db, creates} = fakeCreateDb();
    const {menuDate, title, orderingOpensAt, orderingClosesAt, pickupStartsAt, pickupEndsAt} = validCreateBody();
    const parsed = createMenuBodySchema.safeParse({
      menuDate, title, orderingOpensAt, orderingClosesAt, pickupStartsAt, pickupEndsAt,
    });
    if (!parsed.success) throw new Error("fixture invalid");

    await createMenu(db, ORG_ID, OUTLET_ID, "U-caller", parsed.data);

    expect(creates[0].data).not.toHaveProperty("description");
  });

  it("does not wrap the write in a transaction (no runTransaction call)", async () => {
    const {db} = fakeCreateDb();
    const runTransaction = vi.fn();
    (db as unknown as {runTransaction: typeof runTransaction}).runTransaction = runTransaction;
    const parsed = createMenuBodySchema.safeParse(validCreateBody());
    if (!parsed.success) throw new Error("fixture invalid");

    await createMenu(db, ORG_ID, OUTLET_ID, "U-caller", parsed.data);

    expect(runTransaction).not.toHaveBeenCalled();
  });
});

/** A fake Admin Firestore for `listMenusForOutlet`. */
function fakeListDb(menuDocs: Array<Menu | Record<string, unknown>>) {
  const orderBy2 = vi.fn(() => ({
    get: async () => ({
      docs: menuDocs.map((data) => ({id: data.id as string, data: () => data})),
    }),
  }));
  const orderBy1 = vi.fn(() => ({orderBy: orderBy2}));
  const db = {
    collection: () => ({doc: () => ({collection: () => ({doc: () => ({collection: () => ({orderBy: orderBy1})})})})}),
  };
  return {db: db as unknown as Firestore, orderBy1, orderBy2};
}

describe("listMenusForOutlet", () => {
  it("returns [] for an outlet with no menus", async () => {
    const {db} = fakeListDb([]);
    expect(await listMenusForOutlet(db, ORG_ID, OUTLET_ID)).toEqual([]);
  });

  it("orders by menuDate then createdAt ascending (delegated to the query, asserted here)", async () => {
    const {db, orderBy1, orderBy2} = fakeListDb([
      validMenuDoc("menu-a"),
      validMenuDoc("menu-b"),
    ]);

    const result = await listMenusForOutlet(db, ORG_ID, OUTLET_ID);

    expect(orderBy1).toHaveBeenCalledWith("menuDate", "asc");
    expect(orderBy2).toHaveBeenCalledWith("createdAt", "asc");
    expect(result.map((m) => m.id)).toEqual(["menu-a", "menu-b"]);
  });

  it("includes every lifecycle state rather than filtering any out", async () => {
    const {db} = fakeListDb([
      validMenuDoc("menu-a", {status: "draft"}),
      validMenuDoc("menu-b", {status: "published"}),
      validMenuDoc("menu-c", {status: "archived"}),
    ]);

    const result = await listMenusForOutlet(db, ORG_ID, OUTLET_ID);

    expect(result.map((m) => m.status)).toEqual(["draft", "published", "archived"]);
  });

  it("throws when a stored menu document is malformed", async () => {
    const {db} = fakeListDb([{id: "menu-a", title: "Incomplete"}]);
    await expect(listMenusForOutlet(db, ORG_ID, OUTLET_ID)).rejects.toThrow();
  });

  it("throws when a stored menu's outletId does not match the path it was read from", async () => {
    const {db} = fakeListDb([validMenuDoc("menu-a", {outletId: "outlet-other"})]);
    await expect(listMenusForOutlet(db, ORG_ID, OUTLET_ID)).rejects.toThrow();
  });
});

/** A fake Admin Firestore for `getMenu`. */
function fakeGetDb(existing: Menu | Record<string, unknown> | undefined) {
  const db = {
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
  };
  return {db: db as unknown as Firestore};
}

describe("getMenu", () => {
  it("returns the menu when it exists", async () => {
    const {db} = fakeGetDb(validMenuDoc("menu-1"));
    const menu = await getMenu(db, ORG_ID, OUTLET_ID, "menu-1");
    expect(menu.id).toBe("menu-1");
  });

  it("throws not-found for a nonexistent menu", async () => {
    const {db} = fakeGetDb(undefined);
    await expect(getMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "not-found"});
  });

  it.each(["", "a/b", ".", "..", "__reserved__"])(
    "rejects a malformed menu ID (%j) with invalid-argument, before touching Firestore",
    async (menuId) => {
      const {db} = fakeGetDb(validMenuDoc("menu-1"));
      await expect(getMenu(db, ORG_ID, OUTLET_ID, menuId))
        .rejects.toMatchObject({code: "invalid-argument"});
    },
  );
});

/** A fake Admin Firestore for `updateMenu`/`publishMenu`/`archiveMenu`. */
function fakeMutateDb(existing: Menu | Record<string, unknown> | undefined) {
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
              doc: () => ({/* opaque ref token, only ever passed to tx.get/tx.update below */}),
            }),
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {db: db as unknown as Firestore, updates};
}

describe("updateMenu", () => {
  it("updates only the provided fields and bumps updatedAt", async () => {
    const existing = validMenuDoc("menu-1");
    const {db, updates} = fakeMutateDb(existing);

    const result = await updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {title: "New Title"} as UpdateMenuInput);

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({title: "New Title"});
    expect(updates[0].data).not.toHaveProperty("menuDate");
    expect(result.title).toBe("New Title");
    expect(result.updatedAt.toMillis()).toBeGreaterThanOrEqual(existing.updatedAt.toMillis());
  });

  it("throws not-found for a nonexistent menu", async () => {
    const {db} = fakeMutateDb(undefined);
    await expect(updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {title: "New Title"} as UpdateMenuInput))
      .rejects.toMatchObject({code: "not-found"});
  });

  it.each(["", "a/b", ".", "..", "__reserved__"])(
    "rejects a malformed menu ID (%j) with invalid-argument, before touching Firestore",
    async (menuId) => {
      const {db} = fakeMutateDb(validMenuDoc("menu-1"));
      await expect(updateMenu(db, ORG_ID, OUTLET_ID, menuId, {title: "New Title"} as UpdateMenuInput))
        .rejects.toMatchObject({code: "invalid-argument"});
    },
  );

  it("rejects any edit to an archived menu", async () => {
    const existing = validMenuDoc("menu-1", {status: "archived"});
    const {db} = fakeMutateDb(existing);

    await expect(updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {title: "New Title"} as UpdateMenuInput))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("allows a title/description edit after ordering has closed", async () => {
    const existing = validMenuDoc("menu-1", {
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T11:00:00Z")), // before FIXED_NOW
    });
    const {db, updates} = fakeMutateDb(existing);

    const result = await updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {description: "Updated"} as UpdateMenuInput);

    expect(result.description).toBe("Updated");
    expect(updates).toHaveLength(1);
  });

  it("rejects a schedule-field edit once ordering has closed", async () => {
    const existing = validMenuDoc("menu-1", {
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T11:00:00Z")), // before FIXED_NOW
    });
    const {db} = fakeMutateDb(existing);

    await expect(updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {
      pickupEndsAt: "2026-09-28T11:00:00Z",
    } as unknown as UpdateMenuInput)).rejects.toMatchObject({code: "failed-precondition"});
  });

  it("allows a schedule-field edit while ordering is still open", async () => {
    const existing = validMenuDoc("menu-1", {
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T13:00:00Z")), // after FIXED_NOW
    });
    const {db, updates} = fakeMutateDb(existing);

    await updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {
      pickupEndsAt: Timestamp.fromDate(new Date("2026-09-28T12:00:00Z")),
    } as unknown as UpdateMenuInput);

    expect(updates).toHaveLength(1);
  });

  it("rejects a patch that would break the merged schedule's relational rules, even touching only one field", async () => {
    // existing.orderingClosesAt is 2026-09-27T10:00:00Z; patching only
    // orderingOpensAt to something after it must be rejected, even though
    // orderingClosesAt itself is untouched by this specific request.
    const existing = validMenuDoc("menu-1");
    const {db} = fakeMutateDb(existing);

    await expect(updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T11:00:00Z")),
    } as unknown as UpdateMenuInput)).rejects.toMatchObject({code: "failed-precondition"});
  });

  it("rejects changing menuDate to a date before today", async () => {
    const existing = validMenuDoc("menu-1");
    const {db} = fakeMutateDb(existing);

    await expect(updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {
      menuDate: "2026-09-01",
    } as unknown as UpdateMenuInput)).rejects.toMatchObject({code: "failed-precondition"});
  });

  it("does not re-check menuDate's pastness when menuDate is not part of the patch", async () => {
    // existing.menuDate is already "2026-09-28"; patching only the title
    // must never fail a past-date check that was never asked to run.
    const existing = validMenuDoc("menu-1");
    const {db} = fakeMutateDb(existing);

    const result = await updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {title: "New Title"} as UpdateMenuInput);

    expect(result.title).toBe("New Title");
  });

  it("ignores an attempt to change status/organizationId/outletId/createdBy/createdAt/publishedAt", async () => {
    const existing = validMenuDoc("menu-1");
    const {db, updates} = fakeMutateDb(existing);

    await updateMenu(db, ORG_ID, OUTLET_ID, "menu-1", {
      title: "New Title",
      status: "published",
      organizationId: "org-attacker",
      outletId: "outlet-attacker",
      createdBy: "U-attacker",
      createdAt: Timestamp.now(),
      publishedAt: Timestamp.now(),
    } as unknown as UpdateMenuInput);

    expect(updates[0].data).not.toHaveProperty("status");
    expect(updates[0].data).not.toHaveProperty("organizationId");
    expect(updates[0].data).not.toHaveProperty("outletId");
    expect(updates[0].data).not.toHaveProperty("createdBy");
    expect(updates[0].data).not.toHaveProperty("createdAt");
    expect(updates[0].data).not.toHaveProperty("publishedAt");
  });
});

describe("publishMenu", () => {
  it("publishes a draft menu, generating publishedAt", async () => {
    const existing = validMenuDoc("menu-1", {status: "draft"});
    const {db, updates} = fakeMutateDb(existing);

    const result = await publishMenu(db, ORG_ID, OUTLET_ID, "menu-1");

    expect(result.status).toBe("published");
    expect(result.publishedAt).toBeInstanceOf(Timestamp);
    expect(updates[0].data).toMatchObject({status: "published"});
    expect(updates[0].data).toHaveProperty("publishedAt");
  });

  it("throws not-found for a nonexistent menu", async () => {
    const {db} = fakeMutateDb(undefined);
    await expect(publishMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "not-found"});
  });

  it("rejects publishing an already-published menu", async () => {
    const existing = validMenuDoc("menu-1", {status: "published"});
    const {db} = fakeMutateDb(existing);

    await expect(publishMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("rejects publishing an archived menu", async () => {
    const existing = validMenuDoc("menu-1", {status: "archived"});
    const {db} = fakeMutateDb(existing);

    await expect(publishMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("rejects publishing a draft whose stored schedule is invalid (defense-in-depth)", async () => {
    // Seeded directly (bypassing the API's own validation), simulating a
    // stored document that should never occur via normal create/update.
    const existing = validMenuDoc("menu-1", {
      status: "draft",
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-27T10:00:00Z")),
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    });
    const {db, updates} = fakeMutateDb(existing);

    await expect(publishMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "failed-precondition"});
    expect(updates).toHaveLength(0);
  });

  it.each(["", "a/b", ".", "..", "__reserved__"])(
    "rejects a malformed menu ID (%j) with invalid-argument",
    async (menuId) => {
      const {db} = fakeMutateDb(validMenuDoc("menu-1"));
      await expect(publishMenu(db, ORG_ID, OUTLET_ID, menuId))
        .rejects.toMatchObject({code: "invalid-argument"});
    },
  );
});

describe("archiveMenu", () => {
  it("archives a published menu", async () => {
    const existing = validMenuDoc("menu-1", {status: "published"});
    const {db, updates} = fakeMutateDb(existing);

    const result = await archiveMenu(db, ORG_ID, OUTLET_ID, "menu-1");

    expect(result.status).toBe("archived");
    expect(updates[0].data).toMatchObject({status: "archived"});
  });

  it("bumps updatedAt", async () => {
    const existing = validMenuDoc("menu-1", {status: "published"});
    const {db} = fakeMutateDb(existing);

    const result = await archiveMenu(db, ORG_ID, OUTLET_ID, "menu-1");

    expect(result.updatedAt.toMillis()).toBeGreaterThanOrEqual(existing.updatedAt.toMillis());
  });

  it("throws not-found for a nonexistent menu", async () => {
    const {db} = fakeMutateDb(undefined);
    await expect(archiveMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "not-found"});
  });

  it("rejects archiving a draft menu", async () => {
    const existing = validMenuDoc("menu-1", {status: "draft"});
    const {db} = fakeMutateDb(existing);

    await expect(archiveMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("rejects archiving an already-archived menu", async () => {
    const existing = validMenuDoc("menu-1", {status: "archived"});
    const {db} = fakeMutateDb(existing);

    await expect(archiveMenu(db, ORG_ID, OUTLET_ID, "menu-1"))
      .rejects.toMatchObject({code: "failed-precondition"});
  });
});

describe("toMenuResponse", () => {
  it("renders every timestamp field as an ISO 8601 string, and menuDate as a plain string", () => {
    const menu = validMenuDoc("menu-1", {
      publishedAt: Timestamp.fromDate(new Date("2026-09-27T05:00:00Z")),
    });

    const response = toMenuResponse(menu);

    expect(response.menuDate).toBe("2026-09-28");
    expect(response.orderingOpensAt).toBe("2026-09-27T04:00:00.000Z");
    expect(response.publishedAt).toBe("2026-09-27T05:00:00.000Z");
  });

  it("omits publishedAt when not set", () => {
    const menu = validMenuDoc("menu-1");
    const response = toMenuResponse(menu);
    expect(response.publishedAt).toBeUndefined();
  });

  it("includes description when set", () => {
    const menu = validMenuDoc("menu-1", {description: "Freshly prepared."});
    expect(toMenuResponse(menu).description).toBe("Freshly prepared.");
  });
});

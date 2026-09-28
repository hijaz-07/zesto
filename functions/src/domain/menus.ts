import {
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {businessDateString} from "../time";
import {hasEnabledMenuItem} from "./menuItems";

/**
 * `organizations/{organizationId}/outlets/{outletId}/menus/{menuId}` — a
 * future planned service for a specific calendar date at an `Outlet` (see
 * docs/architecture/domain-model.md and docs/architecture/http-api.md#menus).
 * The document ID is a Firestore auto-ID. Zesto is demand-driven, not
 * inventory-driven: this document deliberately has no stock/inventory/
 * remaining-quantity fields, and menu items are a later step, not part of
 * this foundation.
 */
export type MenuStatus = "draft" | "published" | "archived";

export interface Menu {
  id: string;
  organizationId: string;
  outletId: string;
  menuDate: string;
  title: string;
  description?: string;
  status: MenuStatus;
  orderingOpensAt: Timestamp;
  orderingClosesAt: Timestamp;
  pickupStartsAt: Timestamp;
  pickupEndsAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
  publishedAt?: Timestamp;
}

/** The API response shape for a `Menu`: timestamp fields as ISO strings. */
export interface MenuResponse {
  id: string;
  organizationId: string;
  outletId: string;
  menuDate: string;
  title: string;
  description?: string;
  status: MenuStatus;
  orderingOpensAt: string;
  orderingClosesAt: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  publishedAt?: string;
}

const MENU_TITLE_MAX_LENGTH = 100;
const MENU_DESCRIPTION_MAX_LENGTH = 500;

const MENU_STATUS_VALUES = ["draft", "published", "archived"] as const;

/** The 5 fields whose relationship to each other forms the menu's schedule. */
interface MenuSchedule {
  menuDate: string;
  orderingOpensAt: Timestamp;
  orderingClosesAt: Timestamp;
  pickupStartsAt: Timestamp;
  pickupEndsAt: Timestamp;
}

/**
 * Checks the relational rules a menu's schedule must always satisfy,
 * regardless of whether it is being created or edited. Pure and exported so
 * it can be unit tested directly; reused by `createMenuBodySchema`'s
 * `superRefine` (the full schedule is always present together at create
 * time) and by `updateMenu`/`publishMenu` (against the merged/stored
 * schedule, since a PATCH may only touch some of these fields — see
 * docs/architecture/http-api.md#menus). Deliberately does NOT check whether
 * `menuDate` itself is in the past — that is a separate, narrower rule (see
 * `isMenuDateInPast`) that only applies when `menuDate` is actively being
 * set, not every time any schedule field is checked.
 *
 * @param {MenuSchedule} schedule The candidate schedule.
 * @return {string | null} The first violated rule's message, or `null` if
 *   the schedule is internally consistent.
 */
export function findScheduleViolation(schedule: MenuSchedule): string | null {
  if (
    schedule.orderingOpensAt.toMillis() >= schedule.orderingClosesAt.toMillis()
  ) {
    return "orderingOpensAt must be before orderingClosesAt.";
  }
  if (
    schedule.pickupStartsAt.toMillis() >= schedule.pickupEndsAt.toMillis()
  ) {
    return "pickupStartsAt must be before pickupEndsAt.";
  }
  if (
    schedule.orderingClosesAt.toMillis() > schedule.pickupStartsAt.toMillis()
  ) {
    return "orderingClosesAt must be at or before pickupStartsAt.";
  }
  // menuDate and businessDateString are both YYYY-MM-DD, so lexicographic
  // string comparison matches calendar order.
  if (businessDateString(schedule.pickupStartsAt.toDate()) < schedule.menuDate) {
    return "The pickup window cannot start before the menu's service date.";
  }
  return null;
}

/**
 * @param {string} menuDate A candidate `menuDate` (already known to be a
 *   well-formed calendar date — see `createMenuBodySchema`).
 * @param {Date} now The instant to compare against (defaults to now).
 * @return {boolean} Whether `menuDate` is before today in Zesto's business
 *   time zone (Asia/Kolkata). Today itself is not "in the past."
 */
function isMenuDateInPast(menuDate: string, now: Date = new Date()): boolean {
  return menuDate < businessDateString(now);
}

/**
 * Parses and transforms an ISO 8601 date-time string (optionally with a
 * numeric UTC offset, e.g. `+05:30`) into a Firestore `Timestamp`. Mirrors
 * the existing response convention of always emitting ISO strings
 * (`toDate().toISOString()`), just in the input direction.
 */
const isoTimestampSchema = z.iso.datetime({offset: true})
  .transform((value) => Timestamp.fromDate(new Date(value)));

/**
 * Validates a `POST /organizations/{organizationId}/outlets/{outletId}/menus`
 * request body.
 */
export const createMenuBodySchema = z.object({
  menuDate: z.iso.date(),
  title: z.string().trim().min(1).max(MENU_TITLE_MAX_LENGTH),
  description: z.string().trim().max(MENU_DESCRIPTION_MAX_LENGTH).optional(),
  orderingOpensAt: isoTimestampSchema,
  orderingClosesAt: isoTimestampSchema,
  pickupStartsAt: isoTimestampSchema,
  pickupEndsAt: isoTimestampSchema,
}).superRefine((value, ctx) => {
  // Zod still runs superRefine even when an individual field (e.g. one of
  // the 4 timestamps) already failed its own validation — in that case the
  // failing field's "parsed" value is just its original raw input (a
  // string, not a Timestamp), so the cross-field schedule check below must
  // be skipped rather than crash on a non-Timestamp value; that field's own
  // issue has already been reported.
  const hasWellFormedSchedule =
    value.orderingOpensAt instanceof Timestamp &&
    value.orderingClosesAt instanceof Timestamp &&
    value.pickupStartsAt instanceof Timestamp &&
    value.pickupEndsAt instanceof Timestamp;
  if (hasWellFormedSchedule) {
    const violation = findScheduleViolation(value);
    if (violation) {
      ctx.addIssue({code: "custom", message: violation});
    }
  }
  if (isMenuDateInPast(value.menuDate)) {
    ctx.addIssue({
      code: "custom",
      message: "menuDate cannot be before today.",
      path: ["menuDate"],
    });
  }
});

export type CreateMenuInput = z.infer<typeof createMenuBodySchema>;

/**
 * Validates a `PATCH .../menus/{menuId}` request body. `status`, `id`,
 * `organizationId`, `outletId`, `createdBy`, `createdAt`, and `publishedAt`
 * are deliberately not fields on this schema — status changes must be
 * explicit lifecycle operations (`publish`/`archive`), never an arbitrary
 * PATCH (see docs/architecture/http-api.md#menus) — so an unrecognized
 * field is stripped by `safeParse`, not rejected.
 *
 * Deliberately has NO cross-field `superRefine` (unlike the create schema):
 * a PATCH may supply only a subset of the schedule fields, so this schema
 * alone cannot know whether the result is internally consistent — that
 * requires the existing stored document too, and is checked by `updateMenu`
 * against the merged result instead.
 */
export const updateMenuBodySchema = z.object({
  menuDate: z.iso.date().optional(),
  title: z.string().trim().min(1).max(MENU_TITLE_MAX_LENGTH).optional(),
  description: z.string().trim().max(MENU_DESCRIPTION_MAX_LENGTH).optional(),
  orderingOpensAt: isoTimestampSchema.optional(),
  orderingClosesAt: isoTimestampSchema.optional(),
  pickupStartsAt: isoTimestampSchema.optional(),
  pickupEndsAt: isoTimestampSchema.optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided.",
);

export type UpdateMenuInput = z.infer<typeof updateMenuBodySchema>;

const menuDocSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  outletId: z.string().min(1),
  menuDate: z.iso.date(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(MENU_STATUS_VALUES),
  orderingOpensAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "orderingOpensAt must be a Firestore Timestamp",
  ),
  orderingClosesAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "orderingClosesAt must be a Firestore Timestamp",
  ),
  pickupStartsAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "pickupStartsAt must be a Firestore Timestamp",
  ),
  pickupEndsAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "pickupEndsAt must be a Firestore Timestamp",
  ),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
  updatedAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "updatedAt must be a Firestore Timestamp",
  ),
  createdBy: z.string().min(1),
  publishedAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "publishedAt must be a Firestore Timestamp",
  ).optional(),
});

/**
 * Parses a stored menu document, validating it was written in the expected
 * shape and that its `id`/`organizationId`/`outletId` fields match the path
 * it was read from. Deliberately validates SHAPE ONLY, never the schedule's
 * business rules (`findScheduleViolation`): `publishMenu` re-validates those
 * explicitly as its own defense-in-depth step, and GET/LIST must still be
 * able to display an existing menu even if its stored schedule were ever
 * invalid, rather than failing with a generic 500. Exported for
 * `domain/explore.ts`, which resolves menus from collection-group query
 * results rather than a known `organizationId`/`outletId` pair.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The document ID it was read from.
 * @param {string} expectedOrganizationId The organization ID it was read from.
 * @param {string} expectedOutletId The outlet ID it was read from.
 * @return {Menu} The parsed menu.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parseMenu(
  data: unknown,
  expectedId: string,
  expectedOrganizationId: string,
  expectedOutletId: string,
): Menu {
  const parsed = menuDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== expectedId ||
    parsed.data.organizationId !== expectedOrganizationId ||
    parsed.data.outletId !== expectedOutletId
  ) {
    throw new Error(
      "Malformed menu document at organizations/" +
      `${expectedOrganizationId}/outlets/${expectedOutletId}/menus/${expectedId}.`,
    );
  }
  return parsed.data;
}

/**
 * Builds an object containing only `fields`' defined entries. Duplicated
 * per-file, matching `domain/outlets.ts`'s identical helper: the Admin SDK
 * rejects an explicit `undefined` property value, so an optional field that
 * was not supplied must be omitted entirely from a Firestore write rather
 * than written as `undefined`.
 *
 * @param {T} fields Candidate fields, some possibly `undefined`.
 * @return {Partial<T>} `fields` with every `undefined` entry removed.
 */
function definedFields<T extends object>(fields: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * @param {Menu} menu A stored menu.
 * @return {MenuResponse} The API response shape for it.
 */
export function toMenuResponse(menu: Menu): MenuResponse {
  return {
    id: menu.id,
    organizationId: menu.organizationId,
    outletId: menu.outletId,
    menuDate: menu.menuDate,
    title: menu.title,
    description: menu.description,
    status: menu.status,
    orderingOpensAt: menu.orderingOpensAt.toDate().toISOString(),
    orderingClosesAt: menu.orderingClosesAt.toDate().toISOString(),
    pickupStartsAt: menu.pickupStartsAt.toDate().toISOString(),
    pickupEndsAt: menu.pickupEndsAt.toDate().toISOString(),
    createdAt: menu.createdAt.toDate().toISOString(),
    updatedAt: menu.updatedAt.toDate().toISOString(),
    createdBy: menu.createdBy,
    publishedAt: menu.publishedAt?.toDate().toISOString(),
  };
}

/**
 * Creates a new menu under `organizationId`/`outletId`. Unlike
 * `createOutlet`, this does not run inside a Firestore transaction: there is
 * no uniqueness constraint to protect (multiple menus may share a
 * `menuDate`), so a plain `.create()` is correct and avoids ceremony that
 * would mirror `createOutlet`'s shape without mirroring its reason. The
 * caller (`routes/menus.ts`) is responsible for having already confirmed the
 * outlet exists, belongs to `organizationId`, and is active.
 *
 * `status` always starts `"draft"` and is never taken from `input`;
 * `createdBy` always comes from the verified Descope session; `id`/
 * `organizationId`/`outletId`/`createdAt`/`updatedAt` all come from the
 * backend, never from the request body.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the menu belongs to
 *   (already authorized by the caller).
 * @param {string} outletId The outlet the menu belongs to (already verified
 *   active and belonging to `organizationId` by the caller).
 * @param {string} userId The verified caller's Descope user ID.
 * @param {CreateMenuInput} input The validated request body.
 * @return {Promise<Menu>} The created menu.
 */
export async function createMenu(
  db: Firestore,
  organizationId: string,
  outletId: string,
  userId: string,
  input: CreateMenuInput,
): Promise<Menu> {
  const menuRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc();

  const now = Timestamp.now();
  const menu: Menu = {
    id: menuRef.id,
    organizationId,
    outletId,
    menuDate: input.menuDate,
    title: input.title,
    status: "draft",
    orderingOpensAt: input.orderingOpensAt,
    orderingClosesAt: input.orderingClosesAt,
    pickupStartsAt: input.pickupStartsAt,
    pickupEndsAt: input.pickupEndsAt,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    ...definedFields({description: input.description}),
  };

  await menuRef.create(menu);
  return menu;
}

/**
 * Lists every menu belonging to `organizationId`/`outletId`, every lifecycle
 * state alike — this is an organization-management view, not a
 * customer-facing one. Ordered by `menuDate` ascending, then `createdAt`
 * ascending as a deterministic tie-breaker (multiple menus can share a
 * `menuDate`) — requires the composite index declared in
 * `firestore.indexes.json`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization to list menus for
 *   (already authorized by the caller).
 * @param {string} outletId The outlet to list menus for (already verified by
 *   the caller).
 * @return {Promise<MenuResponse[]>} The outlet's menus, ordered by
 *   `menuDate` then `createdAt` ascending; `[]` if it has none.
 * @throws {Error} If a stored menu document does not match the expected
 *   shape (surfaced by the caller as a generic 500).
 */
export async function listMenusForOutlet(
  db: Firestore,
  organizationId: string,
  outletId: string,
): Promise<MenuResponse[]> {
  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus")
    .orderBy("menuDate", "asc")
    .orderBy("createdAt", "asc")
    .get();

  return snapshot.docs.map((doc) =>
    toMenuResponse(parseMenu(doc.data(), doc.id, organizationId, outletId)));
}

/**
 * Reads a single menu, validating it belongs to `organizationId`/`outletId`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the menu must belong to
 *   (already authorized by the caller).
 * @param {string} outletId The outlet the menu must belong to (already
 *   verified by the caller).
 * @param {unknown} menuId The menu's document ID, from the request path.
 * @return {Promise<Menu>} The menu.
 * @throws {HttpsError} `invalid-argument` (400) if `menuId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such menu exists in this
 *   outlet.
 */
export async function getMenu(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: unknown,
): Promise<Menu> {
  if (!isValidDocumentId(menuId)) {
    throw new HttpsError("invalid-argument", "Invalid menu ID.");
  }

  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Menu not found.");
  }

  return parseMenu(snapshot.data(), menuId, organizationId, outletId);
}

/**
 * @param {UpdateMenuInput} input A validated PATCH body.
 * @return {boolean} Whether `input` touches any of the 5 fields that make up
 *   the menu's schedule.
 */
function touchesScheduleFields(input: UpdateMenuInput): boolean {
  return (
    input.menuDate !== undefined ||
    input.orderingOpensAt !== undefined ||
    input.orderingClosesAt !== undefined ||
    input.pickupStartsAt !== undefined ||
    input.pickupEndsAt !== undefined
  );
}

/**
 * Updates an existing menu's editable fields: `menuDate`, `title`,
 * `description`, `orderingOpensAt`, `orderingClosesAt`, `pickupStartsAt`,
 * `pickupEndsAt`. A field omitted from `input` is left unchanged. `id`,
 * `organizationId`, `outletId`, `status`, `createdBy`, `createdAt`, and
 * `publishedAt` can never be changed through this function. Reads and
 * writes the menu in one Firestore transaction, so a concurrent update
 * can't be lost between the existence check and the write, and so the
 * merged result can be validated before anything is written.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the menu must belong to
 *   (already authorized by the caller).
 * @param {string} outletId The outlet the menu must belong to (already
 *   verified active by the caller).
 * @param {unknown} menuId The menu's document ID, from the request path.
 * @param {UpdateMenuInput} input The validated request body.
 * @return {Promise<Menu>} The updated menu.
 * @throws {HttpsError} `invalid-argument` (400) if `menuId` is malformed.
 * @throws {HttpsError} `not-found` (404) if no such menu exists.
 * @throws {HttpsError} `failed-precondition` (400) if the menu is archived;
 *   if the patch touches a schedule field but ordering has already closed
 *   (`now >= orderingClosesAt`); if the merged schedule would violate
 *   `findScheduleViolation`; or if `menuDate` is being changed to a date
 *   before today.
 */
export async function updateMenu(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: unknown,
  input: UpdateMenuInput,
): Promise<Menu> {
  if (!isValidDocumentId(menuId)) {
    throw new HttpsError("invalid-argument", "Invalid menu ID.");
  }

  const menuRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(menuRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Menu not found.");
    }
    const existing = parseMenu(snapshot.data(), menuId, organizationId, outletId);

    if (existing.status === "archived") {
      throw new HttpsError(
        "failed-precondition",
        "Archived menus cannot be edited.",
      );
    }

    if (
      touchesScheduleFields(input) &&
      Timestamp.now().toMillis() >= existing.orderingClosesAt.toMillis()
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Ordering has closed; this menu's schedule can no longer be changed.",
      );
    }

    const updates = {
      updatedAt: Timestamp.now(),
      ...definedFields({
        menuDate: input.menuDate,
        title: input.title,
        description: input.description,
        orderingOpensAt: input.orderingOpensAt,
        orderingClosesAt: input.orderingClosesAt,
        pickupStartsAt: input.pickupStartsAt,
        pickupEndsAt: input.pickupEndsAt,
      }),
    };
    const merged = {...existing, ...updates};

    const violation = findScheduleViolation(merged);
    if (violation) {
      throw new HttpsError("failed-precondition", violation);
    }
    if (input.menuDate !== undefined && isMenuDateInPast(merged.menuDate)) {
      throw new HttpsError(
        "failed-precondition",
        "menuDate cannot be before today.",
      );
    }

    tx.update(menuRef, updates);

    return merged;
  });
}

/**
 * Publishes a draft menu: requires the menu is currently `"draft"`,
 * re-validates the stored schedule's business rules as a defense-in-depth
 * step (this can only fail if a stored document were ever written outside
 * the normal create/update path, since both already enforce
 * `findScheduleViolation`), and requires at least one of the menu's items
 * is currently enabled — read directly from Firestore's items subcollection
 * inside this same transaction (`hasEnabledMenuItem`), never trusted from a
 * request body or cached frontend state, and never satisfiable by a stale
 * answer (see that function's own doc comment for the concurrency
 * guarantee this relies on). Only then does it set `status: "published"`,
 * `publishedAt`, and bump `updatedAt` — all in one transaction, so a
 * publish can never partially succeed.
 *
 * KNOWN LIMITATION (by design, not a bug): "at least one enabled item"
 * is a publish-TIME gate, not an ongoing invariant of a published menu.
 * `findItemMutationViolation` (domain/menuItems.ts) still allows disabling
 * a published menu's last enabled item while ordering is open — nothing
 * here or elsewhere retroactively blocks that, since the demand a menu has
 * already collected up to that point remains valid regardless. A caller
 * must not assume every currently-published menu still has an enabled
 * item; this function only guarantees it was true at the moment publish
 * committed.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the menu must belong to.
 * @param {string} outletId The outlet the menu must belong to (already
 *   verified active by the caller).
 * @param {unknown} menuId The menu's document ID, from the request path.
 * @return {Promise<Menu>} The published menu.
 * @throws {HttpsError} `invalid-argument` (400) if `menuId` is malformed.
 * @throws {HttpsError} `not-found` (404) if no such menu exists.
 * @throws {HttpsError} `failed-precondition` (400) if the menu is not
 *   currently `"draft"`, its stored schedule is invalid, or it has no
 *   currently-enabled item.
 */
export async function publishMenu(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: unknown,
): Promise<Menu> {
  if (!isValidDocumentId(menuId)) {
    throw new HttpsError("invalid-argument", "Invalid menu ID.");
  }

  const menuRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(menuRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Menu not found.");
    }
    const existing = parseMenu(snapshot.data(), menuId, organizationId, outletId);

    if (existing.status !== "draft") {
      throw new HttpsError(
        "failed-precondition",
        "Only a draft menu can be published.",
      );
    }

    const violation = findScheduleViolation(existing);
    if (violation) {
      throw new HttpsError("failed-precondition", violation);
    }

    // Firestore transactions require every read before any write; this
    // read must therefore happen here, before tx.update below, not as a
    // separate pre-check outside the transaction — otherwise a concurrent
    // change to the menu's items between that pre-check and this write
    // could publish an effectively-empty menu.
    if (!(await hasEnabledMenuItem(db, organizationId, outletId, menuId, tx))) {
      throw new HttpsError(
        "failed-precondition",
        "A menu must have at least one enabled item before it can be published.",
      );
    }

    const updates = {
      status: "published" as const,
      publishedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
    tx.update(menuRef, updates);

    return {...existing, ...updates};
  });
}

/**
 * Archives a published menu: requires the menu is currently `"published"`,
 * then sets `status: "archived"` and bumps `updatedAt`, in one transaction.
 * Deliberately does NOT check the parent outlet's active status (unlike
 * create/update/publish) — archiving an existing published menu is allowed
 * even if its outlet has since become inactive, since archiving is a
 * cleanup/historical action, not a new commitment (see
 * docs/architecture/http-api.md#menus).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the menu must belong to.
 * @param {string} outletId The outlet the menu must belong to.
 * @param {unknown} menuId The menu's document ID, from the request path.
 * @return {Promise<Menu>} The archived menu.
 * @throws {HttpsError} `invalid-argument` (400) if `menuId` is malformed.
 * @throws {HttpsError} `not-found` (404) if no such menu exists.
 * @throws {HttpsError} `failed-precondition` (400) if the menu is not
 *   currently `"published"`.
 */
export async function archiveMenu(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: unknown,
): Promise<Menu> {
  if (!isValidDocumentId(menuId)) {
    throw new HttpsError("invalid-argument", "Invalid menu ID.");
  }

  const menuRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(menuRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Menu not found.");
    }
    const existing = parseMenu(snapshot.data(), menuId, organizationId, outletId);

    if (existing.status !== "published") {
      throw new HttpsError(
        "failed-precondition",
        "Only a published menu can be archived.",
      );
    }

    const updates = {
      status: "archived" as const,
      updatedAt: Timestamp.now(),
    };
    tx.update(menuRef, updates);

    return {...existing, ...updates};
  });
}

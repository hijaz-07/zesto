import {
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import type {Menu} from "./menus";

/**
 * `organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items/{itemId}`
 * — a single dish offered on a `Menu` (see docs/architecture/domain-model.md
 * and docs/architecture/http-api.md#menu-items). The document ID is a
 * Firestore auto-ID. Deliberately does NOT duplicate `organizationId`/
 * `outletId` on the document (unlike `Menu`, which duplicates both of its
 * ancestors): every request already re-resolves and re-validates the full
 * organization -> outlet -> menu chain before an item is ever touched (see
 * `routes/menuItems.ts`'s `requireOutlet`/`requireMenu`), so those fields
 * would be redundant path metadata rather than load-bearing data. Zesto is
 * demand-driven, not inventory-driven: this document deliberately has no
 * stock/inventory/remaining-quantity fields.
 */
export interface MenuItem {
  id: string;
  menuId: string;
  name: string;
  description?: string;
  priceInPaise: number;
  enabled: boolean;
  displayOrder: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
}

/** The API response shape for a `MenuItem`: timestamp fields as ISO strings. */
export interface MenuItemResponse {
  id: string;
  menuId: string;
  name: string;
  description?: string;
  priceInPaise: number;
  enabled: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

const ITEM_NAME_MAX_LENGTH = 100;
const ITEM_DESCRIPTION_MAX_LENGTH = 500;

/**
 * `priceInPaise`/`displayOrder` are both a non-negative integer, never
 * coerced from a string — matching `outlets.ts`'s `location` fields (the
 * only other plain-numeric input in this codebase), the established
 * convention is to require the caller send an actual JSON number. `.int()`
 * rejects a decimal (e.g. `12000.5`) as well as `NaN`/`Infinity`; `.min(0)`
 * rejects negative values. Money is always integer paise, never a
 * floating-point rupee amount (see root CLAUDE.md).
 */
const priceInPaiseSchema = z.number().int().min(0);
const displayOrderSchema = z.number().int().min(0);

/**
 * Validates a
 * `POST /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items`
 * request body.
 */
export const createMenuItemBodySchema = z.object({
  name: z.string().trim().min(1).max(ITEM_NAME_MAX_LENGTH),
  description: z.string().trim().max(ITEM_DESCRIPTION_MAX_LENGTH).optional(),
  priceInPaise: priceInPaiseSchema,
  displayOrder: displayOrderSchema,
});

export type CreateMenuItemInput = z.infer<typeof createMenuItemBodySchema>;

/**
 * Validates a `PATCH .../items/{itemId}` request body. `id`, `menuId`,
 * `createdBy`, and `createdAt` are deliberately not fields on this schema —
 * an unrecognized field is stripped by `safeParse`, not rejected, matching
 * `menus.ts`/`outlets.ts`'s convention.
 */
export const updateMenuItemBodySchema = z.object({
  name: z.string().trim().min(1).max(ITEM_NAME_MAX_LENGTH).optional(),
  description: z.string().trim().max(ITEM_DESCRIPTION_MAX_LENGTH).optional(),
  priceInPaise: priceInPaiseSchema.optional(),
  enabled: z.boolean().optional(),
  displayOrder: displayOrderSchema.optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided.",
);

export type UpdateMenuItemInput = z.infer<typeof updateMenuItemBodySchema>;

const menuItemDocSchema = z.object({
  id: z.string().min(1),
  menuId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  priceInPaise: priceInPaiseSchema,
  enabled: z.boolean(),
  displayOrder: displayOrderSchema,
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
  updatedAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "updatedAt must be a Firestore Timestamp",
  ),
  createdBy: z.string().min(1),
});

/**
 * Parses a stored menu item document, validating it was written in the
 * expected shape and that its `id`/`menuId` fields match the path it was
 * read from. Exported for `domain/explore.ts`, which reads a published
 * menu's enabled items for the public customer menu-detail endpoint.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The document ID it was read from.
 * @param {string} expectedMenuId The parent menu ID it was read from.
 * @return {MenuItem} The parsed menu item.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parseMenuItem(
  data: unknown,
  expectedId: string,
  expectedMenuId: string,
): MenuItem {
  const parsed = menuItemDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== expectedId ||
    parsed.data.menuId !== expectedMenuId
  ) {
    throw new Error(
      `Malformed menu item document at menus/${expectedMenuId}/items/${expectedId}.`,
    );
  }
  return parsed.data;
}

/**
 * Builds an object containing only `fields`' defined entries. Duplicated
 * per-file, matching `domain/menus.ts`/`domain/outlets.ts`'s identical
 * helper: the Admin SDK rejects an explicit `undefined` property value, so
 * an optional field that was not supplied must be omitted entirely from a
 * Firestore write rather than written as `undefined`.
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
 * @param {MenuItem} item A stored menu item.
 * @return {MenuItemResponse} The API response shape for it.
 */
export function toMenuItemResponse(item: MenuItem): MenuItemResponse {
  return {
    id: item.id,
    menuId: item.menuId,
    name: item.name,
    description: item.description,
    priceInPaise: item.priceInPaise,
    enabled: item.enabled,
    displayOrder: item.displayOrder,
    createdAt: item.createdAt.toDate().toISOString(),
    updatedAt: item.updatedAt.toDate().toISOString(),
    createdBy: item.createdBy,
  };
}

/**
 * Whether the parent menu's current lifecycle state and ordering window
 * allow a menu item to be created, updated, enabled/disabled, or reordered
 * right now. A draft menu always allows item mutations — its ordering
 * window (if any is even set yet) has no meaning until the menu is
 * published. A published menu allows item mutations only until ordering
 * closes, since after that the organization is expected to work from
 * finalized demand. An archived menu never allows item mutations. Reads are
 * never gated by this — historical menu/item data must always remain
 * readable (see `routes/menuItems.ts`).
 *
 * @param {Menu} menu The parent menu (already resolved and confirmed to
 *   belong to the request's organization/outlet by the caller).
 * @param {Date} now The instant to check against (defaults to now).
 * @return {string | null} Why item mutations are currently blocked, or
 *   `null` if they are allowed right now.
 */
export function findItemMutationViolation(
  menu: Menu,
  now: Date = new Date(),
): string | null {
  if (menu.status === "archived") {
    return "Items on an archived menu cannot be changed.";
  }
  if (
    menu.status === "published" &&
    now.getTime() >= menu.orderingClosesAt.toMillis()
  ) {
    return "Ordering has closed; this menu's items can no longer be changed.";
  }
  return null;
}

/**
 * Whether a menu item may be permanently deleted right now. Stricter than
 * `findItemMutationViolation`: deletion is only ever allowed while the
 * parent menu is still a draft, regardless of the ordering window — once a
 * menu is published, an item must be disabled (`enabled: false`) instead,
 * so historical menu/order data is never destroyed.
 *
 * @param {Menu} menu The parent menu.
 * @return {string | null} Why the item cannot be deleted, or `null` if
 *   deletion is currently allowed.
 */
export function findItemDeletionViolation(menu: Menu): string | null {
  if (menu.status !== "draft") {
    return "Only items on a draft menu can be deleted; disable the item instead.";
  }
  return null;
}

/**
 * Creates a new menu item under `menuId`. Unlike `createOutlet`, this does
 * not run inside a Firestore transaction: there is no uniqueness constraint
 * to protect (multiple items may share a `name`; see docs/architecture/http-api.md#menu-items),
 * so a plain `.create()` is correct. The caller (`routes/menuItems.ts`) is
 * responsible for having already confirmed the organization/outlet/menu
 * chain and that the parent menu currently accepts item mutations
 * (`findItemMutationViolation`).
 *
 * `enabled` always starts `true` and is never taken from `input`;
 * `createdBy` always comes from the verified Descope session; `id`/
 * `menuId`/`createdAt`/`updatedAt` all come from the backend, never from
 * the request body.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the item's menu belongs
 *   to (already authorized by the caller).
 * @param {string} outletId The outlet the item's menu belongs to (already
 *   verified by the caller).
 * @param {string} menuId The menu the item belongs to (already verified by
 *   the caller).
 * @param {string} userId The verified caller's Descope user ID.
 * @param {CreateMenuItemInput} input The validated request body.
 * @return {Promise<MenuItem>} The created menu item.
 */
export async function createMenuItem(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: string,
  userId: string,
  input: CreateMenuItemInput,
): Promise<MenuItem> {
  const itemRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("items").doc();

  const now = Timestamp.now();
  const item: MenuItem = {
    id: itemRef.id,
    menuId,
    name: input.name,
    priceInPaise: input.priceInPaise,
    enabled: true,
    displayOrder: input.displayOrder,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    ...definedFields({description: input.description}),
  };

  await itemRef.create(item);
  return item;
}

/**
 * Lists every item belonging to `menuId`, enabled and disabled alike — this
 * is an organization-management view, not a customer-facing one. Ordered by
 * `displayOrder` ascending, then `createdAt` ascending as a deterministic
 * tie-breaker (multiple items can share a `displayOrder`) — requires the
 * composite index declared in `firestore.indexes.json`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization to list items for
 *   (already authorized by the caller).
 * @param {string} outletId The outlet to list items for (already verified
 *   by the caller).
 * @param {string} menuId The menu to list items for (already verified by
 *   the caller).
 * @return {Promise<MenuItemResponse[]>} The menu's items, ordered by
 *   `displayOrder` then `createdAt` ascending; `[]` if it has none.
 * @throws {Error} If a stored item document does not match the expected
 *   shape (surfaced by the caller as a generic 500).
 */
export async function listMenuItemsForMenu(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: string,
): Promise<MenuItemResponse[]> {
  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("items")
    .orderBy("displayOrder", "asc")
    .orderBy("createdAt", "asc")
    .get();

  return snapshot.docs.map((doc) =>
    toMenuItemResponse(parseMenuItem(doc.data(), doc.id, menuId)));
}

/**
 * Whether at least one enabled item currently exists for `menuId`, read
 * directly from Firestore. Used by `domain/menus.ts`'s `publishMenu` to
 * enforce that a menu may only be published once it has at least one
 * enabled item — the ONLY reason `domain/menus.ts` depends on this module
 * at all. This is a one-directional runtime dependency, not a circular
 * one: this module's own reference to `Menu` (above) is a type-only
 * import, which `tsc` erases completely from the compiled output, so
 * `menus.js` importing `menuItems.js` creates no cycle in the actual
 * module graph. Deliberately a narrow existence query
 * (`.where("enabled", "==", true).limit(1)`), not `listMenuItemsForMenu`,
 * since the caller only needs a yes/no answer, not every item's full
 * parsed shape — this also needs no composite index, unlike the list
 * query, since Firestore auto-indexes single-field equality filters.
 *
 * @param {Firestore} db Admin Firestore instance (used only to build the
 *   query; the read itself goes through `tx`).
 * @param {string} organizationId The organization the menu belongs to
 *   (already authorized by the caller).
 * @param {string} outletId The outlet the menu belongs to (already
 *   verified by the caller).
 * @param {string} menuId The menu to check (already verified by the caller).
 * @param {Transaction} tx The in-progress transaction to read within, so
 *   this check participates in the same optimistic-concurrency guarantees
 *   as the rest of the caller's transaction (see `publishMenu`): if any
 *   item matching (or newly matching, or no longer matching) this query
 *   changes before that transaction commits, Firestore retries the whole
 *   transaction instead of letting it commit against a stale answer.
 * @return {Promise<boolean>} Whether at least one enabled item exists.
 */
export async function hasEnabledMenuItem(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: string,
  tx: Transaction,
): Promise<boolean> {
  const enabledItemsQuery = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("items")
    .where("enabled", "==", true)
    .limit(1);

  const snapshot = await tx.get(enabledItemsQuery);
  return !snapshot.empty;
}

/**
 * Reads a single menu item, validating it belongs to `menuId`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the item's menu must
 *   belong to (already authorized by the caller).
 * @param {string} outletId The outlet the item's menu must belong to
 *   (already verified by the caller).
 * @param {string} menuId The menu the item must belong to (already
 *   verified by the caller).
 * @param {unknown} itemId The item's document ID, from the request path.
 * @return {Promise<MenuItem>} The menu item.
 * @throws {HttpsError} `invalid-argument` (400) if `itemId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such item exists in this menu.
 */
export async function getMenuItem(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: string,
  itemId: unknown,
): Promise<MenuItem> {
  if (!isValidDocumentId(itemId)) {
    throw new HttpsError("invalid-argument", "Invalid item ID.");
  }

  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("items").doc(itemId)
    .get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Menu item not found.");
  }

  return parseMenuItem(snapshot.data(), itemId, menuId);
}

/**
 * Updates an existing menu item's editable fields: `name`, `description`,
 * `priceInPaise`, `enabled`, `displayOrder`. A field omitted from `input`
 * is left unchanged. `id`, `menuId`, `createdBy`, and `createdAt` can never
 * be changed through this function. Reads and writes the item in one
 * Firestore transaction, so a concurrent update can't be lost between the
 * existence check and the write. The caller (`routes/menuItems.ts`) is
 * responsible for having already confirmed the parent menu currently
 * accepts item mutations (`findItemMutationViolation`).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the item's menu must
 *   belong to (already authorized by the caller).
 * @param {string} outletId The outlet the item's menu must belong to
 *   (already verified active by the caller).
 * @param {string} menuId The menu the item must belong to (already
 *   verified by the caller).
 * @param {unknown} itemId The item's document ID, from the request path.
 * @param {UpdateMenuItemInput} input The validated request body.
 * @return {Promise<MenuItem>} The updated menu item.
 * @throws {HttpsError} `invalid-argument` (400) if `itemId` is malformed.
 * @throws {HttpsError} `not-found` (404) if no such item exists.
 */
export async function updateMenuItem(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: string,
  itemId: unknown,
  input: UpdateMenuItemInput,
): Promise<MenuItem> {
  if (!isValidDocumentId(itemId)) {
    throw new HttpsError("invalid-argument", "Invalid item ID.");
  }

  const itemRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("items").doc(itemId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(itemRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Menu item not found.");
    }
    const existing = parseMenuItem(snapshot.data(), itemId, menuId);

    const updates = {
      updatedAt: Timestamp.now(),
      ...definedFields({
        name: input.name,
        description: input.description,
        priceInPaise: input.priceInPaise,
        enabled: input.enabled,
        displayOrder: input.displayOrder,
      }),
    };
    tx.update(itemRef, updates);

    return {...existing, ...updates};
  });
}

/**
 * Permanently deletes a menu item. The caller (`routes/menuItems.ts`) is
 * responsible for having already confirmed the parent menu is currently a
 * draft (`findItemDeletionViolation`) — this function itself has no
 * awareness of the parent menu's lifecycle state, matching how `createMenuItem`/
 * `updateMenuItem` trust the caller's outlet/menu checks rather than
 * repeating them.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the item's menu must
 *   belong to (already authorized by the caller).
 * @param {string} outletId The outlet the item's menu must belong to
 *   (already verified active by the caller).
 * @param {string} menuId The menu the item must belong to (already
 *   verified draft by the caller).
 * @param {unknown} itemId The item's document ID, from the request path.
 * @throws {HttpsError} `invalid-argument` (400) if `itemId` is malformed.
 * @throws {HttpsError} `not-found` (404) if no such item exists.
 */
export async function deleteMenuItem(
  db: Firestore,
  organizationId: string,
  outletId: string,
  menuId: string,
  itemId: unknown,
): Promise<void> {
  if (!isValidDocumentId(itemId)) {
    throw new HttpsError("invalid-argument", "Invalid item ID.");
  }

  const itemRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("items").doc(itemId);

  const snapshot = await itemRef.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Menu item not found.");
  }

  await itemRef.delete();
}

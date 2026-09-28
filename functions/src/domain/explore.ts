import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {isValidDocumentId} from "../auth/membership";
import {businessDateString} from "../time";
import {parseMenuItem, type MenuItem} from "./menuItems";
import {parseMenu, type Menu} from "./menus";
import {parseOutlet, type Outlet} from "./outlets";

/**
 * Public, unauthenticated customer-discovery read APIs:
 * `GET /explore/outlets[/{outletId}[/menus/{menuId}]]` (see
 * `routes/explore.ts` and docs/architecture/http-api.md#explore). Every
 * function here reads with the Admin SDK exactly like the organization-
 * management domain modules, but returns only customer-safe fields — never
 * `createdBy`, `organizationId`, internal audit timestamps, or disabled/
 * draft/archived data — since these responses are served to anonymous
 * callers. Zesto v1 has no customer <-> organization affiliation and no
 * GPS discovery yet: "explore" is a read-only, unauthenticated menu/outlet
 * browse, not a location feature.
 */

/** Bounded candidate scan for the global explore feed's menu collection-group
 * query (`listExploreOutlets`). This is a v1 read path with no pagination:
 * if more than this many published, not-yet-closed future menus exist
 * platform-wide before enough distinct active outlets are found, an outlet
 * whose only qualifying menu sorts after this cutoff will not appear. See
 * docs/architecture/http-api.md#explore for the documented limitation. */
const EXPLORE_MENU_CANDIDATE_LIMIT = 200;

/** Bounded number of outlet summaries `listExploreOutlets` returns. */
const EXPLORE_OUTLET_RESULT_LIMIT = 50;

/** Bounded candidate scan for one outlet's upcoming menus (`listUpcomingPublishedMenusForOutlet`). */
const OUTLET_MENU_CANDIDATE_LIMIT = 50;

/** Whether ordering is open for a menu right now, derived from its schedule. */
export type OrderingState = "not_open" | "open" | "closed";

/** The customer-safe subset of an `Outlet`'s address. */
export interface PublicOutletAddress {
  city?: string;
  state?: string;
}

/** The customer-safe response shape for an `Outlet`. */
export interface PublicOutletSummary {
  id: string;
  name: string;
  description?: string;
  address?: PublicOutletAddress;
}

/** The customer-safe response shape for a `Menu`, without its items. */
export interface PublicMenuSummary {
  id: string;
  menuDate: string;
  title: string;
  description?: string;
  orderingOpensAt: string;
  orderingClosesAt: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  orderingState: OrderingState;
}

/** The customer-safe response shape for a `MenuItem`. Deliberately has no
 * `enabled` field — disabled items are filtered out before this is ever
 * built, so the field would be redundant (see `getCustomerMenuDetail`). */
export interface PublicMenuItem {
  id: string;
  name: string;
  description?: string;
  priceInPaise: number;
  displayOrder: number;
}

/** One row of `GET /explore/outlets`: a customer-visible outlet plus the
 * earliest upcoming menu that made it eligible. */
export interface ExploreOutletsEntry {
  outlet: PublicOutletSummary;
  nextMenu: PublicMenuSummary;
}

/** The response shape for one entry of `GET /explore/outlets`: the outlet's
 * own fields, flattened, plus a nested `nextMenu`. */
export interface ExploreOutletsEntryResponse extends PublicOutletSummary {
  nextMenu: PublicMenuSummary;
}

/** The response shape for `GET /explore/outlets/{outletId}`. */
export interface OutletExplorePageResponse {
  outlet: PublicOutletSummary;
  menus: PublicMenuSummary[];
}

/** The response shape for `GET /explore/outlets/{outletId}/menus/{menuId}`. */
export interface CustomerMenuDetailResponse {
  outlet: PublicOutletSummary;
  menu: PublicMenuSummary & {items: PublicMenuItem[]};
}

/**
 * Builds an object containing only `fields`' defined entries. Duplicated
 * per-file, matching every other domain module's identical helper (see
 * `domain/outlets.ts`/`domain/menus.ts`/`domain/menuItems.ts`): an optional
 * response field must be omitted entirely when absent, never emitted as
 * `undefined`.
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
 * @param {Outlet["address"]} address A stored outlet's full address.
 * @return {PublicOutletAddress | undefined} Only the customer-safe `city`/
 *   `state`, or `undefined` if neither is present — never `line1`, `line2`,
 *   or `postalCode`.
 */
function toPublicAddress(
  address: Outlet["address"],
): PublicOutletAddress | undefined {
  if (!address) {
    return undefined;
  }
  const result = definedFields({city: address.city, state: address.state});
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * @param {Outlet} outlet A stored, already-confirmed-active outlet.
 * @return {PublicOutletSummary} The customer-safe response shape for it —
 *   never `organizationId`, `slug`, `status`, `phone`, `location`,
 *   `createdBy`, `createdAt`, or `updatedAt`.
 */
export function toPublicOutletSummary(outlet: Outlet): PublicOutletSummary {
  return {
    id: outlet.id,
    name: outlet.name,
    ...definedFields({
      description: outlet.description,
      address: toPublicAddress(outlet.address),
    }),
  };
}

/**
 * Derives whether ordering is currently open for a menu, purely from its
 * own `orderingOpensAt`/`orderingClosesAt` schedule — never persisted (see
 * root CLAUDE.md). Boundary semantics match the existing convention in
 * `domain/menuItems.ts`'s `findItemMutationViolation`: closed is `now >=
 * orderingClosesAt` (inclusive), so the instant ordering closes it is
 * already `"closed"`, not `"open"`.
 *
 * @param {Pick<Menu, "orderingOpensAt" | "orderingClosesAt">} menu The menu
 *   (or any object with its schedule fields).
 * @param {Date} now The instant to evaluate against (defaults to now).
 * @return {OrderingState} `"not_open"` before `orderingOpensAt`, `"closed"`
 *   at or after `orderingClosesAt`, `"open"` in between.
 */
export function computeOrderingState(
  menu: Pick<Menu, "orderingOpensAt" | "orderingClosesAt">,
  now: Date = new Date(),
): OrderingState {
  const nowMillis = now.getTime();
  if (nowMillis < menu.orderingOpensAt.toMillis()) {
    return "not_open";
  }
  if (nowMillis >= menu.orderingClosesAt.toMillis()) {
    return "closed";
  }
  return "open";
}

/**
 * @param {Menu} menu A stored, already-confirmed-published menu.
 * @param {Date} now The instant to derive `orderingState` against.
 * @return {PublicMenuSummary} The customer-safe response shape for it —
 *   never `organizationId`, `outletId`, `status`, `createdBy`, `createdAt`,
 *   `updatedAt`, or `publishedAt`.
 */
function toPublicMenuSummary(menu: Menu, now: Date): PublicMenuSummary {
  return {
    id: menu.id,
    menuDate: menu.menuDate,
    title: menu.title,
    ...definedFields({description: menu.description}),
    orderingOpensAt: menu.orderingOpensAt.toDate().toISOString(),
    orderingClosesAt: menu.orderingClosesAt.toDate().toISOString(),
    pickupStartsAt: menu.pickupStartsAt.toDate().toISOString(),
    pickupEndsAt: menu.pickupEndsAt.toDate().toISOString(),
    orderingState: computeOrderingState(menu, now),
  };
}

/**
 * @param {MenuItem} item A stored, already-confirmed-enabled menu item.
 * @return {PublicMenuItem} The customer-safe response shape for it — never
 *   `menuId`, `enabled`, `createdBy`, `createdAt`, or `updatedAt`.
 */
function toPublicMenuItem(item: MenuItem): PublicMenuItem {
  return {
    id: item.id,
    name: item.name,
    ...definedFields({description: item.description}),
    priceInPaise: item.priceInPaise,
    displayOrder: item.displayOrder,
  };
}

/**
 * @param {ExploreOutletsEntry} entry One outlet/next-menu pair.
 * @return {ExploreOutletsEntryResponse} The flattened response shape
 *   `GET /explore/outlets` returns one of, per docs/architecture/http-api.md#explore.
 */
export function toExploreOutletsEntryResponse(
  entry: ExploreOutletsEntry,
): ExploreOutletsEntryResponse {
  return {...entry.outlet, nextMenu: entry.nextMenu};
}

/**
 * @param {Menu} menu A stored, already-confirmed-published menu.
 * @param {MenuItem[]} items Its already-confirmed-enabled items.
 * @param {Date} now The instant to derive `orderingState` against.
 * @return {PublicMenuSummary & {items: PublicMenuItem[]}} The `menu` field
 *   of `GET /explore/outlets/{outletId}/menus/{menuId}`'s response.
 */
export function toCustomerMenuResponse(
  menu: Menu,
  items: MenuItem[],
  now: Date = new Date(),
): PublicMenuSummary & {items: PublicMenuItem[]} {
  return {
    ...toPublicMenuSummary(menu, now),
    items: items.map(toPublicMenuItem),
  };
}

/**
 * Resolves an outlet by its document ID alone (the route parameter carries
 * no `organizationId`), confirming it is customer-visible
 * (`status === "active"`). Since outlet IDs are Firestore auto-IDs —
 * effectively globally unique — a collection-group lookup by the outlet's
 * own `id` field should return at most one match; if it were ever to match
 * more than one (which should never happen), there is no safe way to pick
 * a winner, so this fails closed exactly like "not found" rather than
 * guessing and risking a cross-tenant leak.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {unknown} outletId The outlet's document ID, from the request path.
 * @return {Promise<Outlet>} The resolved, active outlet.
 * @throws {HttpsError} `not-found` (404) if `outletId` is malformed, no such
 *   outlet exists, it is ambiguous, or it is not currently active — the same
 *   secure-not-found behavior used throughout this codebase, so an anonymous
 *   caller can never distinguish "doesn't exist" from "exists but isn't
 *   visible to you."
 */
export async function resolveActivePublicOutlet(
  db: Firestore,
  outletId: unknown,
): Promise<Outlet> {
  if (!isValidDocumentId(outletId)) {
    throw new HttpsError("not-found", "Outlet not found.");
  }

  const snapshot = await db
    .collectionGroup("outlets")
    .where("id", "==", outletId)
    .limit(2)
    .get();

  if (snapshot.size !== 1) {
    throw new HttpsError("not-found", "Outlet not found.");
  }

  const doc = snapshot.docs[0];
  const organizationRef = doc.ref.parent.parent;
  if (!organizationRef) {
    throw new Error(`Outlet document has no parent organization: ${doc.ref.path}.`);
  }
  const outlet = parseOutlet(doc.data(), doc.id, organizationRef.id);

  if (outlet.status !== "active") {
    throw new HttpsError("not-found", "Outlet not found.");
  }

  return outlet;
}

/**
 * The default customer discovery feed: every active outlet that has at
 * least one upcoming customer-visible published menu, each paired with its
 * earliest such menu. Implemented as a single bounded collection-group
 * query over every outlet's `menus` subcollection (requires the composite
 * index declared in `firestore.indexes.json`: `menus`, `COLLECTION_GROUP`
 * scope, `status` + `menuDate` + `createdAt`), followed by a batched
 * `db.getAll(...)` of the candidate menus' parent outlets — the same
 * "collection-group query, then `getAll` the resolved parents" shape as
 * `domain/organizations.ts`'s `listOrganizationsForUser`.
 *
 * This is a v1 read path with no pagination: only the first
 * `EXPLORE_MENU_CANDIDATE_LIMIT` published, not-yet-closed future menus
 * (platform-wide, ordered by `menuDate` then `createdAt`) are ever
 * considered, and at most `EXPLORE_OUTLET_RESULT_LIMIT` outlets are
 * returned. See docs/architecture/http-api.md#explore for the documented
 * scalability limitation.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Date} now The instant to evaluate "upcoming"/"not yet closed"
 *   against (defaults to now).
 * @param {{menuCandidateLimit?: number; outletResultLimit?: number}} limits
 *   Overrides for `EXPLORE_MENU_CANDIDATE_LIMIT`/`EXPLORE_OUTLET_RESULT_LIMIT`,
 *   for tests only — production code (`routes/explore.ts`) never passes this,
 *   so it always gets the real bounds.
 * @return {Promise<ExploreOutletsEntry[]>} Outlets ordered by their next
 *   qualifying menu's `menuDate` ascending, then that menu's `createdAt`
 *   ascending, then (only to break an otherwise-exact tie) the outlet's
 *   `name` then `id` ascending; `[]` if none qualify.
 * @throws {Error} If a candidate menu's parent outlet document is malformed,
 *   or a resolved outlet's own document is malformed (surfaced by the
 *   caller as a generic 500) — a missing (deleted) parent outlet is
 *   tolerated and simply skipped, since outlets are never hard-deleted in
 *   normal operation and a dangling reference here is not worth a 500 on a
 *   public read path.
 */
export async function listExploreOutlets(
  db: Firestore,
  now: Date = new Date(),
  limits: {menuCandidateLimit?: number; outletResultLimit?: number} = {},
): Promise<ExploreOutletsEntry[]> {
  const today = businessDateString(now);
  const menuCandidateLimit = limits.menuCandidateLimit ?? EXPLORE_MENU_CANDIDATE_LIMIT;
  const outletResultLimit = limits.outletResultLimit ?? EXPLORE_OUTLET_RESULT_LIMIT;

  const menuSnapshot = await db
    .collectionGroup("menus")
    .where("status", "==", "published")
    .where("menuDate", ">=", today)
    .orderBy("menuDate", "asc")
    .orderBy("createdAt", "asc")
    .limit(menuCandidateLimit)
    .get();

  if (menuSnapshot.empty) {
    return [];
  }

  const outletRefs = menuSnapshot.docs.map((doc) => {
    const outletRef = doc.ref.parent.parent;
    if (!outletRef) {
      throw new Error(`Menu document has no parent outlet: ${doc.ref.path}.`);
    }
    return outletRef;
  });
  const outletSnapshots = await db.getAll(...outletRefs);

  const seenOutletIds = new Set<string>();
  const candidates: Array<{outlet: Outlet; menu: Menu}> = [];

  for (let i = 0; i < menuSnapshot.docs.length; i++) {
    const outletSnapshot = outletSnapshots[i];
    if (!outletSnapshot.exists) {
      continue;
    }

    const organizationRef = outletSnapshot.ref.parent.parent;
    if (!organizationRef) {
      throw new Error(
        `Outlet document has no parent organization: ${outletSnapshot.ref.path}.`,
      );
    }
    const outlet = parseOutlet(outletSnapshot.data(), outletSnapshot.id, organizationRef.id);
    if (outlet.status !== "active" || seenOutletIds.has(outlet.id)) {
      continue;
    }

    const menuDoc = menuSnapshot.docs[i];
    const menu = parseMenu(menuDoc.data(), menuDoc.id, outlet.organizationId, outlet.id);
    if (computeOrderingState(menu, now) === "closed") {
      continue;
    }

    seenOutletIds.add(outlet.id);
    candidates.push({outlet, menu});

    if (candidates.length >= outletResultLimit) {
      break;
    }
  }

  candidates.sort((a, b) =>
    a.menu.menuDate.localeCompare(b.menu.menuDate) ||
    (a.menu.createdAt.toMillis() - b.menu.createdAt.toMillis()) ||
    a.menu.id.localeCompare(b.menu.id) ||
    a.outlet.name.localeCompare(b.outlet.name) ||
    a.outlet.id.localeCompare(b.outlet.id));

  return candidates.map(({outlet, menu}) => ({
    outlet: toPublicOutletSummary(outlet),
    nextMenu: toPublicMenuSummary(menu, now),
  }));
}

/**
 * Every customer-visible upcoming menu for one already-resolved active
 * outlet: published, `menuDate` not before today, and not yet
 * ordering-closed. Uses the same composite index as `listExploreOutlets`
 * (a `COLLECTION_GROUP`-scoped index also serves an equivalent
 * single-collection query on that collection ID).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Outlet} outlet The already-resolved, already-confirmed-active
 *   outlet (see `resolveActivePublicOutlet`).
 * @param {Date} now The instant to evaluate "upcoming"/"not yet closed"
 *   against (defaults to now).
 * @return {Promise<PublicMenuSummary[]>} The outlet's upcoming menus,
 *   ordered by `menuDate` then `createdAt` ascending; `[]` if none qualify.
 */
export async function listUpcomingPublishedMenusForOutlet(
  db: Firestore,
  outlet: Outlet,
  now: Date = new Date(),
): Promise<PublicMenuSummary[]> {
  const today = businessDateString(now);

  const snapshot = await db
    .collection("organizations").doc(outlet.organizationId)
    .collection("outlets").doc(outlet.id)
    .collection("menus")
    .where("status", "==", "published")
    .where("menuDate", ">=", today)
    .orderBy("menuDate", "asc")
    .orderBy("createdAt", "asc")
    .limit(OUTLET_MENU_CANDIDATE_LIMIT)
    .get();

  return snapshot.docs
    .map((doc) => parseMenu(doc.data(), doc.id, outlet.organizationId, outlet.id))
    .filter((menu) => computeOrderingState(menu, now) !== "closed")
    .map((menu) => toPublicMenuSummary(menu, now));
}

/** A published menu and its enabled items, for the customer menu-detail endpoint. */
export interface CustomerMenuDetail {
  menu: Menu;
  items: MenuItem[];
}

/**
 * Reads one customer-visible published menu (any ordering state — a known,
 * direct link to an already-closed published menu still resolves, read-only)
 * and its currently-enabled items, for an already-resolved active outlet.
 * A draft or archived menu is treated identically to a nonexistent one, and
 * a menu belonging to a different outlet can never be reached, since it is
 * always looked up strictly under `outlet`'s own path.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Outlet} outlet The already-resolved, already-confirmed-active
 *   outlet (see `resolveActivePublicOutlet`).
 * @param {unknown} menuId The menu's document ID, from the request path.
 * @return {Promise<CustomerMenuDetail>} The menu and its enabled items,
 *   ordered by `displayOrder` then `createdAt` ascending.
 * @throws {HttpsError} `not-found` (404) if `menuId` is malformed, does not
 *   exist under this outlet, or is not currently published.
 */
export async function getCustomerMenuDetail(
  db: Firestore,
  outlet: Outlet,
  menuId: unknown,
): Promise<CustomerMenuDetail> {
  if (!isValidDocumentId(menuId)) {
    throw new HttpsError("not-found", "Menu not found.");
  }

  const menuRef = db
    .collection("organizations").doc(outlet.organizationId)
    .collection("outlets").doc(outlet.id)
    .collection("menus").doc(menuId);

  const snapshot = await menuRef.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Menu not found.");
  }
  const menu = parseMenu(snapshot.data(), menuId, outlet.organizationId, outlet.id);
  if (menu.status !== "published") {
    throw new HttpsError("not-found", "Menu not found.");
  }

  const itemsSnapshot = await menuRef
    .collection("items")
    .where("enabled", "==", true)
    .orderBy("displayOrder", "asc")
    .orderBy("createdAt", "asc")
    .get();
  const items = itemsSnapshot.docs.map((doc) => parseMenuItem(doc.data(), doc.id, menuId));

  return {menu, items};
}

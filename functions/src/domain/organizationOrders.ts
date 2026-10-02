import {FieldPath, type Firestore, type Query} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {
  ORDER_HISTORY_DEFAULT_PAGE_SIZE,
  ORDER_HISTORY_MAX_PAGE_SIZE,
  decodeOrderHistoryCursor,
  encodeOrderHistoryCursor,
  listOrdersQuerySchema,
  loadOrderContext,
  parseOrderFromPath,
  type OrderHistoryCursor,
  type OrderSummaryItem,
} from "./orderHistory";
import type {Menu} from "./menus";
import type {Order, OrderCurrency, OrderPaymentStatus, OrderStatus} from "./orders";
import {getOutlet, type Outlet} from "./outlets";

/**
 * `GET /organizations/{organizationId}/orders` — the read-only order list for
 * an organization's own members (see `routes/organizationOrders.ts` and
 * docs/architecture/http-api.md#organization-orders). It is the
 * organization-side counterpart of `orderHistory.ts`'s customer history, and
 * deliberately shares that module's cursor and display-context helpers rather
 * than its authorization: here access is decided by an active membership in
 * `organizationId`, never by who placed the order.
 *
 * `organizationId` MUST be the organization of a membership the route has
 * already verified for the session's user (`requireOrganizationRole`) — never a
 * value used on the strength of the request alone.
 *
 * Scope is enforced by the query itself: it is always filtered to
 * `organizationId == <that organization>` (and, when an outlet filter was
 * asked for, `outletId == <an outlet verified to belong to it>`), so there is
 * no filter-after-the-fact step that could be skipped. Every returned
 * document's path is checked against the organization once more before it
 * leaves this module.
 *
 * Reads are bounded exactly like customer history: at most
 * `ORDER_HISTORY_MAX_PAGE_SIZE` orders a page (default
 * `ORDER_HISTORY_DEFAULT_PAGE_SIZE`), newest first, cursor-continued.
 *
 * Orders from an inactive outlet are listed like any other: an outlet being
 * retired never hides its history from the organization that served it.
 *
 * The two queries need the composite collection-group indexes declared in
 * `firestore.indexes.json` (`orders`: `organizationId` ASC, `createdAt` DESC;
 * and `organizationId` ASC, `outletId` ASC, `createdAt` DESC). The `__name__`
 * tie-break below is implicit in those indexes, in the same direction as their
 * last field.
 */

/** How many order lines a row spells out; the rest are only counted. */
export const ORGANIZATION_ORDER_MAX_ITEM_LINES = 10;

/**
 * Validates the query string. `limit`/`cursor` are the customer history's own
 * fields (so the same bounds apply); `outletId` is a requested filter only —
 * `listOrganizationOrders` verifies it belongs to the organization. A blank or
 * malformed `outletId` is rejected rather than treated as "no filter", so an
 * invalid filter can never silently widen what a caller sees. Any other
 * parameter — in particular an `organizationId` or `userId` — is not a field
 * here, so `safeParse` strips it: it is never read.
 */
export const listOrganizationOrdersQuerySchema = listOrdersQuerySchema.extend({
  outletId: z
    .string({error: "outletId must be a single outlet ID."})
    .refine((value) => isValidDocumentId(value), "Invalid outlet ID.")
    .optional(),
});

export type ListOrganizationOrdersQuery = z.infer<typeof listOrganizationOrdersQuerySchema>;

/**
 * One row of the organization's order list. Deliberately has no `userId`,
 * `organizationId`, per-line prices or ids, or payment/provider data: this
 * first dashboard is read-only and shows no customer identity. Item names and
 * quantities come from the order's own point-in-time snapshots, never from the
 * live menu; the outlet/menu names are display-only context read from the live
 * documents, and are omitted if either document no longer exists.
 */
export interface OrganizationOrderSummaryResponse {
  id: string;
  outletId: string;
  menuId: string;
  outlet?: {name: string};
  menu?: {title: string; menuDate: string};
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  currency: OrderCurrency;
  subtotalInPaise: number;
  totalInPaise: number;
  /** Total portions ordered (the sum of every line's quantity). */
  itemCount: number;
  /** The first `ORGANIZATION_ORDER_MAX_ITEM_LINES` lines, in the order they were placed. */
  items: OrderSummaryItem[];
  /** How many further lines exist beyond `items`. */
  moreItemLines: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationOrdersPageResponse {
  orders: OrganizationOrderSummaryResponse[];
  /** Pass back as `cursor` for the next page; `null` when this is the last. */
  nextCursor: string | null;
}

/**
 * @param {Order} order A stored order.
 * @param {Outlet | undefined} outlet Its outlet, if that document exists.
 * @param {Menu | undefined} menu Its menu, if that document exists.
 * @return {OrganizationOrderSummaryResponse} The organization-facing list
 *   shape for it.
 */
export function toOrganizationOrderSummary(
  order: Order,
  outlet: Outlet | undefined,
  menu: Menu | undefined,
): OrganizationOrderSummaryResponse {
  return {
    id: order.id,
    outletId: order.outletId,
    menuId: order.menuId,
    ...(outlet ? {outlet: {name: outlet.name}} : {}),
    ...(menu ? {menu: {title: menu.title, menuDate: menu.menuDate}} : {}),
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    subtotalInPaise: order.subtotalInPaise,
    totalInPaise: order.totalInPaise,
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    items: order.items
      .slice(0, ORGANIZATION_ORDER_MAX_ITEM_LINES)
      .map((item) => ({name: item.name, quantity: item.quantity})),
    moreItemLines: Math.max(0, order.items.length - ORGANIZATION_ORDER_MAX_ITEM_LINES),
    createdAt: order.createdAt.toDate().toISOString(),
    updatedAt: order.updatedAt.toDate().toISOString(),
  };
}

/**
 * A cursor is only a position in the caller's own newest-first listing, but it
 * names a document path, so it is held to the same scope as the listing: it
 * must point inside the current organization and, when an outlet filter is
 * active, inside that outlet. One that doesn't is a 400 — never quietly
 * accepted, and never a reason to widen the query. (Organization and outlet
 * ids contain no "/", so a trailing-slash prefix match is exact.)
 *
 * @param {OrderHistoryCursor} cursor The decoded cursor.
 * @param {string} organizationId The authorized organization.
 * @param {string | undefined} outletId The requested outlet filter, if any.
 * @throws {HttpsError} `invalid-argument` (400) if the cursor escapes the scope.
 */
function assertCursorInScope(
  cursor: OrderHistoryCursor,
  organizationId: string,
  outletId: string | undefined,
): void {
  const scopePrefix = outletId === undefined ?
    `organizations/${organizationId}/` :
    `organizations/${organizationId}/outlets/${outletId}/`;
  if (!cursor.path.startsWith(scopePrefix)) {
    throw new HttpsError("invalid-argument", "Invalid cursor.");
  }
}

/**
 * Lists one page of an organization's orders, newest first.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization of the caller's verified
 *   active membership (see this module's doc comment) — never a client value
 *   on its own.
 * @param {ListOrganizationOrdersQuery} query The validated query string.
 * @return {Promise<OrganizationOrdersPageResponse>} At most
 *   `ORDER_HISTORY_MAX_PAGE_SIZE` orders, and the cursor for the next page (or
 *   `null` if there is none).
 * @throws {HttpsError} `invalid-argument` (400) for a cursor this endpoint
 *   could not have issued for this scope; `not-found` (404) if `query.outletId`
 *   is not an outlet of this organization (a foreign outlet is
 *   indistinguishable from a nonexistent one).
 */
export async function listOrganizationOrders(
  db: Firestore,
  organizationId: string,
  query: ListOrganizationOrdersQuery,
): Promise<OrganizationOrdersPageResponse> {
  const pageSize = Math.min(query.limit ?? ORDER_HISTORY_DEFAULT_PAGE_SIZE, ORDER_HISTORY_MAX_PAGE_SIZE);

  // Everything that needs no Firestore read is checked first, so a bad cursor
  // is a cheap 400.
  const cursor = query.cursor === undefined ? undefined : decodeOrderHistoryCursor(query.cursor);
  if (cursor) {
    assertCursorInScope(cursor, organizationId, query.outletId);
  }

  // The outlet is read under THIS organization's path, so an outlet of any
  // other organization simply isn't found. It may be inactive: its history
  // stays listable.
  const outlet = query.outletId === undefined ? undefined : await getOutlet(db, organizationId, query.outletId);

  let ordersQuery: Query = db
    .collectionGroup("orders")
    .where("organizationId", "==", organizationId);
  if (outlet) {
    ordersQuery = ordersQuery.where("outletId", "==", outlet.id);
  }
  ordersQuery = ordersQuery
    .orderBy("createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (cursor) {
    ordersQuery = ordersQuery.startAfter(cursor.createdAt, db.doc(cursor.path));
  }

  // One extra document tells us whether another page exists, without a count.
  const snapshot = await ordersQuery.limit(pageSize + 1).get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  if (pageDocs.length === 0) {
    return {orders: [], nextCursor: null};
  }

  // Belt and braces: the query is already scoped, but a document that somehow
  // isn't this organization's (or this outlet's) must fail loudly rather than
  // be returned.
  const orders = pageDocs.map((doc) => {
    const order = parseOrderFromPath(doc);
    if (
      !doc.ref.path.startsWith(`organizations/${organizationId}/`) ||
      order.organizationId !== organizationId ||
      (outlet !== undefined && order.outletId !== outlet.id)
    ) {
      throw new Error("Organization order query returned an order outside its authorized scope.");
    }
    return order;
  });

  const {outlets, menus} = await loadOrderContext(db, orders);
  const lastDoc = pageDocs[pageDocs.length - 1];
  const hasMore = snapshot.docs.length > pageSize;

  return {
    orders: orders.map((order) =>
      toOrganizationOrderSummary(order, outlets.get(order.outletId), menus.get(order.menuId))),
    nextCursor: hasMore ? encodeOrderHistoryCursor(orders[orders.length - 1].createdAt, lastDoc.ref.path) : null,
  };
}

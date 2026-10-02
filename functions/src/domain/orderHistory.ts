import {
  FieldPath,
  Timestamp,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {parseMenu, type Menu} from "./menus";
import {
  parseOrder,
  type Order,
  type OrderCurrency,
  type OrderPaymentStatus,
  type OrderStatus,
} from "./orders";
import {parseOutlet, type Outlet} from "./outlets";

/**
 * `GET /orders` — the authenticated customer's own order history (see
 * `routes/orders.ts` and docs/architecture/http-api.md#customer-order-history).
 *
 * Ownership is enforced by the query itself: it is always filtered to
 * `userId == <the verified session's user>`, so a customer can never be handed
 * another customer's order — there is no filter-after-the-fact step that
 * could be skipped. `userId` is never a request input.
 *
 * Reads are bounded: a page is at most `ORDER_HISTORY_MAX_PAGE_SIZE` orders
 * regardless of what the caller asks for, and every page is a cursor
 * continuation of the same newest-first ordering, so there is no code path
 * that loads a customer's whole history at once.
 *
 * The query needs the composite collection-group index declared in
 * `firestore.indexes.json` (`orders`: `userId` ASC, `createdAt` DESC); the
 * `__name__` tie-break below is implicit in that index, in the same direction
 * as its last field.
 */

/** Page size when the caller does not ask for one. */
export const ORDER_HISTORY_DEFAULT_PAGE_SIZE = 20;

/** Hard server-side ceiling on a page, whatever `limit` the caller sends. */
export const ORDER_HISTORY_MAX_PAGE_SIZE = 50;

/** How many order lines a summary spells out; the rest are only counted. */
const ORDER_SUMMARY_MAX_ITEM_LINES = 3;

/** Generous upper bound on an encoded cursor; real ones are ~150 chars. */
const CURSOR_MAX_LENGTH = 1024;

/**
 * Validates `GET /orders`' query string. `limit` is validated for shape only
 * (a positive integer); the maximum is enforced by `listOwnedOrders` itself so
 * that no caller can bypass it. Any other query parameter — in particular a
 * `userId` — is not a field here, so `safeParse` strips it: it is never read.
 */
export const listOrdersQuerySchema = z.object({
  limit: z
    .string({error: "limit must be a single positive integer."})
    .regex(/^[1-9]\d{0,8}$/, "limit must be a positive integer.")
    .transform(Number)
    .optional(),
  cursor: z
    .string({error: "cursor must be a single string."})
    .min(1, "cursor must not be empty.")
    .max(CURSOR_MAX_LENGTH, "cursor is too long.")
    .optional(),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

/** One line of an order as shown in a list: no prices, those live on the order. */
export interface OrderSummaryItem {
  name: string;
  quantity: number;
}

/**
 * The customer-safe list shape of an `Order`. Deliberately has no `userId`,
 * `organizationId`, payment/provider data, or per-line prices and ids: the
 * detail endpoint (`GET /orders/{orderId}`) is where those live. Item names
 * and quantities come from the order's own point-in-time snapshots, never from
 * the live menu; the outlet/menu names are display-only context read from the
 * live documents, and are omitted if either document no longer exists.
 */
export interface OrderSummaryResponse {
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
  /** The first few lines, in the order they were placed. */
  items: OrderSummaryItem[];
  /** How many further lines exist beyond `items`. */
  moreItemLines: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrderHistoryPageResponse {
  orders: OrderSummaryResponse[];
  /** Pass back as `cursor` for the next page; `null` when this is the last. */
  nextCursor: string | null;
}

/**
 * @param {Order} order A stored order.
 * @param {Outlet | undefined} outlet Its outlet, if that document exists.
 * @param {Menu | undefined} menu Its menu, if that document exists.
 * @return {OrderSummaryResponse} The customer-safe list shape for it.
 */
export function toOrderSummaryResponse(
  order: Order,
  outlet: Outlet | undefined,
  menu: Menu | undefined,
): OrderSummaryResponse {
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
      .slice(0, ORDER_SUMMARY_MAX_ITEM_LINES)
      .map((item) => ({name: item.name, quantity: item.quantity})),
    moreItemLines: Math.max(0, order.items.length - ORDER_SUMMARY_MAX_ITEM_LINES),
    createdAt: order.createdAt.toDate().toISOString(),
    updatedAt: order.updatedAt.toDate().toISOString(),
  };
}

/**
 * ===========================================================================
 * Cursor
 * ===========================================================================
 *
 * An opaque position in the newest-first ordering: the last returned order's
 * `createdAt` (kept to the nanosecond, so equal-millisecond orders still sort
 * the same way they did on the previous page) and its document path (the
 * `__name__` tie-break; for a collection-group query the boundary must be a
 * full path, not a bare id).
 *
 * The cursor carries NO authority. It is only ever used as a boundary within a
 * query already filtered to the caller's own `userId`, so a forged or
 * borrowed cursor — even one built from another customer's order — can only
 * shift where in the caller's own history the page starts; it cannot widen
 * what the caller can see. It is still validated strictly, so garbage is a
 * clean 400 rather than a query error.
 */
const orderDocPathPattern = /^organizations\/[^/]+\/outlets\/[^/]+\/menus\/[^/]+\/orders\/[^/]+$/;

/** Firestore's maximum Timestamp second (9999-12-31T23:59:59Z). */
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

const cursorPayloadSchema = z.object({
  s: z.number().int().min(0).max(MAX_TIMESTAMP_SECONDS),
  n: z.number().int().min(0).max(999_999_999),
  p: z.string().max(CURSOR_MAX_LENGTH).refine(
    (path) => orderDocPathPattern.test(path) &&
      path.split("/").every((segment) => isValidDocumentId(segment)),
  ),
});

/** The decoded form of a cursor. */
export interface OrderHistoryCursor {
  createdAt: Timestamp;
  path: string;
}

/**
 * @param {Timestamp} createdAt The last returned order's `createdAt`.
 * @param {string} path The last returned order's document path.
 * @return {string} The opaque cursor for the page that follows it.
 */
export function encodeOrderHistoryCursor(createdAt: Timestamp, path: string): string {
  const payload = {s: createdAt.seconds, n: createdAt.nanoseconds, p: path};
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * @param {string} raw A cursor as the client sent it.
 * @return {OrderHistoryCursor} The decoded boundary.
 * @throws {HttpsError} `invalid-argument` (400) if `raw` is not a cursor this
 *   endpoint could have issued.
 */
export function decodeOrderHistoryCursor(raw: string): OrderHistoryCursor {
  const invalid = new HttpsError("invalid-argument", "Invalid cursor.");
  // `Buffer.from(..., "base64url")` silently skips characters it doesn't
  // understand, so check the alphabet first rather than accept near-misses.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalid;
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }

  const parsed = cursorPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw invalid;
  }
  return {
    createdAt: new Timestamp(parsed.data.s, parsed.data.n),
    path: parsed.data.p,
  };
}

/**
 * Parses an order document read through a collection-group query, deriving
 * the `organizationId`/`outletId`/`menuId` it must match from its own path.
 *
 * @param {QueryDocumentSnapshot} doc One order document.
 * @return {Order} The parsed order.
 * @throws {Error} If the document has no parent chain, or is malformed.
 */
export function parseOrderFromPath(doc: QueryDocumentSnapshot): Order {
  const menuRef = doc.ref.parent.parent;
  const outletRef = menuRef?.parent.parent;
  const organizationRef = outletRef?.parent.parent;
  if (!menuRef || !outletRef || !organizationRef) {
    throw new Error(`Order document is not nested under a menu/outlet/organization: ${doc.ref.path}.`);
  }
  return parseOrder(doc.data(), doc.id, organizationRef.id, outletRef.id, menuRef.id);
}

/**
 * Reads the outlet and menu documents the given orders belong to — one read
 * per distinct outlet/menu, however many orders share it — for display names
 * only. A document that no longer exists is simply absent from the result
 * (history must survive an outlet/menu going away); one that exists but is
 * malformed throws, like every other read in this codebase.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Order[]} orders The page's orders (must be non-empty).
 * @return {Promise<{outlets: Map<string, Outlet>, menus: Map<string, Menu>}>}
 *   Outlets keyed by outlet id, menus keyed by menu id (both globally unique
 *   auto-ids).
 */
export async function loadOrderContext(
  db: Firestore,
  orders: Order[],
): Promise<{outlets: Map<string, Outlet>; menus: Map<string, Menu>}> {
  const outletRefs = new Map<string, DocumentReference>();
  const menuRefs = new Map<string, DocumentReference>();
  for (const order of orders) {
    const outletRef = db
      .collection("organizations").doc(order.organizationId)
      .collection("outlets").doc(order.outletId);
    outletRefs.set(order.outletId, outletRef);
    menuRefs.set(order.menuId, outletRef.collection("menus").doc(order.menuId));
  }

  const [outletSnapshots, menuSnapshots] = await Promise.all([
    db.getAll(...outletRefs.values()),
    db.getAll(...menuRefs.values()),
  ]);

  const outlets = new Map<string, Outlet>();
  for (const snapshot of outletSnapshots) {
    const organizationId = snapshot.ref.parent.parent?.id;
    if (snapshot.exists && organizationId) {
      outlets.set(snapshot.id, parseOutlet(snapshot.data(), snapshot.id, organizationId));
    }
  }

  const menus = new Map<string, Menu>();
  for (const snapshot of menuSnapshots) {
    const outletId = snapshot.ref.parent.parent?.id;
    const organizationId = snapshot.ref.parent.parent?.parent.parent?.id;
    if (snapshot.exists && outletId && organizationId) {
      menus.set(snapshot.id, parseMenu(snapshot.data(), snapshot.id, organizationId, outletId));
    }
  }
  return {outlets, menus};
}

/**
 * Lists one page of the caller's own orders, newest first.
 *
 * `userId` MUST be the verified Descope session's own user id (see
 * `routes/orders.ts`) — never a client-supplied value.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @param {ListOrdersQuery} query The validated query string.
 * @return {Promise<OrderHistoryPageResponse>} At most
 *   `ORDER_HISTORY_MAX_PAGE_SIZE` orders, and the cursor for the next page
 *   (or `null` if there is none).
 * @throws {HttpsError} `invalid-argument` (400) if `query.cursor` is not a
 *   cursor this endpoint could have issued.
 */
export async function listOwnedOrders(
  db: Firestore,
  userId: string,
  query: ListOrdersQuery,
): Promise<OrderHistoryPageResponse> {
  const pageSize = Math.min(query.limit ?? ORDER_HISTORY_DEFAULT_PAGE_SIZE, ORDER_HISTORY_MAX_PAGE_SIZE);

  // Decoded before Firestore is touched at all, so a bad cursor is a cheap 400.
  const cursor = query.cursor === undefined ? undefined : decodeOrderHistoryCursor(query.cursor);

  let ordersQuery = db
    .collectionGroup("orders")
    .where("userId", "==", userId)
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

  const orders = pageDocs.map(parseOrderFromPath);
  // Belt and braces: the query is already filtered to `userId`, but a result
  // that somehow isn't the caller's must fail loudly rather than be returned.
  if (orders.some((order) => order.userId !== userId)) {
    throw new Error("Order history query returned an order owned by a different user.");
  }

  const {outlets, menus} = await loadOrderContext(db, orders);
  const lastDoc = pageDocs[pageDocs.length - 1];
  const hasMore = snapshot.docs.length > pageSize;

  return {
    orders: orders.map((order) =>
      toOrderSummaryResponse(order, outlets.get(order.outletId), menus.get(order.menuId))),
    nextCursor: hasMore ? encodeOrderHistoryCursor(orders[orders.length - 1].createdAt, lastDoc.ref.path) : null,
  };
}

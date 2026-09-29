import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {computeOrderingState} from "./explore";
import {parseMenu, type Menu} from "./menus";
import {parseMenuItem} from "./menuItems";
import {parseOutlet, type Outlet} from "./outlets";

/**
 * `organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/orders/{orderId}`
 * — a customer's pre-order for a single published menu (see root CLAUDE.md's
 * "Demand-driven ordering" and "Menu lifecycle"). The document ID is a
 * Firestore auto-ID. An order belongs to exactly one customer, organization,
 * outlet, and menu — it can never span multiple outlets or menus, since it
 * is always created nested under one specific menu's path.
 *
 * Zesto is demand-driven, not inventory-driven: this document deliberately
 * has no stock/inventory/remaining-quantity fields, and creating an order
 * never writes to the menu or its items (see `createOrder`).
 *
 * `items` are point-in-time snapshots (`OrderItemSnapshot`), not references —
 * once an order is created, changing the source menu item's name, price, or
 * enabled state must never change the order (see root CLAUDE.md's "Menu
 * editing"). All money is integer paise; `totalInPaise` equals
 * `subtotalInPaise` for v1 — there is no tax/fee/discount system yet.
 */
export type OrderStatus = "pending_payment" | "confirmed" | "cancelled";
const ORDER_STATUS_VALUES = ["pending_payment", "confirmed", "cancelled"] as const;

/**
 * `createOrder` always writes `"pending"`. `"paid"` is set exactly once, by
 * `domain/payments.ts`'s `markPaymentSucceeded`, atomically with that same
 * order's `status` becoming `"confirmed"` — see that module's doc comment
 * for the full payment state machine. There is no client-reachable way to
 * set `"paid"` directly (see root CLAUDE.md's "Never trust the frontend for
 * security").
 */
export type OrderPaymentStatus = "pending" | "paid";
const ORDER_PAYMENT_STATUS_VALUES = ["pending", "paid"] as const;

/** v1 supports exactly one currency; see `Order`'s doc comment. */
export type OrderCurrency = "INR";

/**
 * One line of an order: a snapshot of the menu item at order-creation time,
 * not a live reference. `lineTotalInPaise` is always
 * `priceInPaise * quantity`, computed once and stored — never recomputed
 * from a possibly-since-changed menu item.
 */
export interface OrderItemSnapshot {
  itemId: string;
  name: string;
  priceInPaise: number;
  quantity: number;
  lineTotalInPaise: number;
}

export interface Order {
  id: string;
  userId: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  currency: OrderCurrency;
  subtotalInPaise: number;
  totalInPaise: number;
  items: OrderItemSnapshot[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * The customer-safe API response shape for an `Order`: timestamp fields as
 * ISO strings, and deliberately no `userId` — the caller already knows their
 * own identity, and the response envelope never echoes it back (see
 * docs/architecture/http-api.md's response-shape conventions and this
 * checkpoint's "Customer-safe response" requirements).
 */
export interface OrderResponse {
  id: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  currency: OrderCurrency;
  subtotalInPaise: number;
  totalInPaise: number;
  items: OrderItemSnapshot[];
  createdAt: string;
  updatedAt: string;
}

/** Bounded, reasonable length for an opaque client-supplied idempotency key
 * — long enough for a UUID or similar token, short enough to stay a sane
 * Firestore document ID (see `isValidDocumentId`, which this schema is
 * deliberately stricter than). */
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

const orderItemInputSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1),
});

/** One `items` entry from a `POST /orders` request body. */
type OrderRequestItem = z.infer<typeof orderItemInputSchema>;

/**
 * Validates a `POST /orders` request body. Deliberately small — see this
 * checkpoint's "Order creation API" notes: `outletId`/`menuId`/`items` are
 * the only order context the client supplies; everything else
 * (`organizationId`, `userId`, item name/description/price, line/subtotal/
 * total, `paymentStatus`, `status`, `currency`) is determined server-side by
 * `createOrder` and is not even a field on this schema, so a client that
 * sends one is silently stripped by `safeParse`, never trusted.
 */
export const createOrderBodySchema = z.object({
  outletId: z.string().min(1),
  menuId: z.string().min(1),
  items: z.array(orderItemInputSchema).min(1),
  idempotencyKey: z.string().trim().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const item of value.items) {
    if (seen.has(item.itemId)) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate item in request.",
        path: ["items"],
      });
      return;
    }
    seen.add(item.itemId);
  }
});

export type CreateOrderInput = z.infer<typeof createOrderBodySchema>;

const orderItemSnapshotDocSchema = z.object({
  itemId: z.string().min(1),
  name: z.string().min(1),
  priceInPaise: z.number().int().min(0),
  quantity: z.number().int().min(1),
  lineTotalInPaise: z.number().int().min(0),
});

const orderDocSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  outletId: z.string().min(1),
  menuId: z.string().min(1),
  status: z.enum(ORDER_STATUS_VALUES),
  paymentStatus: z.enum(ORDER_PAYMENT_STATUS_VALUES),
  currency: z.literal("INR"),
  subtotalInPaise: z.number().int().min(0),
  totalInPaise: z.number().int().min(0),
  items: z.array(orderItemSnapshotDocSchema).min(1),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
  updatedAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "updatedAt must be a Firestore Timestamp",
  ),
});

/**
 * Parses a stored order document, validating it was written in the expected
 * shape and that its `id`/`organizationId`/`outletId`/`menuId` fields match
 * the path it was read from.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The document ID it was read from.
 * @param {string} expectedOrganizationId The organization ID it was read from.
 * @param {string} expectedOutletId The outlet ID it was read from.
 * @param {string} expectedMenuId The menu ID it was read from.
 * @return {Order} The parsed order.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parseOrder(
  data: unknown,
  expectedId: string,
  expectedOrganizationId: string,
  expectedOutletId: string,
  expectedMenuId: string,
): Order {
  const parsed = orderDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== expectedId ||
    parsed.data.organizationId !== expectedOrganizationId ||
    parsed.data.outletId !== expectedOutletId ||
    parsed.data.menuId !== expectedMenuId
  ) {
    throw new Error(
      "Malformed order document at organizations/" +
      `${expectedOrganizationId}/outlets/${expectedOutletId}/menus/` +
      `${expectedMenuId}/orders/${expectedId}.`,
    );
  }
  return parsed.data;
}

/**
 * @param {Order} order A stored order.
 * @return {OrderResponse} The customer-safe API response shape for it —
 *   never `userId`.
 */
export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id,
    organizationId: order.organizationId,
    outletId: order.outletId,
    menuId: order.menuId,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    subtotalInPaise: order.subtotalInPaise,
    totalInPaise: order.totalInPaise,
    items: order.items,
    createdAt: order.createdAt.toDate().toISOString(),
    updatedAt: order.updatedAt.toDate().toISOString(),
  };
}

/**
 * ===========================================================================
 * Idempotency
 * ===========================================================================
 *
 * `users/{userId}/orderIdempotencyKeys/{idempotencyKey}` — a reservation
 * record proving a given (authenticated user, idempotency key) pair has
 * already produced an order, the same pattern `domain/outlets.ts`'s
 * `outletSlugs`/`domain/organizations.ts`'s `organizationSlugs` use for
 * atomic check-and-reserve uniqueness, applied here to request replay safety
 * instead of naming uniqueness.
 *
 * Nesting the record under `users/{userId}` (the verified session's own
 * user, never a client-supplied value — see `createOrder`) is what makes
 * "one user can never use another user's idempotency record" true by
 * construction: there is no code path through which user A's request could
 * ever read or write a document under `users/{userB}/...`.
 *
 * `requestFingerprint` lets `createOrder` tell a genuine retry (same key,
 * same logical request — replay the original order) apart from a reused key
 * with a different request body (a client bug or a real conflict — rejected
 * outright, never silently reinterpreted as either the old or the new
 * request).
 */
interface OrderIdempotencyRecord {
  idempotencyKey: string;
  userId: string;
  requestFingerprint: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  orderId: string;
  createdAt: Timestamp;
}

const orderIdempotencyRecordDocSchema = z.object({
  idempotencyKey: z.string().min(1),
  userId: z.string().min(1),
  requestFingerprint: z.string().min(1),
  organizationId: z.string().min(1),
  outletId: z.string().min(1),
  menuId: z.string().min(1),
  orderId: z.string().min(1),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
});

/**
 * Parses a stored idempotency record, validating it was written in the
 * expected shape and that its `idempotencyKey`/`userId` fields match the
 * path it was read from.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedKey The document ID (idempotency key) it was read from.
 * @param {string} expectedUserId The parent user ID it was read from.
 * @return {OrderIdempotencyRecord} The parsed record.
 * @throws {Error} If the stored document does not match the expected shape.
 */
function parseOrderIdempotencyRecord(
  data: unknown,
  expectedKey: string,
  expectedUserId: string,
): OrderIdempotencyRecord {
  const parsed = orderIdempotencyRecordDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.idempotencyKey !== expectedKey ||
    parsed.data.userId !== expectedUserId
  ) {
    throw new Error(
      `Malformed order idempotency record at users/${expectedUserId}` +
      `/orderIdempotencyKeys/${expectedKey}.`,
    );
  }
  return parsed.data;
}

/**
 * A deterministic fingerprint of the logical order-creation request: the
 * order/quantity of `items` in the request body must never matter, only
 * their (`itemId`, `quantity`) content — so items are sorted by `itemId`
 * before serializing. Pure and exported so it can be unit tested directly.
 *
 * @param {string} outletId The request's `outletId`.
 * @param {string} menuId The request's `menuId`.
 * @param {ReadonlyArray<OrderRequestItem>} items The request's `items`.
 * @return {string} A stable string identifying this exact logical request.
 */
export function computeOrderRequestFingerprint(
  outletId: string,
  menuId: string,
  items: ReadonlyArray<OrderRequestItem>,
): string {
  const sortedItems = items
    .map((item) => ({itemId: item.itemId, quantity: item.quantity}))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  return JSON.stringify({outletId, menuId, items: sortedItems});
}

/**
 * Resolves an outlet by its document ID alone, reading within an
 * in-progress transaction. An order-creation-specific parallel to
 * `domain/explore.ts`'s `resolveActivePublicOutlet`, deliberately duplicated
 * rather than imported: that function's read is NOT transaction-scoped
 * (explore is a plain read path with no atomicity requirement), and it
 * folds "outlet inactive" into the same not-found response an anonymous
 * caller gets for "outlet doesn't exist" — exactly the ambiguity order
 * creation must NOT have, since this checkpoint's error semantics require
 * an authenticated caller to be able to tell "outlet not found" and "outlet
 * inactive" apart (see `createOrder`, which checks `status` itself, right
 * after calling this).
 *
 * Since outlet IDs are Firestore auto-IDs — effectively globally unique — a
 * collection-group lookup by the outlet's own `id` field should return at
 * most one match; an ambiguous match (which should never happen) fails
 * closed as not-found, the same reasoning `resolveActivePublicOutlet` uses.
 *
 * @param {Firestore} db Admin Firestore instance (used only to build the
 *   query; the read itself goes through `tx`).
 * @param {Transaction} tx The in-progress transaction to read within, so
 *   this resolution participates in `createOrder`'s optimistic-concurrency
 *   read set.
 * @param {unknown} outletId The request's `outletId`.
 * @return {Promise<Outlet>} The resolved outlet, in ANY status — the caller
 *   decides whether its `status` is acceptable.
 * @throws {HttpsError} `invalid-argument` (400) if `outletId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such outlet exists, or the
 *   match is ambiguous.
 */
async function resolveOutletForOrder(
  db: Firestore,
  tx: Transaction,
  outletId: unknown,
): Promise<Outlet> {
  if (!isValidDocumentId(outletId)) {
    throw new HttpsError("invalid-argument", "Invalid outlet ID.");
  }

  const query = db.collectionGroup("outlets").where("id", "==", outletId).limit(2);
  const snapshot = await tx.get(query);
  if (snapshot.size !== 1) {
    throw new HttpsError("not-found", "Outlet not found.");
  }

  const doc = snapshot.docs[0];
  const organizationRef = doc.ref.parent.parent;
  if (!organizationRef) {
    throw new Error(`Outlet document has no parent organization: ${doc.ref.path}.`);
  }
  return parseOutlet(doc.data(), doc.id, organizationRef.id);
}

/** The result of `createOrder`: the order (either newly created or the
 * replayed result of a safely-retried idempotent request), and whether it
 * was actually created by this call. */
export interface CreateOrderResult {
  order: Order;
  /** `true` if this call created a new order; `false` if it returned the
   * existing order for an idempotency key already used by this same user
   * for the same logical request (see `computeOrderRequestFingerprint`). */
  created: boolean;
}

/**
 * Creates a customer pre-order for a published, currently-open menu —
 * Zesto's server-authoritative order-creation boundary (see root CLAUDE.md's
 * "Never trust the frontend for security" and this checkpoint's locked
 * business rules).
 *
 * `userId` MUST already be the verified Descope session's own user id (see
 * `routes/orders.ts`) — never a client-supplied value. Every other
 * authoritative fact (`organizationId`, item name/price, line/subtotal/
 * total, initial `status`/`paymentStatus`/`currency`) is derived here, from
 * Firestore, never from `input`.
 *
 * Runs entirely inside one Firestore transaction, so:
 * - the idempotency check, the menu/outlet/item reads, and the order +
 *   idempotency-record writes are all atomic — a concurrent request can
 *   never observe a half-created order or create a duplicate for the same
 *   (user, idempotencyKey) pair (see the "Idempotency" section above); and
 * - there is no separate inventory write to keep in sync — Zesto is
 *   demand-driven, so creating an order never touches the menu or its items
 *   beyond reading their current price/enabled state.
 *
 * If the transaction retries (Firestore's normal optimistic-concurrency
 * behavior on read-set contention), this entire function re-runs from
 * scratch against fresh reads, so the result is always valid for the data
 * actually committed against.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @param {CreateOrderInput} input The validated request body.
 * @return {Promise<CreateOrderResult>} The order and whether it was newly created.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed `outletId`,
 *   `menuId`, or item `itemId`.
 * @throws {HttpsError} `not-found` (404) if the outlet, menu (under that
 *   outlet), or any requested item (under that menu) doesn't exist.
 * @throws {HttpsError} `failed-precondition` (400) if the outlet is
 *   inactive; the menu is not published; ordering has not yet opened or has
 *   already closed; or any requested item is disabled.
 * @throws {HttpsError} `already-exists` (409) if `input.idempotencyKey` was
 *   already used by this same user for a different logical request.
 */
export async function createOrder(
  db: Firestore,
  userId: string,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  if (!isValidDocumentId(input.idempotencyKey)) {
    throw new HttpsError("invalid-argument", "Invalid idempotency key.");
  }
  if (!isValidDocumentId(input.outletId)) {
    throw new HttpsError("invalid-argument", "Invalid outlet ID.");
  }
  if (!isValidDocumentId(input.menuId)) {
    throw new HttpsError("invalid-argument", "Invalid menu ID.");
  }
  for (const item of input.items) {
    if (!isValidDocumentId(item.itemId)) {
      throw new HttpsError("invalid-argument", "Invalid item ID.");
    }
  }

  const fingerprint = computeOrderRequestFingerprint(input.outletId, input.menuId, input.items);
  const idemRef = db
    .collection("users").doc(userId)
    .collection("orderIdempotencyKeys").doc(input.idempotencyKey);

  return db.runTransaction(async (tx): Promise<CreateOrderResult> => {
    const idemSnapshot = await tx.get(idemRef);

    if (idemSnapshot.exists) {
      const record = parseOrderIdempotencyRecord(idemSnapshot.data(), input.idempotencyKey, userId);
      if (record.requestFingerprint !== fingerprint) {
        throw new HttpsError(
          "already-exists",
          "This idempotency key was already used for a different order request.",
        );
      }

      const orderRef = db
        .collection("organizations").doc(record.organizationId)
        .collection("outlets").doc(record.outletId)
        .collection("menus").doc(record.menuId)
        .collection("orders").doc(record.orderId);
      const orderSnapshot = await tx.get(orderRef);
      if (!orderSnapshot.exists) {
        throw new Error(
          `Idempotency record ${idemRef.path} references a missing order at ${orderRef.path}.`,
        );
      }
      const order = parseOrder(
        orderSnapshot.data(), record.orderId,
        record.organizationId, record.outletId, record.menuId,
      );
      return {order, created: false};
    }

    const outlet = await resolveOutletForOrder(db, tx, input.outletId);
    if (outlet.status !== "active") {
      throw new HttpsError("failed-precondition", "This outlet is not active.");
    }

    const menuRef = db
      .collection("organizations").doc(outlet.organizationId)
      .collection("outlets").doc(outlet.id)
      .collection("menus").doc(input.menuId);
    const menuSnapshot = await tx.get(menuRef);
    if (!menuSnapshot.exists) {
      throw new HttpsError("not-found", "Menu not found.");
    }
    const menu: Menu = parseMenu(menuSnapshot.data(), input.menuId, outlet.organizationId, outlet.id);
    if (menu.status !== "published") {
      throw new HttpsError("failed-precondition", "This menu is not open for ordering.");
    }

    const orderingState = computeOrderingState(menu);
    if (orderingState === "not_open") {
      throw new HttpsError("failed-precondition", "Ordering has not opened yet for this menu.");
    }
    if (orderingState === "closed") {
      throw new HttpsError("failed-precondition", "Ordering has closed for this menu.");
    }

    const itemRefs = input.items.map((item) => menuRef.collection("items").doc(item.itemId));
    const itemSnapshots = await tx.getAll(...itemRefs);

    const orderItems: OrderItemSnapshot[] = input.items.map((requested, index) => {
      const snapshot = itemSnapshots[index];
      if (!snapshot.exists) {
        throw new HttpsError("not-found", "Menu item not found.");
      }
      const item = parseMenuItem(snapshot.data(), requested.itemId, input.menuId);
      if (!item.enabled) {
        throw new HttpsError("failed-precondition", "This menu item is currently disabled.");
      }
      return {
        itemId: item.id,
        name: item.name,
        priceInPaise: item.priceInPaise,
        quantity: requested.quantity,
        lineTotalInPaise: item.priceInPaise * requested.quantity,
      };
    });

    const subtotalInPaise = orderItems.reduce((sum, item) => sum + item.lineTotalInPaise, 0);

    const orderRef = menuRef.collection("orders").doc();
    const now = Timestamp.now();
    const order: Order = {
      id: orderRef.id,
      userId,
      organizationId: outlet.organizationId,
      outletId: outlet.id,
      menuId: menu.id,
      status: "pending_payment",
      paymentStatus: "pending",
      currency: "INR",
      subtotalInPaise,
      totalInPaise: subtotalInPaise,
      items: orderItems,
      createdAt: now,
      updatedAt: now,
    };
    const idemRecord: OrderIdempotencyRecord = {
      idempotencyKey: input.idempotencyKey,
      userId,
      requestFingerprint: fingerprint,
      organizationId: outlet.organizationId,
      outletId: outlet.id,
      menuId: menu.id,
      orderId: orderRef.id,
      createdAt: now,
    };

    tx.create(orderRef, order);
    tx.create(idemRef, idemRecord);

    return {order, created: true};
  });
}

/**
 * Reads a single order by ID alone, for the customer-ownership endpoint
 * (`GET /orders/{orderId}` — see `routes/orders.ts`). Order IDs are
 * Firestore auto-IDs — effectively globally unique — so a collection-group
 * lookup by the order's own `id` field should return at most one match; an
 * ambiguous match (which should never happen) fails closed as not-found,
 * the same reasoning `domain/explore.ts`'s `resolveActivePublicOutlet` uses.
 *
 * Ownership is enforced here, not left to the caller: an order that exists
 * but belongs to a different user is indistinguishable from a nonexistent
 * one, so this never leaks whether a given order ID exists to a caller who
 * doesn't own it (including an organization's own staff/manager/owner, who
 * have no special access through this endpoint at all).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @param {unknown} orderId The order's document ID, from the request path.
 * @return {Promise<Order>} The order, already confirmed to belong to `userId`.
 * @throws {HttpsError} `invalid-argument` (400) if `orderId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such order exists, the match
 *   is ambiguous, or it exists but belongs to a different user.
 */
export async function getOwnedOrder(
  db: Firestore,
  userId: string,
  orderId: unknown,
): Promise<Order> {
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }

  const snapshot = await db.collectionGroup("orders").where("id", "==", orderId).limit(2).get();
  if (snapshot.size !== 1) {
    throw new HttpsError("not-found", "Order not found.");
  }

  const doc = snapshot.docs[0];
  const menuRef = doc.ref.parent.parent;
  if (!menuRef) {
    throw new Error(`Order document has no parent menu: ${doc.ref.path}.`);
  }
  const outletRef = menuRef.parent.parent;
  if (!outletRef) {
    throw new Error(`Order document has no parent outlet: ${doc.ref.path}.`);
  }
  const organizationRef = outletRef.parent.parent;
  if (!organizationRef) {
    throw new Error(`Order document has no parent organization: ${doc.ref.path}.`);
  }

  const order = parseOrder(doc.data(), doc.id, organizationRef.id, outletRef.id, menuRef.id);
  if (order.userId !== userId) {
    throw new HttpsError("not-found", "Order not found.");
  }

  return order;
}

/**
 * Resolves an order by its document ID alone, reading within an in-progress
 * transaction — the transaction-scoped counterpart to `getOwnedOrder`, for
 * `domain/payments.ts`'s payment operations, which all need to read and
 * later write the order atomically alongside its payment. Deliberately
 * duplicates `getOwnedOrder`'s parent-chain walk rather than sharing it (the
 * same reasoning `resolveOutletForOrder`'s doc comment gives): the two have
 * different transaction/ownership shapes, so factoring them together would
 * cost more than the few duplicated lines it would save.
 *
 * Ownership is NOT checked here — callers that need it (e.g.
 * `domain/payments.ts`'s `preparePayment`, called on behalf of an
 * authenticated customer) must compare `order.userId` themselves; callers
 * that don't (the trusted `markPaymentSucceeded`/`markPaymentFailed`
 * transitions, which have no customer session in scope at all) simply don't.
 *
 * @param {Firestore} db Admin Firestore instance (used only to build the
 *   query; the read itself goes through `tx`).
 * @param {Transaction} tx The in-progress transaction to read within.
 * @param {unknown} orderId The order's document ID.
 * @return {Promise<{order: Order; orderRef: DocumentReference}>} The
 *   resolved order and its document reference, for the caller's own
 *   subsequent reads/writes within the same transaction.
 * @throws {HttpsError} `invalid-argument` (400) if `orderId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such order exists, or the
 *   match is ambiguous.
 */
export async function resolveOrderById(
  db: Firestore,
  tx: Transaction,
  orderId: unknown,
): Promise<{order: Order; orderRef: DocumentReference}> {
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }

  const snapshot = await tx.get(
    db.collectionGroup("orders").where("id", "==", orderId).limit(2),
  );
  if (snapshot.size !== 1) {
    throw new HttpsError("not-found", "Order not found.");
  }

  const doc = snapshot.docs[0];
  const menuRef = doc.ref.parent.parent;
  if (!menuRef) {
    throw new Error(`Order document has no parent menu: ${doc.ref.path}.`);
  }
  const outletRef = menuRef.parent.parent;
  if (!outletRef) {
    throw new Error(`Order document has no parent outlet: ${doc.ref.path}.`);
  }
  const organizationRef = outletRef.parent.parent;
  if (!organizationRef) {
    throw new Error(`Order document has no parent organization: ${doc.ref.path}.`);
  }

  const order = parseOrder(doc.data(), doc.id, organizationRef.id, outletRef.id, menuRef.id);
  return {order, orderRef: doc.ref};
}

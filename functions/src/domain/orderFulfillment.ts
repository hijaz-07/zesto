import {Timestamp, type Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";
import {
  isValidDocumentId,
  type OrganizationMemberRole,
  type OrganizationMembership,
} from "../auth/membership";
import {resolveOrderById, type Order, type OrderStatus} from "./orders";

/**
 * Order FULFILLMENT — the operational half of an order's life, after payment
 * has confirmed it:
 *
 * ```
 * confirmed --start-preparing--> preparing --mark-ready--> ready
 *                                       picked_up --complete--> completed
 * ```
 *
 * `transitionOrderStatus` is the ONE place these transitions are decided and
 * written; the routes (`routes/organizationOrders.ts`) only choose a target.
 * Nothing in a request can say what the current status is, which transition is
 * allowed, who the actor is, or whether the order is paid: all of that is read
 * from the authoritative order inside the transaction, and the actor is the
 * caller's verified membership.
 *
 * Deliberately NOT here: `ready` -> `picked_up`. Handing food over needs its
 * own verification (a pickup credential), so it lives in
 * `domain/orderPickup.ts` and `picked_up` is not a fulfillment target — it
 * must never be reachable through a generic status change, and no URL that
 * merely names an order can reach it. `completed` has no such need: closing out
 * an order that was already handed over is plain operations, so it is the third
 * row of the table below. Also not here (later features — see root
 * CLAUDE.md): backing out of a state, and cancellation/refunds. `completed`
 * and `cancelled` are terminal.
 *
 * Payment is not re-checked against the provider or the payment document. The
 * order's own `status == "confirmed"` and `paymentStatus == "paid"` are
 * sufficient: the only code that ever writes either is `domain/payments.ts`'s
 * `markPaymentSucceeded`, which sets both atomically with the payment's
 * `succeeded` status, and Firestore rules deny every client write to orders.
 * This module never touches payments and never calls Razorpay.
 */

/** The statuses a fulfillment action can move an order INTO. */
export type FulfillmentTarget = "preparing" | "ready" | "completed";

/**
 * Roles that may run fulfillment actions: every active member, staff
 * included. Fulfillment is operating the counter and the kitchen, not
 * configuring the organization, so it is wider than the owner/manager
 * "manage" set that guards outlets, menus and items. Exported so the route
 * authorizes with exactly the set this module documents.
 */
export const ORDER_FULFILLMENT_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

interface FulfillmentRule {
  /** The only status an order may move into this target from. */
  from: OrderStatus;
  /** The audit fields written, once, by the transition that enters the target. */
  audit(actorUserId: string, at: Timestamp): Partial<Order>;
}

/**
 * The whole fulfillment state machine. A target not listed here is not a
 * fulfillment target at all — including every other order status — so adding
 * a state later is a deliberate edit to this table, never an accident.
 */
const FULFILLMENT_TRANSITIONS: Readonly<Record<FulfillmentTarget, FulfillmentRule>> = {
  preparing: {
    from: "confirmed",
    audit: (actorUserId, at) => ({preparingStartedAt: at, preparingStartedBy: actorUserId}),
  },
  ready: {
    from: "preparing",
    audit: (actorUserId, at) => ({readyAt: at, readyBy: actorUserId}),
  },
  completed: {
    from: "picked_up",
    audit: (actorUserId, at) => ({completedAt: at, completedBy: actorUserId}),
  },
};

/**
 * @param {unknown} value A requested target status.
 * @return {boolean} Whether it is a status fulfillment can move an order into.
 */
export function isFulfillmentTarget(value: unknown): value is FulfillmentTarget {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(FULFILLMENT_TRANSITIONS, value);
}

/** What `decideFulfillmentTransition` concluded. */
export type FulfillmentDecision = "apply" | "noop";

/**
 * Decides, from an order's CURRENT stored state alone, whether moving it to
 * `to` is a real transition, an already-done repeat, or not allowed. Pure and
 * exported so the full transition matrix is unit-testable without Firestore;
 * `transitionOrderStatus` calls it inside its transaction on the freshly-read
 * order, so the decision is always made against committed data.
 *
 * - The order is already in `to`: `"noop"`. Repeating an action is safe and
 *   changes nothing — in particular it never overwrites the original audit
 *   fields, so a second person (or a retried request) cannot take the credit.
 * - The order is in the one status `to` may be entered from, and is paid:
 *   `"apply"`.
 * - Anything else — the wrong status (including `pending_payment`,
 *   `cancelled`, and going "backwards"), or an order in the right status whose
 *   payment is not `paid` (which no code path can produce; refused rather than
 *   fulfilled) — is a conflict.
 *
 * @param {Order} order The order as currently stored.
 * @param {unknown} to The requested target status.
 * @return {FulfillmentDecision} Whether to write the transition or do nothing.
 * @throws {HttpsError} `invalid-argument` (400) if `to` is not a fulfillment
 *   target; `aborted` (409) if the transition is not allowed from the
 *   order's current state.
 */
export function decideFulfillmentTransition(order: Order, to: unknown): FulfillmentDecision {
  if (!isFulfillmentTarget(to)) {
    throw new HttpsError("invalid-argument", "Unsupported order status.");
  }

  if (order.status === to) {
    return "noop";
  }

  const rule = FULFILLMENT_TRANSITIONS[to];
  if (order.status !== rule.from) {
    if (order.status === "pending_payment") {
      throw new HttpsError("aborted", "This order has not been paid yet.");
    }
    if (to === "completed" && PRE_PICKUP_STATUSES.includes(order.status)) {
      throw new HttpsError("aborted", "This order has not been picked up yet.");
    }
    throw new HttpsError(
      "aborted",
      `This order is ${describeStatus(order.status)}, so it can't be moved to ${describeStatus(to)}.`,
    );
  }

  if (order.paymentStatus !== "paid") {
    // Unreachable unless the stored data broke its own payment invariant.
    logger.warn("Order is past payment without being paid; refusing to fulfill it.", {orderId: order.id});
    throw new HttpsError("aborted", "This order has not been paid yet.");
  }

  return "apply";
}

/** The paid statuses an order is in before the customer has collected it. */
const PRE_PICKUP_STATUSES: readonly OrderStatus[] = ["confirmed", "preparing", "ready"];

/**
 * @param {OrderStatus} status An order status.
 * @return {string} How it reads in an error message.
 */
function describeStatus(status: OrderStatus): string {
  if (status === "pending_payment") {
    return "awaiting payment";
  }
  return status === "picked_up" ? "picked up" : status;
}

/** The result of `transitionOrderStatus`. */
export interface TransitionOrderStatusResult {
  /** The order as it stands after the call. */
  order: Order;
  /** `true` if this call wrote the transition; `false` for a repeat that changed nothing. */
  changed: boolean;
  /** The order's status when this call read it (equal to `order.status` for a no-op). */
  previousStatus: OrderStatus;
}

export interface TransitionOrderStatusInput {
  /**
   * The caller's membership, as returned by `requireOrganizationRole` — the
   * only way to obtain one. Its `organizationId` is the scope the order must
   * belong to and its `userId` is recorded as the actor; neither is ever a
   * request value.
   */
  membership: OrganizationMembership;
  /** The order's document ID, from the request path. */
  orderId: unknown;
  /** The status to move the order into. */
  to: FulfillmentTarget;
}

/**
 * Moves an order through fulfillment on behalf of an authorized member — the
 * single authoritative implementation of `confirmed` -> `preparing` -> `ready`
 * (see the module doc comment).
 *
 * Everything is decided inside ONE Firestore transaction: the order is read,
 * its organization checked, `decideFulfillmentTransition` applied to what was
 * actually read, and the status, the audit fields and `updatedAt` written
 * together. If another request commits against the same order first, the
 * transaction re-runs against the new state — so of two staff pressing the
 * same button at once exactly one write happens and the other sees a no-op,
 * and a button pressed on a stale screen is refused rather than overwriting
 * newer work. A transaction that still cannot commit after Firestore's own
 * retries is reported as a conflict (409), not an internal error.
 *
 * The role is re-asserted here from the membership itself, as defense in
 * depth beneath the route's `requireOrganizationRole`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {TransitionOrderStatusInput} input The authorized caller, order and target.
 * @return {Promise<TransitionOrderStatusResult>} The resulting order.
 * @throws {HttpsError} `permission-denied` (403) if the membership is not an
 *   active one with a fulfillment role; `invalid-argument` (400) for a
 *   malformed `orderId` or an unsupported target; `not-found` (404) if no such
 *   order exists in the caller's organization (another organization's order is
 *   indistinguishable); `aborted` (409) if the order's state does not allow the
 *   transition, or the write lost a race it could not retry past.
 */
export async function transitionOrderStatus(
  db: Firestore,
  input: TransitionOrderStatusInput,
): Promise<TransitionOrderStatusResult> {
  const {membership, orderId, to} = input;

  if (membership.status !== "active" || !ORDER_FULFILLMENT_ROLES.includes(membership.role)) {
    throw new HttpsError("permission-denied", "You do not have access to this organization.");
  }
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }
  if (!isFulfillmentTarget(to)) {
    throw new HttpsError("invalid-argument", "Unsupported order status.");
  }

  try {
    return await db.runTransaction(async (tx): Promise<TransitionOrderStatusResult> => {
      const {order, orderRef} = await resolveOrderById(db, tx, orderId);

      // Another organization's order must look exactly like a missing one.
      if (order.organizationId !== membership.organizationId) {
        throw new HttpsError("not-found", "Order not found.");
      }

      if (decideFulfillmentTransition(order, to) === "noop") {
        return {order, changed: false, previousStatus: order.status};
      }

      const now = Timestamp.now();
      const updates: Partial<Order> = {
        status: to,
        updatedAt: now,
        ...FULFILLMENT_TRANSITIONS[to].audit(membership.userId, now),
      };
      tx.update(orderRef, updates);

      return {order: {...order, ...updates}, changed: true, previousStatus: order.status};
    });
  } catch (error) {
    if (!(error instanceof HttpsError) && isFirestoreAborted(error)) {
      throw new HttpsError(
        "aborted",
        "This order was just changed by someone else. Refresh and try again.",
      );
    }
    throw error;
  }
}

/**
 * Exported so `domain/orderPickup.ts` reports a contended pickup the same way.
 *
 * @param {unknown} error A thrown value.
 * @return {boolean} Whether it is Firestore reporting that a transaction
 *   could not commit because of contention (gRPC `ABORTED`, code 10).
 */
export function isFirestoreAborted(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === 10 || error.code === "aborted";
}

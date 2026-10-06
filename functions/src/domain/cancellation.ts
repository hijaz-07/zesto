import type {Timestamp} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import type {Order, OrderStatus} from "./orders";
import type {PaymentStatus} from "./payments";

/**
 * Order CANCELLATION — the decision, and nothing else. This module is pure: it
 * reads no Firestore, calls no provider, writes nothing. A later transactional
 * layer reads the order, its payment and its menu inside one Firestore
 * transaction, calls `decideCancellation` on what it read, and acts on the
 * answer — exactly the split `decideFulfillmentTransition` and
 * `transitionOrderStatus` have in `orderFulfillment.ts`.
 *
 * Cancellation is a terminal, irreversible move into the EXISTING
 * `status: "cancelled"` (there is no second cancelled status). It is not a
 * refund: whether money must go back is reported (`refund`), not done here.
 *
 * Approved policy, as encoded below:
 *
 * | Order status      | Customer (own order)            | Owner / manager | Staff |
 * | ----------------- | ------------------------------- | --------------- | ----- |
 * | `pending_payment` | yes, any time                   | yes             | no    |
 * | `confirmed`       | yes, strictly before the        | yes             | no    |
 * |                   | ordering deadline               |                 |       |
 * | `preparing`       | no                              | yes             | no    |
 * | `ready`           | no                              | yes             | no    |
 * | `picked_up`       | no                              | no              | no    |
 * | `completed`       | no                              | no              | no    |
 * | `cancelled`       | idempotent no-op (once authorised)                     |
 *
 * The ordering deadline is `Menu.orderingClosesAt`, and the instant itself is
 * already closed (`now >= deadline`), matching `computeOrderingState`. An
 * unreadable deadline fails closed.
 */

/** Statuses an order may be cancelled FROM, by anyone. The rest are past saving. */
export const CANCELLABLE_ORDER_STATUSES = [
  "pending_payment", "confirmed", "preparing", "ready",
] as const satisfies readonly OrderStatus[];
export type CancellableOrderStatus = (typeof CANCELLABLE_ORDER_STATUSES)[number];

/** Why a CUSTOMER cancels. Optional on a customer cancellation. No free text in v1. */
export const CUSTOMER_CANCELLATION_REASONS = [
  "changed_my_mind",
  "ordered_by_mistake",
  "wrong_items_or_quantity",
  "wrong_pickup_time",
  "other",
] as const;
export type CustomerCancellationReason = (typeof CUSTOMER_CANCELLATION_REASONS)[number];

/** Why an ORGANIZATION cancels. Required on an organization cancellation. No free text in v1. */
export const ORGANIZATION_CANCELLATION_REASONS = [
  "item_unavailable",
  "outlet_closed",
  "cannot_fulfil_in_time",
  "duplicate_order",
  "customer_requested",
  "other",
] as const;
export type OrganizationCancellationReason = (typeof ORGANIZATION_CANCELLATION_REASONS)[number];

export type OrderCancellationReason = CustomerCancellationReason | OrganizationCancellationReason;

/**
 * Every reason an order document may carry (`other` is in both sets). Written
 * out rather than computed so it is a plain tuple for zod; the assertion below
 * makes the compiler fail if it ever drifts from the two sets above.
 */
export const ORDER_CANCELLATION_REASON_VALUES = [
  "changed_my_mind",
  "ordered_by_mistake",
  "wrong_items_or_quantity",
  "wrong_pickup_time",
  "other",
  "item_unavailable",
  "outlet_closed",
  "cannot_fulfil_in_time",
  "duplicate_order",
  "customer_requested",
] as const;
type AssertSameReasons = [
  Exclude<OrderCancellationReason, (typeof ORDER_CANCELLATION_REASON_VALUES)[number]>,
  Exclude<(typeof ORDER_CANCELLATION_REASON_VALUES)[number], OrderCancellationReason>,
] extends [never, never] ? true : never;
export const REASON_SETS_ARE_IN_SYNC: AssertSameReasons = true;

/**
 * Who cancelled. v1 has two: system cancellation (e.g. pending-payment expiry)
 * is deferred, so there is deliberately no `system` here yet; adding it is a
 * deliberate later edit.
 */
export const ORDER_CANCELLED_BY_ROLE_VALUES = ["customer", "organization"] as const;
export type OrderCancelledByRole = (typeof ORDER_CANCELLED_BY_ROLE_VALUES)[number];

/**
 * Roles that may cancel an order on the organization's behalf. Staff may not:
 * cancelling an order starts a refund, which is money, not counter operations.
 * Deliberately its own export, like `ORDER_FULFILLMENT_ROLES`.
 */
export const ORDER_CANCELLATION_ROLES: readonly OrganizationMemberRole[] = ["owner", "manager"];

/**
 * @param {unknown} value A candidate reason.
 * @return {boolean} Whether it is one of the customer reasons.
 */
export function isCustomerCancellationReason(value: unknown): value is CustomerCancellationReason {
  return typeof value === "string" && (CUSTOMER_CANCELLATION_REASONS as readonly string[]).includes(value);
}

/**
 * @param {unknown} value A candidate reason.
 * @return {boolean} Whether it is one of the organization reasons.
 */
export function isOrganizationCancellationReason(value: unknown): value is OrganizationCancellationReason {
  return typeof value === "string" && (ORGANIZATION_CANCELLATION_REASONS as readonly string[]).includes(value);
}

/** Who is asking, as the server verified it — never request values. */
export type CancellationActor =
  | {kind: "customer"; userId: string}
  | {kind: "organization"; membership: OrganizationMembership};

export interface DecideCancellationInput {
  actor: CancellationActor;
  /** The order as read inside the transaction. */
  order: Pick<Order, "userId" | "organizationId" | "status" | "paymentStatus">;
  /** The order's payment status, or `"absent"` if it has no payment document. */
  paymentStatus: PaymentStatus | "absent";
  /** The menu's `orderingClosesAt`. */
  orderingClosesAt: Date;
  /** The transaction's clock. */
  now: Date;
  /** The requested reason, as received; validated here. */
  reason?: unknown;
}

export type CancellationRefusalCode =
  | "not_order_owner"
  | "wrong_organization"
  | "not_permitted"
  | "invalid_reason"
  | "reason_required"
  | "ordering_closed"
  | "preparation_started"
  | "order_ready"
  | "already_picked_up"
  | "already_completed"
  | "payment_state_inconsistent";

export type CancellationDecision =
  | {
    outcome: "cancel";
    fromStatus: CancellableOrderStatus;
    cancelledBy: string;
    cancelledByRole: OrderCancelledByRole;
    /** Absent for a customer who gave none. */
    reason?: OrderCancellationReason;
    /** Whether money was captured and must be refunded in full. */
    refund: "required" | "not_required";
  }
  | {outcome: "already_cancelled"}
  | {outcome: "refuse"; code: CancellationRefusalCode};

const PAID_STATUSES: readonly CancellableOrderStatus[] = ["confirmed", "preparing", "ready"];

/**
 * @param {CancellationRefusalCode} code What was refused.
 * @return {CancellationDecision} The refusal.
 */
function refuse(code: CancellationRefusalCode): CancellationDecision {
  return {outcome: "refuse", code};
}

/**
 * Decides, from facts alone, whether the actor may cancel the order now. Pure
 * and deterministic: the same input always gives the same answer.
 *
 * Checked in this order, the first failure deciding:
 * 1. Identity. A customer must own the order; an organization actor must be an
 *    active member with a cancellation role, of the order's own organization.
 *    (A later layer reports `not_order_owner` / `wrong_organization` as a plain
 *    "not found", so a stranger learns nothing.)
 * 2. The reason: a customer's is optional but, if given, must be a customer
 *    reason; an organization's is required and must be an organization reason.
 * 3. An order that is already `cancelled`: `already_cancelled`, a safe repeat
 *    that changes nothing (the original actor and reason stay on record).
 * 4. The status rules in the table above.
 * 5. Payment consistency: a paid status needs `paymentStatus: "paid"` AND a
 *    `succeeded` payment, and `pending_payment` needs neither. A mismatch is
 *    refused rather than refunded or cancelled on a guess.
 *
 * @param {DecideCancellationInput} input The facts.
 * @return {CancellationDecision} What to do.
 */
export function decideCancellation(input: DecideCancellationInput): CancellationDecision {
  const {actor, order} = input;

  let cancelledBy: string;
  let cancelledByRole: OrderCancelledByRole;
  if (actor.kind === "customer") {
    if (order.userId !== actor.userId) {
      return refuse("not_order_owner");
    }
    cancelledBy = actor.userId;
    cancelledByRole = "customer";
  } else {
    const {membership} = actor;
    if (membership.status !== "active" || !ORDER_CANCELLATION_ROLES.includes(membership.role)) {
      return refuse("not_permitted");
    }
    if (membership.organizationId !== order.organizationId) {
      return refuse("wrong_organization");
    }
    cancelledBy = membership.userId;
    cancelledByRole = "organization";
  }

  let reason: OrderCancellationReason | undefined;
  if (actor.kind === "customer") {
    if (input.reason !== undefined) {
      if (!isCustomerCancellationReason(input.reason)) {
        return refuse("invalid_reason");
      }
      reason = input.reason;
    }
  } else {
    if (input.reason === undefined) {
      return refuse("reason_required");
    }
    if (!isOrganizationCancellationReason(input.reason)) {
      return refuse("invalid_reason");
    }
    reason = input.reason;
  }

  if (order.status === "cancelled") {
    return {outcome: "already_cancelled"};
  }

  const fromStatus = order.status;
  switch (fromStatus) {
  case "picked_up":
    return refuse("already_picked_up");
  case "completed":
    return refuse("already_completed");
  case "preparing":
    if (actor.kind === "customer") {
      return refuse("preparation_started");
    }
    break;
  case "ready":
    if (actor.kind === "customer") {
      return refuse("order_ready");
    }
    break;
  case "confirmed":
    // `!(now < deadline)`, not `now >= deadline`: an unreadable (NaN) deadline
    // compares false both ways and must read as closed.
    if (actor.kind === "customer" && !(input.now.getTime() < input.orderingClosesAt.getTime())) {
      return refuse("ordering_closed");
    }
    break;
  case "pending_payment":
    break;
  }

  const isPaidStatus = PAID_STATUSES.includes(fromStatus);
  if (isPaidStatus) {
    if (order.paymentStatus !== "paid" || input.paymentStatus !== "succeeded") {
      return refuse("payment_state_inconsistent");
    }
  } else if (order.paymentStatus !== "pending" || input.paymentStatus === "succeeded") {
    return refuse("payment_state_inconsistent");
  }

  return {
    outcome: "cancel",
    fromStatus,
    cancelledBy,
    cancelledByRole,
    ...(reason !== undefined ? {reason} : {}),
    refund: isPaidStatus ? "required" : "not_required",
  };
}

/**
 * The order fields a cancellation writes, once, in the cancelling transaction.
 * Never contains an `undefined` value (Firestore rejects one): a customer who
 * gave no reason simply has no `cancellationReason`.
 *
 * @param {CancellationDecision} decision A `cancel` decision.
 * @param {Timestamp} at The transaction's timestamp (also `updatedAt`).
 * @return {Partial<Order>} The fields to write.
 */
export function buildOrderCancellationFields(
  decision: Extract<CancellationDecision, {outcome: "cancel"}>,
  at: Timestamp,
): Partial<Order> {
  return {
    status: "cancelled",
    updatedAt: at,
    cancelledAt: at,
    cancelledBy: decision.cancelledBy,
    cancelledByRole: decision.cancelledByRole,
    cancelledFromStatus: decision.fromStatus,
    ...(decision.reason !== undefined ? {cancellationReason: decision.reason} : {}),
  };
}

/**
 * The HTTP-facing error for a refusal, using the codes the rest of the API
 * already uses (404 for "not yours" so existence is not leaked, 403, 400, 409).
 *
 * @param {CancellationRefusalCode} code The refusal.
 * @return {HttpsError} The error to throw.
 */
export function cancellationRefusalToHttpsError(code: CancellationRefusalCode): HttpsError {
  switch (code) {
  case "not_order_owner":
  case "wrong_organization":
    return new HttpsError("not-found", "Order not found.");
  case "not_permitted":
    return new HttpsError("permission-denied", "You do not have access to this organization.");
  case "invalid_reason":
    return new HttpsError("invalid-argument", "Invalid cancellation reason.");
  case "reason_required":
    return new HttpsError("invalid-argument", "A cancellation reason is required.");
  case "ordering_closed":
    return new HttpsError("aborted", "Ordering has closed, so this order can no longer be cancelled.");
  case "preparation_started":
    return new HttpsError("aborted", "This order is already being prepared, so it can't be cancelled.");
  case "order_ready":
    return new HttpsError("aborted", "This order is ready for pickup, so it can't be cancelled.");
  case "already_picked_up":
    return new HttpsError("aborted", "This order has already been picked up.");
  case "already_completed":
    return new HttpsError("aborted", "This order has already been completed.");
  case "payment_state_inconsistent":
    return new HttpsError("aborted", "This order's payment state does not allow cancellation.");
  }
}

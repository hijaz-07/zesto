import type {Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import {isValidDocumentId} from "../auth/membership";
import {parseOrder, type Order} from "./orders";
import {toRefundSummary, type CancellationRefundSummary} from "./orderCancellation";
import {isFirestoreAborted} from "./orderFulfillment";
import {createRefundRetry} from "./refundRetry";
import {orderRefFor} from "./refundTransitions";
import {parseRefund} from "./refunds";

/**
 * Retrying a FAILED refund, on behalf of an organization member — the thin route
 * adapter over `createRefundRetry` (`refundRetry.ts`), which stays the one
 * implementation of the retry and of its accounting (a new refund document with
 * the next deterministic ID, so a new provider idempotency key; the previous
 * failed attempt is never reopened; the amount is whatever is still refundable on
 * the payment, never anything the caller sends).
 *
 * This module only decides WHO may ask and WHICH order it is:
 * - only an active owner or manager (`REFUND_RETRY_ROLES`; staff may not move money);
 * - the order must belong to the caller's own organization — anyone else's is a
 *   plain `404`, indistinguishable from an order that does not exist;
 * - the order must be `cancelled` (a refund exists only for one).
 *
 * Idempotency: a repeat, or two racing requests, serialize on the payment inside
 * `createRefundRetry`; the second finds the first's new refund as the latest one,
 * which is no longer `failed`, and is refused with `409` — never a second refund.
 */

/**
 * Roles that may retry a failed refund. Its own export, like
 * `ORDER_CANCELLATION_ROLES`: "may cancel" and "may recover money" are different
 * decisions that merely coincide today.
 */
export const REFUND_RETRY_ROLES: readonly OrganizationMemberRole[] = ["owner", "manager"];

export interface RetryOrderRefundInput {
  membership: OrganizationMembership;
  orderId: unknown;
}

export interface RetryOrderRefundResult {
  /** The order as it stands after the retry, with its refund mirror updated. */
  order: Order;
  /** The new refund, in the same safe shape a cancellation returns (no provider or payment IDs). */
  refund: CancellationRefundSummary | null;
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {RetryOrderRefundInput} input The verified membership and the order ID.
 * @return {Promise<RetryOrderRefundResult>} The order and the new refund.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed order ID;
 *   `permission-denied` (403) for a member without a retry role; `not-found` (404)
 *   if there is no such order in the caller's organization; `aborted` (409) if the
 *   order's latest refund is not a failed one of Zesto's own, nothing is left to
 *   refund, or the payment cannot be refunded safely.
 */
export async function retryOrderRefund(
  db: Firestore,
  input: RetryOrderRefundInput,
): Promise<RetryOrderRefundResult> {
  const {membership, orderId} = input;
  if (membership.status !== "active" || !REFUND_RETRY_ROLES.includes(membership.role)) {
    throw new HttpsError("permission-denied", "You don't have permission to retry refunds.");
  }
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }

  // Resolved inside the caller's own organization only: an ID from elsewhere is simply not found.
  const found = await db.collectionGroup("orders").where("id", "==", orderId).limit(2).get();
  const doc = found.size === 1 ? found.docs[0] : undefined;
  const location = doc === undefined ? null : locationOf(doc.ref.path);
  if (doc === undefined || location === null || location.organizationId !== membership.organizationId) {
    throw new HttpsError("not-found", "Order not found.");
  }
  const order = parseOrder(doc.data(), doc.id, location.organizationId, location.outletId, location.menuId);
  if (order.status !== "cancelled") {
    throw new HttpsError("aborted", "Only a cancelled order has a refund to retry.");
  }

  let result;
  try {
    result = await createRefundRetry(db, {
      location: {...location, orderId: order.id, paymentId: order.id},
      initiatedBy: membership.userId,
      initiatedByRole: "organization",
    });
  } catch (error) {
    if (!(error instanceof HttpsError) && isFirestoreAborted(error)) {
      throw new HttpsError("aborted", "This refund was just changed by someone else. Refresh and try again.");
    }
    throw error;
  }

  switch (result.kind) {
  case "not_found":
    throw new HttpsError("not-found", "Order not found.");
  case "not_retryable":
    throw new HttpsError("aborted", NOT_RETRYABLE_MESSAGE[result.reason]);
  case "nothing_to_refund":
    throw new HttpsError("aborted", "Nothing is left to refund on this order.");
  case "not_refundable":
    logger.warn("A failed refund cannot be retried: the payment is not safely refundable.", {
      orderId: order.id, reason: result.reason,
    });
    throw new HttpsError("aborted", "This payment can't be refunded from here. Contact Zesto support.");
  case "created":
    break;
  }

  // Display only, read after the commit: the retry already stands whatever these reads say.
  const orderRef = orderRefFor(db, {...location, orderId: order.id});
  const [orderSnap, refundSnap] = await Promise.all([
    orderRef.get(),
    orderRef.collection("payments").doc(order.id).collection("refunds").doc(result.refundId).get(),
  ]);
  const fresh = orderSnap.exists ?
    parseOrder(orderSnap.data(), order.id, order.organizationId, order.outletId, order.menuId) :
    order;
  const refund = refundSnap.exists ?
    toRefundSummary(parseRefund(
      refundSnap.data(), result.refundId, order.id, order.id, order.organizationId, order.outletId, order.menuId,
    )) :
    null;
  return {order: fresh, refund};
}

const NOT_RETRYABLE_MESSAGE = {
  no_refund: "This order has no refund to retry.",
  latest_not_failed: "This order's refund hasn't failed, so there is nothing to retry. Refresh to see where it stands.",
  external_refund: "A refund made outside Zesto can't be retried here.",
} as const;

/**
 * @param {string} path An order document path.
 * @return {{organizationId: string, outletId: string, menuId: string} | null} Its
 *   coordinates, or null if the path is not an order's.
 */
function locationOf(path: string): {organizationId: string; outletId: string; menuId: string} | null {
  const s = path.split("/");
  if (s.length !== 8 || s[0] !== "organizations" || s[2] !== "outlets" || s[4] !== "menus" || s[6] !== "orders") {
    return null;
  }
  return {organizationId: s[1], outletId: s[3], menuId: s[5]};
}

import type {Timestamp, Firestore} from "firebase-admin/firestore";
import {Timestamp as FirestoreTimestamp} from "firebase-admin/firestore";
import {recordRefundNotificationEvent} from "./notificationEvents";
import {parseOrder} from "./orders";
import {parsePayment} from "./payments";
import type {PaymentNotRefundableReason} from "./refundAmounts";
import {deriveRefundState, readRefundAggregates} from "./refundAmounts";
import {planRefundCreation, readNextRefundSlot} from "./refundCreation";
import {orderRefFor, paymentRefFor, type RefundLocation} from "./refundTransitions";
import {parseRefund, refundIdFor, type RefundInitiatorRole} from "./refunds";

/**
 * Starting a NEW refund attempt after one `failed` — the system capability only;
 * no route exposes it yet (a later checkpoint adds the owner/manager retry).
 *
 * A failed refund is terminal and is never reopened: the retry is a new document
 * with the next deterministic ID (`${orderId}-r${seq}`) and therefore a new
 * provider idempotency key, created by the same `planRefundCreation` every refund
 * uses. The previous attempt stays exactly as it was.
 *
 * Done in one transaction that re-reads the payment, so it can never exceed what
 * was captured (the amount is the whole remaining refundable amount, which excludes
 * everything refunded or still reserved), and two concurrent retries serialize on the
 * payment: the second finds the first's `requested` refund as the latest and refuses.
 */

export type CreateRefundRetryResult =
  | {kind: "created"; refundId: string}
  | {kind: "not_found"}
  | {kind: "not_retryable"; reason: "no_refund" | "latest_not_failed" | "external_refund"}
  | {kind: "nothing_to_refund"}
  | {kind: "not_refundable"; reason: PaymentNotRefundableReason};

export interface CreateRefundRetryInput {
  location: Omit<RefundLocation, "refundId">;
  /** A user's Descope ID, or `REFUND_SYSTEM_INITIATOR`. */
  initiatedBy: string;
  initiatedByRole: RefundInitiatorRole;
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {CreateRefundRetryInput} input The payment and who is retrying.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<CreateRefundRetryResult>} What happened.
 */
export async function createRefundRetry(
  db: Firestore,
  input: CreateRefundRetryInput,
  now: Timestamp = FirestoreTimestamp.now(),
): Promise<CreateRefundRetryResult> {
  const loc = input.location;
  return db.runTransaction(async (tx): Promise<CreateRefundRetryResult> => {
    const orderRef = orderRefFor(db, loc);
    const paymentRef = paymentRefFor(db, loc);
    const [orderSnap, paymentSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef)]);
    if (!orderSnap.exists || !paymentSnap.exists) {
      return {kind: "not_found"};
    }
    const order = parseOrder(orderSnap.data(), loc.orderId, loc.organizationId, loc.outletId, loc.menuId);
    const payment = parsePayment(
      paymentSnap.data(), loc.paymentId, loc.orderId, loc.organizationId, loc.outletId, loc.menuId,
    );

    const latestSeq = payment.refundSeq ?? 0;
    if (latestSeq === 0) {
      return {kind: "not_retryable", reason: "no_refund"};
    }
    const latestId = refundIdFor(order.id, latestSeq);
    const latestSnap = await tx.get(paymentRef.collection("refunds").doc(latestId));
    if (!latestSnap.exists) {
      return {kind: "not_found"};
    }
    const latest = parseRefund(
      latestSnap.data(), latestId, payment.id, order.id, order.organizationId, order.outletId, order.menuId,
    );
    if (latest.status !== "failed") {
      return {kind: "not_retryable", reason: "latest_not_failed"};
    }
    if (latest.reason === "external") {
      return {kind: "not_retryable", reason: "external_refund"};
    }

    const slot = await readNextRefundSlot(tx, paymentRef, payment);
    // A failed refund flags its payment so a person notices; the retry is that person's answer, so the
    // flag stays only if some OTHER refund (one that is not failed) still needs attention.
    const all = await tx.get(paymentRef.collection("refunds"));
    const stillFlagged = all.docs.some((doc) => doc.get("attentionRequired") === true && doc.get("status") !== "failed");
    const payable = stillFlagged ? payment : {
      ...payment,
      refundState: deriveRefundState(readRefundAggregates(payment), false),
    };
    const plan = planRefundCreation({
      order,
      payment: payable,
      slot,
      reason: latest.reason,
      source: "retry",
      initiatedBy: input.initiatedBy,
      initiatedByRole: input.initiatedByRole,
      now,
    });
    if (plan.kind === "not_refundable") {
      return {kind: "not_refundable", reason: plan.reason};
    }
    if (plan.kind === "nothing_to_refund") {
      return {kind: "nothing_to_refund"};
    }
    tx.create(plan.refundRef, plan.refund);
    recordRefundNotificationEvent(db, tx, plan.refund, "refund_requested", now);
    tx.update(paymentRef, plan.paymentUpdate);
    tx.update(orderRef, {...(plan.mirror ?? {}), updatedAt: now});
    return {kind: "created", refundId: plan.refund.id};
  });
}

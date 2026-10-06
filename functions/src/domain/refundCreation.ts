import {Timestamp, type DocumentReference, type Transaction} from "firebase-admin/firestore";
import type {Order} from "./orders";
import type {Payment} from "./payments";
import {
  assessPaymentRefundability,
  deriveRefundState,
  reserveRefund,
  type PaymentNotRefundableReason,
  type PaymentRefundState,
  type RefundAggregates,
} from "./refundAmounts";
import {
  parseRefund,
  refundIdFor,
  refundIdempotencyKeyFor,
  type Refund,
  type RefundInitiatorRole,
  type RefundReason,
  type RefundSource,
} from "./refunds";

/**
 * Creating a refund INSIDE a Firestore transaction — the persistence half of
 * the 7.2 pure model. A caller (`orderCancellation.ts`'s `cancelOrder`,
 * `payments.ts`'s late-capture handling) owns the transaction; this module
 * only splits what has to happen into the two halves a Firestore transaction
 * needs, and decides every figure with the 7.2 helpers:
 *
 * 1. `readNextRefundSlot` — the READ half. From the payment as the caller read
 *    it, works out the next refund's sequence number, ID and idempotency key
 *    and confirms that document is free. Reads must precede every write in a
 *    transaction, so a caller runs this before staging anything.
 * 2. `planRefundCreation` — pure. From the order, the payment and the slot,
 *    returns every document to write: the refund, the payment's updated
 *    aggregates and the order's refund mirror. Nothing is written here; the
 *    caller stages the writes in ITS transaction, so the refund document, the
 *    payment aggregates, the order mirror and whatever else the caller changes
 *    (the order's cancellation) commit together or not at all.
 *
 * The refund amount is never an input. It is the ENTIRE remaining refundable
 * amount (`captured - refunded - pending`), taken from the payment as read in
 * the same transaction — so two transactions can never both reserve the same
 * money (the second one re-reads and sees it gone).
 *
 * Nothing here calls the provider. A freshly created refund is `requested`,
 * with `submitAttempts: 0`: committed locally and waiting for a later
 * checkpoint's dispatcher.
 */

/** How long after creation the reconciler may pick up a refund nobody has submitted yet. */
export const REFUND_FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;

/** Where the next refund of a payment goes, resolved before any write is staged. */
export interface RefundSlot {
  /** The payment's `refundSeq` after this refund is created. */
  seq: number;
  /** `refundIdFor(orderId, seq)`; also the provider idempotency key. */
  refundId: string;
  refundRef: DocumentReference;
}

/**
 * The READ half. Validates the refund ID — and that it is usable as a provider
 * idempotency key — BEFORE any money is reserved, then reads the refund
 * document to confirm the slot is free.
 *
 * @param {Transaction} tx The in-progress transaction (reads only here).
 * @param {DocumentReference} paymentRef The payment's document reference.
 * @param {Payment} payment The payment as read in `tx`.
 * @return {Promise<RefundSlot>} The slot for the next refund.
 * @throws {Error} If the order ID cannot form a valid refund ID or idempotency
 *   key, or the slot is already taken (`refundSeq` out of step with the stored
 *   refunds — corrupt data, never silently overwritten or skipped over).
 */
export async function readNextRefundSlot(
  tx: Transaction,
  paymentRef: DocumentReference,
  payment: Payment,
): Promise<RefundSlot> {
  const seq = (payment.refundSeq ?? 0) + 1;
  const refundId = refundIdFor(payment.orderId, seq);
  refundIdempotencyKeyFor(refundId);
  const refundRef = paymentRef.collection("refunds").doc(refundId);
  const snapshot = await tx.get(refundRef);
  if (snapshot.exists) {
    throw new Error(
      `Refund ${refundRef.path} already exists although the payment's refundSeq is ${payment.refundSeq ?? 0}.`,
    );
  }
  return {seq, refundId, refundRef};
}

/** What an order stores of its payment's refund figures. */
export interface OrderRefundMirror {
  refundStatus: PaymentRefundState;
  refundedInPaise: number;
}

/**
 * The order-level refund mirror for the given payment figures: `refundStatus`
 * is the payment-level summary (`deriveRefundState`) and `refundedInPaise` the
 * sum of processed refunds. `null` when there is nothing to mirror (state
 * `none`): an order with no refund activity carries no mirror at all, exactly
 * like an order written before refunds existed.
 *
 * @param {RefundAggregates} aggregates The payment's figures AFTER the change.
 * @param {boolean} attentionRequired Whether the payment is flagged for a person.
 * @return {OrderRefundMirror | null} The fields to write, or null.
 */
export function orderRefundMirror(
  aggregates: RefundAggregates,
  attentionRequired: boolean,
): OrderRefundMirror | null {
  const refundStatus = deriveRefundState(aggregates, attentionRequired);
  if (refundStatus === "none") {
    return null;
  }
  return {refundStatus, refundedInPaise: aggregates.refundedInPaise};
}

export interface PlanRefundCreationInput {
  order: Order;
  /**
   * The payment AS IT WILL BE STORED once the caller's transaction commits —
   * `succeeded`, with its provider payment ID. For a late capture that is the
   * payment with the capture applied, which is not yet in Firestore.
   */
  payment: Payment;
  slot: RefundSlot;
  reason: RefundReason;
  source: RefundSource;
  /** A user's Descope ID, or `REFUND_SYSTEM_INITIATOR`. */
  initiatedBy: string;
  initiatedByRole: RefundInitiatorRole;
  now: Timestamp;
}

export type RefundCreationPlan =
  | {kind: "not_refundable"; reason: PaymentNotRefundableReason}
  | {
    /** Everything captured is already refunded or reserved: nothing for a new refund to take. */
    kind: "nothing_to_refund";
    mirror: OrderRefundMirror | null;
  }
  | {
    kind: "create";
    refund: Refund;
    refundRef: DocumentReference;
    /** The payment fields to merge into the payment document. */
    paymentUpdate: Partial<Payment>;
    mirror: OrderRefundMirror | null;
  };

/**
 * Plans the refund of the whole remaining refundable amount. Pure.
 *
 * - The payment must be refundable (`assessPaymentRefundability`: succeeded,
 *   INR, a provider payment ID, consistent amounts) and its amount must equal
 *   the order's total; otherwise `not_refundable`. A caller refuses rather than
 *   cancelling, or confirming, on a guess.
 * - Remaining 0: `nothing_to_refund`.
 * - Otherwise the amount is reserved with `reserveRefund` and the payment's
 *   aggregates, `refundSeq` and `refundState` are written explicitly (a legacy
 *   payment's implicit figures become stored ones, with the same values).
 *
 * @param {PlanRefundCreationInput} input The facts, as read in the transaction.
 * @return {RefundCreationPlan} What to write, or why nothing can be.
 */
export function planRefundCreation(input: PlanRefundCreationInput): RefundCreationPlan {
  const {order, payment, slot, now} = input;

  if (payment.amountInPaise !== order.totalInPaise) {
    return {kind: "not_refundable", reason: "invalid_amounts"};
  }
  const refundability = assessPaymentRefundability(payment);
  if (refundability.kind === "not_refundable") {
    return {kind: "not_refundable", reason: refundability.reason};
  }

  const attentionRequired = payment.refundState === "attention_required";
  const {aggregates, remainingInPaise, providerPaymentId} = refundability;
  if (remainingInPaise === 0) {
    return {kind: "nothing_to_refund", mirror: orderRefundMirror(aggregates, attentionRequired)};
  }

  const idempotencyKey = refundIdempotencyKeyFor(slot.refundId);
  const reserved = reserveRefund(aggregates, remainingInPaise);

  const refund: Refund = {
    id: slot.refundId,
    paymentId: payment.id,
    orderId: order.id,
    organizationId: order.organizationId,
    outletId: order.outletId,
    menuId: order.menuId,
    userId: order.userId,
    providerPaymentId,
    amountInPaise: remainingInPaise,
    currency: "INR",
    status: "requested",
    reason: input.reason,
    source: input.source,
    initiatedBy: input.initiatedBy,
    initiatedByRole: input.initiatedByRole,
    idempotencyKey,
    submitAttempts: 0,
    createdAt: now,
    updatedAt: now,
    // A safety net, not a schedule: the creation trigger submits at once, and if it never
    // fires (or dies after claiming) the reconciler finds the refund here (see refundSubmission.ts).
    nextAttemptAt: Timestamp.fromMillis(now.toMillis() + REFUND_FIRST_SWEEP_DELAY_MS),
    attentionRequired: false,
  };
  // Never written if it does not read back as a valid refund of this payment.
  parseRefund(refund, refund.id, payment.id, order.id, order.organizationId, order.outletId, order.menuId);

  return {
    kind: "create",
    refund,
    refundRef: slot.refundRef,
    paymentUpdate: {
      capturedAmountInPaise: reserved.capturedInPaise,
      refundedAmountInPaise: reserved.refundedInPaise,
      refundPendingInPaise: reserved.refundPendingInPaise,
      refundSeq: slot.seq,
      refundState: deriveRefundState(reserved, attentionRequired),
      updatedAt: now,
    },
    mirror: orderRefundMirror(reserved, attentionRequired),
  };
}

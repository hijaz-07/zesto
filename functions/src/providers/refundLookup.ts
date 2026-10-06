import type {ProviderRefund} from "./refundGateway";

/**
 * Lost-response recovery, as a pure function: given the refunds the provider
 * lists for a payment, decide whether one of them IS Zesto's refund.
 *
 * It exists because a refund request can be accepted by the provider while its
 * answer never reaches Zesto. The caller (a later checkpoint's refund saga) then
 * lists the payment's refunds with `RefundProviderGateway.listPaymentRefunds` and
 * asks this function — and only if the answer is `none` may it consider sending
 * another request (with the SAME idempotency key). Nothing here calls a provider
 * or writes anything.
 *
 * Matching uses only DETERMINISTIC identifiers, strongest first:
 * 1. the provider refund ID, when Zesto already learned it;
 * 2. the Zesto refund ID Zesto itself put in the refund's `receipt` or `notes`.
 * Amount is NEVER enough to claim a refund: refunds of the same amount on one
 * payment are indistinguishable. A same-amount refund that carries no Zesto
 * identifier is reported only as `unattributedSameAmount` evidence (it may be a
 * refund made by hand in the Razorpay dashboard), never adopted.
 */

export interface RefundLookupCriteria {
  /** The payment the refund belongs to. */
  providerPaymentId: string;
  /** Zesto's deterministic refund ID (`${orderId}-r${seq}`) — what it sent as receipt and in notes. */
  zestoRefundId: string;
  /** The provider's refund ID, if Zesto already knows it. */
  providerRefundId?: string;
  /** The amount Zesto asked to refund (used for secondary evidence only). */
  amountInPaise: number;
}

export type RefundLookupResult =
  /** Exactly one provider refund is Zesto's: adopt it. */
  | {kind: "matched"; refund: ProviderRefund; matchedBy: "provider_refund_id" | "zesto_refund_id"}
  /** No refund is Zesto's. Safe to consider a new submission, subject to the saga's own rules. */
  | {kind: "none"; unattributedSameAmount: ProviderRefund[]}
  /**
   * Zesto's identifiers point at DIFFERENT provider refunds (or contradict the known
   * provider ID). Never adopt one: this is an anomaly for a human.
   */
  | {kind: "conflict"; refunds: ProviderRefund[]};

/**
 * @param {ProviderRefund} refund A provider refund.
 * @param {string} zestoRefundId Zesto's refund ID.
 * @return {boolean} Whether the refund carries Zesto's ID as its receipt or note.
 */
function carriesZestoId(refund: ProviderRefund, zestoRefundId: string): boolean {
  return refund.receipt === zestoRefundId || refund.notes.zestoRefundId === zestoRefundId;
}

/**
 * @param {ProviderRefund} refund A provider refund.
 * @return {boolean} Whether the refund carries ANY Zesto identifier.
 */
function carriesAnyZestoId(refund: ProviderRefund): boolean {
  return refund.notes.zestoRefundId !== undefined || refund.notes.zestoOrderId !== undefined;
}

/**
 * @param {readonly ProviderRefund[]} refunds Every refund the provider lists for the payment.
 * @param {RefundLookupCriteria} criteria What identifies Zesto's refund.
 * @return {RefundLookupResult} The match, none, or a conflict.
 */
export function findMatchingProviderRefund(
  refunds: readonly ProviderRefund[], criteria: RefundLookupCriteria,
): RefundLookupResult {
  const ofPayment = refunds.filter((refund) => refund.providerPaymentId === criteria.providerPaymentId);

  if (criteria.providerRefundId !== undefined) {
    const known = ofPayment.find((refund) => refund.id === criteria.providerRefundId);
    if (known) {
      // Zesto's identifiers on a refund Zesto already knows must not point elsewhere.
      const taggedForAnother = [known.receipt, known.notes.zestoRefundId]
        .some((value) => value !== undefined && value !== criteria.zestoRefundId);
      if (taggedForAnother) {
        return {kind: "conflict", refunds: [known]};
      }
      return {kind: "matched", refund: known, matchedBy: "provider_refund_id"};
    }
    // The ID Zesto holds is not in the list: do not fall through to other evidence.
    return {kind: "conflict", refunds: []};
  }

  const tagged = ofPayment.filter((refund) => carriesZestoId(refund, criteria.zestoRefundId));
  if (tagged.length === 1) {
    return {kind: "matched", refund: tagged[0], matchedBy: "zesto_refund_id"};
  }
  if (tagged.length > 1) {
    return {kind: "conflict", refunds: tagged};
  }

  return {
    kind: "none",
    unattributedSameAmount: ofPayment.filter((refund) =>
      refund.amountInPaise === criteria.amountInPaise && !carriesAnyZestoId(refund) && refund.receipt === undefined),
  };
}

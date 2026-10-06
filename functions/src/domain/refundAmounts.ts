/**
 * Refund MONEY arithmetic — pure, integer paise only, no Firestore, no provider.
 *
 * Every function here works on whole minor units (paise). A value that is not
 * a safe integer — a fraction, `NaN`, `Infinity`, an integer past
 * `Number.MAX_SAFE_INTEGER`, a non-number — is rejected, never rounded or
 * clamped, so floating-point drift cannot turn into over-refunded money.
 *
 * The model (root `payments/{paymentId}` aggregates, kept by a later
 * transactional layer in the same transaction as every refund state change):
 *
 * - `captured`       C — what the provider captured. Equals the payment's
 *                    `amountInPaise` for a `succeeded` payment; 0 otherwise.
 * - `refunded`       R — the sum of refunds that reached `processed`.
 * - `refundPending`  P — the sum of refunds that are `requested` or `pending`
 *                    (money already promised to a refund, not yet settled).
 * - `remaining`      C - R - P — what a NEW refund may still take.
 *
 * Invariants (see `refundAggregatesProblem`): `R >= 0`, `P >= 0`,
 * `R + P <= C`. A new refund of `a` needs `1 <= a <= C - R - P`
 * (`checkNewRefundAmount`). A refund amount is never read from a client: the
 * v1 cancellation refund is the whole remaining amount, computed by the server
 * (`remainingRefundableInPaise`).
 *
 * Legacy payments. Payment documents written before refunds existed have no
 * aggregate fields. They are read as: `succeeded` with no
 * `capturedAmountInPaise` -> captured is `amountInPaise`; missing `refunded`/
 * `refundPending` -> 0 (see `readRefundAggregates`). No migration is needed.
 */

/** The payment-level refund summary, derived from the aggregates (see `deriveRefundState`). */
export const PAYMENT_REFUND_STATE_VALUES = [
  "none", "in_progress", "partially_refunded", "refunded", "attention_required",
] as const;
export type PaymentRefundState = (typeof PAYMENT_REFUND_STATE_VALUES)[number];

export type RefundAmountErrorCode =
  | "not_minor_units"
  | "invalid_aggregates"
  | "not_positive"
  | "nothing_refundable"
  | "exceeds_remaining"
  | "insufficient_pending";

/** A money invariant was violated. A programming or data error, never retryable as-is. */
export class RefundAmountError extends Error {
  /**
   * @param {RefundAmountErrorCode} code Which invariant failed.
   * @param {string} message What is wrong (never contains secrets).
   */
  constructor(public readonly code: RefundAmountErrorCode, message: string) {
    super(message);
    this.name = "RefundAmountError";
  }
}

/**
 * @param {unknown} value A candidate stored amount.
 * @return {boolean} Whether it is a non-negative whole number of paise within
 *   the safe-integer range (`-0` is not accepted).
 */
export function isMinorUnits(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0);
}

/** The three stored figures a payment's refund accounting is made of. */
export interface RefundAggregates {
  capturedInPaise: number;
  refundedInPaise: number;
  refundPendingInPaise: number;
}

/**
 * The payment fields these helpers read — structural, so the module depends on
 * no payment type (and `payments.ts` can depend on it).
 */
export interface PaymentAmountFields {
  status: "pending" | "succeeded" | "failed";
  amountInPaise: number;
  capturedAmountInPaise?: number;
  refundedAmountInPaise?: number;
  refundPendingInPaise?: number;
}

/**
 * @param {RefundAggregates} aggregates The figures to check.
 * @return {RefundAmountErrorCode | null} `not_minor_units` if any figure is not
 *   a whole non-negative safe number of paise, `invalid_aggregates` if
 *   `refunded + pending` exceeds `captured`; `null` if the figures are valid.
 */
export function refundAggregatesProblem(aggregates: RefundAggregates): RefundAmountErrorCode | null {
  const {capturedInPaise, refundedInPaise, refundPendingInPaise} = aggregates;
  if (!isMinorUnits(capturedInPaise) || !isMinorUnits(refundedInPaise) || !isMinorUnits(refundPendingInPaise)) {
    return "not_minor_units";
  }
  // Each is a safe integer, but the sum of two could still leave the safe
  // range; comparing against `captured` first keeps that sum meaningful.
  if (refundedInPaise > capturedInPaise || refundPendingInPaise > capturedInPaise) {
    return "invalid_aggregates";
  }
  if (refundedInPaise + refundPendingInPaise > capturedInPaise) {
    return "invalid_aggregates";
  }
  return null;
}

/**
 * @param {RefundAggregates} aggregates The figures to check.
 * @throws {RefundAmountError} If `refundAggregatesProblem` finds one.
 */
export function assertRefundAggregates(aggregates: RefundAggregates): void {
  const problem = refundAggregatesProblem(aggregates);
  if (problem !== null) {
    throw new RefundAmountError(problem, "The payment's refund amounts are not consistent.");
  }
}

/**
 * The amount the provider captured for a payment.
 *
 * - `succeeded`, with `capturedAmountInPaise` stored: that figure.
 * - `succeeded`, without it (a payment from before refunds existed): the
 *   payment's own `amountInPaise`.
 * - `pending` or `failed`: 0 — nothing was captured, so nothing can be refunded.
 *
 * @param {PaymentAmountFields} payment The payment's amount fields.
 * @return {number} The captured amount in paise.
 * @throws {RefundAmountError} `not_minor_units` if the stored figure is unsafe.
 */
export function capturedAmountInPaise(payment: PaymentAmountFields): number {
  if (payment.status !== "succeeded") {
    return 0;
  }
  const captured = payment.capturedAmountInPaise ?? payment.amountInPaise;
  if (!isMinorUnits(captured)) {
    throw new RefundAmountError("not_minor_units", "The payment's captured amount is not a whole number of paise.");
  }
  return captured;
}

/**
 * Reads and validates a payment's refund figures (legacy-safe, see the module
 * comment).
 *
 * @param {PaymentAmountFields} payment The payment's amount fields.
 * @return {RefundAggregates} The validated figures.
 * @throws {RefundAmountError} If any figure is unsafe or the invariants fail.
 */
export function readRefundAggregates(payment: PaymentAmountFields): RefundAggregates {
  const aggregates: RefundAggregates = {
    capturedInPaise: capturedAmountInPaise(payment),
    refundedInPaise: payment.refundedAmountInPaise ?? 0,
    refundPendingInPaise: payment.refundPendingInPaise ?? 0,
  };
  assertRefundAggregates(aggregates);
  return aggregates;
}

/**
 * @param {RefundAggregates} aggregates The payment's refund figures.
 * @return {number} `captured - refunded - pending`: what a new refund may still
 *   take. For a v1 cancellation this IS the refund amount (the full eligible
 *   amount); a client never supplies one.
 * @throws {RefundAmountError} If the figures are invalid.
 */
export function remainingRefundableInPaise(aggregates: RefundAggregates): number {
  assertRefundAggregates(aggregates);
  return aggregates.capturedInPaise - aggregates.refundedInPaise - aggregates.refundPendingInPaise;
}

export type NewRefundAmountCheck =
  | {ok: true; remainingAfterInPaise: number}
  | {ok: false; code: "not_minor_units" | "invalid_aggregates" | "not_positive" | "nothing_refundable" | "exceeds_remaining"};

/**
 * Whether a new refund of `amountInPaise` may be created against `aggregates`:
 * `1 <= amount <= remaining`. Never throws.
 *
 * @param {RefundAggregates} aggregates The payment's refund figures.
 * @param {unknown} amountInPaise The proposed refund amount.
 * @return {NewRefundAmountCheck} `ok` with what would remain, or why not.
 */
export function checkNewRefundAmount(
  aggregates: RefundAggregates,
  amountInPaise: unknown,
): NewRefundAmountCheck {
  const problem = refundAggregatesProblem(aggregates);
  if (problem !== null) {
    return {ok: false, code: problem === "not_minor_units" ? "not_minor_units" : "invalid_aggregates"};
  }
  if (typeof amountInPaise !== "number" || !Number.isSafeInteger(amountInPaise)) {
    return {ok: false, code: "not_minor_units"};
  }
  if (amountInPaise < 1) {
    return {ok: false, code: "not_positive"};
  }
  const remaining = aggregates.capturedInPaise - aggregates.refundedInPaise - aggregates.refundPendingInPaise;
  if (remaining === 0) {
    return {ok: false, code: "nothing_refundable"};
  }
  if (amountInPaise > remaining) {
    return {ok: false, code: "exceeds_remaining"};
  }
  return {ok: true, remainingAfterInPaise: remaining - amountInPaise};
}

/**
 * Reserves a new refund: `pending += amount`, after `checkNewRefundAmount`.
 *
 * @param {RefundAggregates} aggregates The payment's refund figures.
 * @param {unknown} amountInPaise The refund amount to reserve.
 * @return {RefundAggregates} The figures with the amount reserved.
 * @throws {RefundAmountError} With the check's code if the amount is not allowed.
 */
export function reserveRefund(aggregates: RefundAggregates, amountInPaise: unknown): RefundAggregates {
  const check = checkNewRefundAmount(aggregates, amountInPaise);
  if (!check.ok) {
    throw new RefundAmountError(check.code, `This refund amount is not allowed (${check.code}).`);
  }
  return {...aggregates, refundPendingInPaise: aggregates.refundPendingInPaise + (amountInPaise as number)};
}

/**
 * @param {RefundAggregates} aggregates The payment's refund figures.
 * @param {number} amountInPaise The amount of the refund being settled or released.
 * @throws {RefundAmountError} If the figures are invalid, the amount is not a
 *   positive whole number, or more than is pending.
 */
function assertSettleable(aggregates: RefundAggregates, amountInPaise: number): void {
  assertRefundAggregates(aggregates);
  if (!Number.isSafeInteger(amountInPaise)) {
    throw new RefundAmountError("not_minor_units", "The refund amount is not a whole number of paise.");
  }
  if (amountInPaise < 1) {
    throw new RefundAmountError("not_positive", "The refund amount must be at least 1 paisa.");
  }
  if (amountInPaise > aggregates.refundPendingInPaise) {
    throw new RefundAmountError("insufficient_pending", "The refund amount exceeds what is pending.");
  }
}

/**
 * A reserved refund reached `processed`: `pending -= amount`, `refunded += amount`.
 * `refunded + pending` is unchanged, so it cannot break the invariant.
 *
 * @param {RefundAggregates} aggregates The payment's refund figures.
 * @param {number} amountInPaise The processed refund's amount.
 * @return {RefundAggregates} The figures after settling.
 * @throws {RefundAmountError} See `assertSettleable`.
 */
export function settleProcessedRefund(aggregates: RefundAggregates, amountInPaise: number): RefundAggregates {
  assertSettleable(aggregates, amountInPaise);
  return {
    ...aggregates,
    refundedInPaise: aggregates.refundedInPaise + amountInPaise,
    refundPendingInPaise: aggregates.refundPendingInPaise - amountInPaise,
  };
}

/**
 * A reserved refund reached `failed`: `pending -= amount`, giving the money back
 * to `remaining` (a failed refund moved nothing).
 *
 * @param {RefundAggregates} aggregates The payment's refund figures.
 * @param {number} amountInPaise The failed refund's amount.
 * @return {RefundAggregates} The figures after releasing.
 * @throws {RefundAmountError} See `assertSettleable`.
 */
export function releaseFailedRefund(aggregates: RefundAggregates, amountInPaise: number): RefundAggregates {
  assertSettleable(aggregates, amountInPaise);
  return {...aggregates, refundPendingInPaise: aggregates.refundPendingInPaise - amountInPaise};
}

/**
 * The payment-level summary for the figures. Priority: an anomaly flag, then
 * fully refunded, then anything in flight, then partly refunded, else none.
 *
 * @param {RefundAggregates} aggregates The payment's refund figures.
 * @param {boolean} [attentionRequired] Whether any refund of this payment is
 *   flagged for a human (an anomaly the amounts alone cannot show).
 * @return {PaymentRefundState} The summary state.
 * @throws {RefundAmountError} If the figures are invalid.
 */
export function deriveRefundState(
  aggregates: RefundAggregates,
  attentionRequired = false,
): PaymentRefundState {
  assertRefundAggregates(aggregates);
  if (attentionRequired) {
    return "attention_required";
  }
  if (aggregates.capturedInPaise > 0 &&
    aggregates.refundedInPaise === aggregates.capturedInPaise) {
    return "refunded";
  }
  if (aggregates.refundPendingInPaise > 0) {
    return "in_progress";
  }
  if (aggregates.refundedInPaise > 0) {
    return "partially_refunded";
  }
  return "none";
}

/** Facts about a payment document needed to decide whether it can be refunded. */
export interface PaymentRefundFacts extends PaymentAmountFields {
  currency: string;
  providerPaymentId?: string;
}

export type PaymentNotRefundableReason =
  | "payment_not_succeeded"
  | "unsupported_currency"
  | "missing_provider_payment_id"
  | "invalid_amounts";

export type PaymentRefundability =
  | {
    kind: "refundable";
    providerPaymentId: string;
    currency: "INR";
    aggregates: RefundAggregates;
    remainingInPaise: number;
  }
  | {kind: "not_refundable"; reason: PaymentNotRefundableReason};

/**
 * Interprets a payment document — including a legacy one — for refunding.
 * Never throws.
 *
 * - `pending` / `failed`: not refundable (`payment_not_succeeded`); nothing was
 *   captured.
 * - A currency other than `INR`: `unsupported_currency` (v1 is INR only).
 * - `succeeded` but no provider payment ID: `missing_provider_payment_id`. The
 *   provider cannot be asked to refund a payment Zesto cannot name; such a
 *   payment needs a person.
 * - Unsafe or inconsistent figures: `invalid_amounts`.
 * - Otherwise refundable, with the legacy-safe aggregates and what remains
 *   (which may be 0: fully refunded or fully reserved is still "refundable"
 *   as a payment, with nothing left to refund — see `checkNewRefundAmount`).
 *
 * @param {PaymentRefundFacts} payment The payment's refund-relevant fields.
 * @return {PaymentRefundability} The interpretation.
 */
export function assessPaymentRefundability(payment: PaymentRefundFacts): PaymentRefundability {
  if (payment.status !== "succeeded") {
    return {kind: "not_refundable", reason: "payment_not_succeeded"};
  }
  if (payment.currency !== "INR") {
    return {kind: "not_refundable", reason: "unsupported_currency"};
  }
  if (payment.providerPaymentId === undefined || payment.providerPaymentId.length === 0) {
    return {kind: "not_refundable", reason: "missing_provider_payment_id"};
  }
  try {
    const aggregates = readRefundAggregates(payment);
    return {
      kind: "refundable",
      providerPaymentId: payment.providerPaymentId,
      currency: "INR",
      aggregates,
      remainingInPaise: remainingRefundableInPaise(aggregates),
    };
  } catch (error) {
    if (error instanceof RefundAmountError) {
      return {kind: "not_refundable", reason: "invalid_amounts"};
    }
    throw error;
  }
}

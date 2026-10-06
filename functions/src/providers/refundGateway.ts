/**
 * The provider-neutral REFUND contract — types and error classes only.
 *
 * This is the capability the refund layer (a later checkpoint) will depend on
 * instead of any provider SDK, the same way `domain/payments.ts` depends on
 * `PaymentProviderGateway` rather than Razorpay. NOTHING here talks to a
 * provider: no HTTP, no SDK import, no secret. The real implementation is
 * `razorpayRefunds.ts`; `refundGateway.fake.ts` is the deterministic test double
 * the pure and emulator tests use.
 *
 * It is deliberately a SEPARATE interface from `PaymentProviderGateway`, not an
 * extension of it: adding methods there would force every existing gateway
 * (including the SDK-backed one) to implement them.
 *
 * The contract is shaped by one danger: a refund request the provider ACCEPTED
 * but whose response never reached Zesto. So a call can end in one of five ways,
 * and the four failures are different types on purpose (each carries a
 * `category` and `mayHaveBeenApplied`):
 * - it resolves: the provider's answer;
 * - `ProviderRefundRejectedError` (DEFINITIVE_FAILURE): the provider DEFINITIVELY
 *   refused — nothing was created, so the refund may be marked failed;
 * - `ProviderRetryableError` (RETRYABLE_FAILURE): 429 / 5xx / "try again" — the
 *   same request may be repeated, but if `mayHaveBeenApplied` the caller must
 *   look the refund up first;
 * - `ProviderOutcomeUnknownError` (AMBIGUOUS): a timeout, a dropped connection, an
 *   unreadable answer, a duplicate-receipt answer — the request may or may not
 *   have been applied. It is NEVER evidence of failure; the caller must look the
 *   refund up before ever asking again;
 * - `ProviderConfigurationError` (AUTH_CONFIGURATION): missing or rejected
 *   credentials — an operator problem, not a statement about the refund.
 *
 * The gateway never retries by itself: retrying is the caller's decision.
 */

/** The provider's refund status. */
export type ProviderRefundState = "pending" | "processed" | "failed";

/** A provider refund, reduced to what Zesto needs (never a raw SDK object). */
export interface ProviderRefund {
  id: string;
  providerPaymentId: string;
  amountInPaise: number;
  currency: string;
  status: ProviderRefundState;
  /** Echoed from the request — how Zesto finds its own refund in a lookup. */
  receipt?: string;
  /** Echoed from the request. */
  notes: Readonly<Record<string, string>>;
  speedRequested?: "normal" | "optimum";
  speedProcessed?: "normal" | "instant";
  createdAtEpochSeconds?: number;
}

/**
 * The refund request. `speed` is the literal `"normal"`: the approved flow is the
 * provider's normal refund, so the type does not even allow another value.
 * `notes` carry only Zesto's own identifiers — never anything about the customer.
 */
export interface CreateProviderRefundInput {
  providerPaymentId: string;
  amountInPaise: number;
  speed: "normal";
  /** Sent as the provider's idempotency key: repeating it can never refund twice. */
  idempotencyKey: string;
  receipt: string;
  notes: {zestoRefundId: string; zestoOrderId: string};
}

/** The provider's payment status, as far as refunds need it. */
export type ProviderPaymentState = "created" | "authorized" | "captured" | "refunded" | "failed";

/** A provider payment, reduced to what Zesto needs. */
export interface ProviderPayment {
  id: string;
  /** The provider order it belongs to; null if it has none. */
  providerOrderId: string | null;
  amountInPaise: number;
  currency: string;
  status: ProviderPaymentState;
  /** Whether the provider has captured the money (`true` also for a fully refunded payment). */
  captured: boolean;
  /** Total the provider has refunded (or is refunding) against this payment. */
  amountRefundedInPaise: number;
}

export interface RefundProviderGateway {
  /** Asks the provider to refund part or all of a captured payment. */
  createRefund(input: CreateProviderRefundInput): Promise<ProviderRefund>;
  /** Reads one refund, by the provider's ID. */
  fetchRefund(providerRefundId: string): Promise<ProviderRefund>;
  /** Lists EVERY refund the provider holds for a payment (to find one whose response was lost). */
  listPaymentRefunds(providerPaymentId: string): Promise<ProviderRefund[]>;
  /** Reads a payment. */
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
}

/**
 * The four ways a provider call can fail, kept distinct so the refund saga can
 * react to each differently (see the file header).
 */
export type ProviderFailureCategory =
  "DEFINITIVE_FAILURE" | "RETRYABLE_FAILURE" | "AMBIGUOUS" | "AUTH_CONFIGURATION";

/** What every provider failure carries (an `Error` with these fields). */
export interface ProviderFailureDetails {
  readonly category: ProviderFailureCategory;
  /** A short, non-sensitive code: the provider's own, or one of ours (`timeout`, `network_error`, …). */
  readonly code: string;
  /** The HTTP status, when an HTTP response was received. */
  readonly httpStatus?: number;
  /**
   * Whether the provider may have acted on the request despite the failure.
   * When true the caller MUST look the refund up before sending it again.
   */
  readonly mayHaveBeenApplied: boolean;
}

/**
 * The provider definitively refused the request: nothing was created and
 * repeating it unchanged will refuse again. Safe to record the refund as failed.
 * `code` is the provider's own short, non-sensitive code.
 */
export class ProviderRefundRejectedError extends Error implements ProviderFailureDetails {
  readonly kind = "rejected" as const;
  readonly category = "DEFINITIVE_FAILURE" as const;
  readonly mayHaveBeenApplied = false;

  /**
   * @param {string} code The provider's short error code.
   * @param {string} message A safe description (never the raw provider payload).
   * @param {number} [httpStatus] The HTTP status, if one was received.
   */
  constructor(public readonly code: string, message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = "ProviderRefundRejectedError";
  }
}

/**
 * The outcome is unknown: a timeout, a dropped connection, an unreadable answer,
 * a "still in progress" or "duplicate receipt" answer. The request may have been
 * applied. This is never grounds to mark a refund failed or to send it again blind.
 */
export class ProviderOutcomeUnknownError extends Error implements ProviderFailureDetails {
  readonly kind = "unknown" as const;
  readonly category = "AMBIGUOUS" as const;
  readonly mayHaveBeenApplied = true;

  /**
   * @param {string} message A safe description (never the raw provider payload).
   * @param {string} [code] A short, non-sensitive code.
   * @param {number} [httpStatus] The HTTP status, if one was received.
   */
  constructor(
    message: string,
    public readonly code: string = "outcome_unknown",
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderOutcomeUnknownError";
  }
}

/**
 * The provider (or the network path to it) is temporarily unable to serve the
 * request: HTTP 429, 5xx, or "try again". The same request may be repeated later
 * — with the SAME idempotency key — but where `mayHaveBeenApplied` (a 5xx on a
 * write) the refund must be looked up first.
 */
export class ProviderRetryableError extends Error implements ProviderFailureDetails {
  readonly kind = "retryable" as const;
  readonly category = "RETRYABLE_FAILURE" as const;
  readonly httpStatus?: number;
  readonly mayHaveBeenApplied: boolean;

  /**
   * @param {string} code A short, non-sensitive code.
   * @param {string} message A safe description (never the raw provider payload).
   * @param {{httpStatus?: number, mayHaveBeenApplied: boolean}} details What is known of the attempt.
   */
  constructor(
    public readonly code: string,
    message: string,
    details: {httpStatus?: number; mayHaveBeenApplied: boolean},
  ) {
    super(message);
    this.name = "ProviderRetryableError";
    this.httpStatus = details.httpStatus;
    this.mayHaveBeenApplied = details.mayHaveBeenApplied;
  }
}

/**
 * Credentials are missing or the provider rejected them (401/403). An operator
 * must fix the configuration; it says nothing about the refund itself, so it
 * must never mark a refund failed.
 */
export class ProviderConfigurationError extends Error implements ProviderFailureDetails {
  readonly kind = "configuration" as const;
  readonly category = "AUTH_CONFIGURATION" as const;
  readonly mayHaveBeenApplied = false;

  /**
   * @param {string} code A short, non-sensitive code.
   * @param {string} message A safe description (never a credential).
   * @param {number} [httpStatus] The HTTP status, if one was received.
   */
  constructor(public readonly code: string, message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

/** Any provider failure the gateway can throw. */
export type RefundProviderError =
  ProviderRefundRejectedError | ProviderOutcomeUnknownError | ProviderRetryableError | ProviderConfigurationError;

/**
 * @param {unknown} error Anything thrown.
 * @return {boolean} Whether it is one of the gateway's typed provider failures.
 */
export function isRefundProviderError(error: unknown): error is RefundProviderError {
  return error instanceof ProviderRefundRejectedError ||
    error instanceof ProviderOutcomeUnknownError ||
    error instanceof ProviderRetryableError ||
    error instanceof ProviderConfigurationError;
}

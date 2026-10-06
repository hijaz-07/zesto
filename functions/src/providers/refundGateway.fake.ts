import {
  ProviderConfigurationError,
  ProviderOutcomeUnknownError,
  ProviderRefundRejectedError,
  ProviderRetryableError,
  type CreateProviderRefundInput,
  type ProviderPayment,
  type ProviderRefund,
  type ProviderRefundState,
  type RefundProviderGateway,
} from "./refundGateway";

/**
 * A deterministic, in-memory `RefundProviderGateway` for tests — never shipped
 * (excluded from the build, see `tsconfig.json`) and never talking to anything.
 *
 * It behaves like a strict provider so a test fails the way production would:
 * - a refund needs a `captured` payment, a whole-paise amount of at least 1, and
 *   fits within what has not been refunded (a `failed` refund frees its amount);
 * - the idempotency key must be 10+ characters of `A-Za-z0-9_-`; the same key
 *   with the same request replays the original refund, and with a DIFFERENT
 *   request is rejected (`idempotency_conflict`);
 * - refund IDs are `rfnd_fake_1`, `rfnd_fake_2`, … in creation order.
 *
 * Faults are scripted per call with `script(method, ...behaviours)`; each
 * behaviour is used once, in order, then calls behave normally:
 * - `"unknown_before_apply"`: throws `ProviderOutcomeUnknownError`; nothing happened;
 * - `"unknown_after_apply"`: APPLIES the request, then throws
 *   `ProviderOutcomeUnknownError` — the response-lost case;
 * - `{unknown: "timeout" | "connection_reset" | "malformed_response", applied}`: the same
 *   two, with the cause as the error's code (a malformed answer is only ever seen
 *   after the provider acted, so it is usually scripted with `applied: true`);
 * - `{rejectWith: code}`: throws `ProviderRefundRejectedError` (DEFINITIVE_FAILURE);
 * - `"rate_limited"`: throws `ProviderRetryableError`; nothing happened (HTTP 429);
 * - `"server_error"` / `"server_error_after_apply"`: throws `ProviderRetryableError`
 *   with `mayHaveBeenApplied` (HTTP 5xx), without / after applying the request;
 * - `"auth_failure"`: throws `ProviderConfigurationError`.
 *
 * `nextRefundStatus(...)` makes the next created refunds come back `processed`
 * (or `failed`) at once instead of `pending`.
 */

export type FakeFault =
  | "unknown_before_apply"
  | "unknown_after_apply"
  | {unknown: "timeout" | "connection_reset" | "malformed_response"; applied: boolean}
  | {rejectWith: string}
  | "rate_limited"
  | "server_error"
  | "server_error_after_apply"
  | "auth_failure";
export type FakeGatewayMethod = "createRefund" | "fetchRefund" | "listPaymentRefunds" | "fetchPayment";

export interface FakeGatewayCall {
  method: FakeGatewayMethod;
  input: unknown;
}

export interface FakeRefundGateway extends RefundProviderGateway {
  /** Registers a payment the fake provider knows (default: `captured`). */
  addPayment(payment: Omit<ProviderPayment, "status" | "captured" | "amountRefundedInPaise"> &
    Partial<Pick<ProviderPayment, "status">>): void;
  /** Queues faults for the next calls to `method`. */
  script(method: FakeGatewayMethod, ...faults: FakeFault[]): void;
  /** Queues the status the next created refunds come back with (default `pending`). */
  nextRefundStatus(...statuses: ProviderRefundState[]): void;
  /** Moves a refund to a terminal status, as the provider would later (and, for `failed`, frees its amount). */
  settleRefund(providerRefundId: string, status: Exclude<ProviderRefundState, "pending">): void;
  /** Every call made, in order — including those that were then made to fail. */
  readonly calls: readonly FakeGatewayCall[];
  /** A snapshot of every refund the fake provider holds. */
  refunds(): ProviderRefund[];
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

/**
 * @return {FakeRefundGateway} A fresh fake with no payments and no faults.
 */
export function createFakeRefundGateway(): FakeRefundGateway {
  const payments = new Map<string, ProviderPayment>();
  const refundsById = new Map<string, ProviderRefund>();
  const byIdempotencyKey = new Map<string, {fingerprint: string; refundId: string}>();
  const faults = new Map<FakeGatewayMethod, FakeFault[]>();
  const calls: FakeGatewayCall[] = [];
  const nextStatuses: ProviderRefundState[] = [];
  let sequence = 0;

  /**
   * @param {FakeGatewayMethod} method The method being called.
   * @param {unknown} input Its input, recorded.
   * @return {FakeFault | undefined} The next scripted fault for it, if any.
   */
  function begin(method: FakeGatewayMethod, input: unknown): FakeFault | undefined {
    calls.push({method, input});
    return faults.get(method)?.shift();
  }

  /**
   * @param {FakeFault | undefined} fault The fault being applied.
   * @param {() => T} apply The real behaviour.
   * @return {T} What `apply` returned, unless the fault intervenes.
   * @template T
   */
  function withFault<T>(fault: FakeFault | undefined, apply: () => T): T {
    if (fault === undefined) {
      return apply();
    }
    if (fault === "unknown_before_apply") {
      throw new ProviderOutcomeUnknownError("The fake provider did not answer.");
    }
    if (fault === "unknown_after_apply") {
      apply();
      throw new ProviderOutcomeUnknownError("The fake provider's answer was lost.");
    }
    if (fault === "rate_limited") {
      throw new ProviderRetryableError("rate_limited", "The fake provider is rate limiting.", {
        httpStatus: 429, mayHaveBeenApplied: false,
      });
    }
    if (fault === "server_error" || fault === "server_error_after_apply") {
      if (fault === "server_error_after_apply") {
        apply();
      }
      throw new ProviderRetryableError("provider_server_error", "The fake provider failed.", {
        httpStatus: 500, mayHaveBeenApplied: true,
      });
    }
    if (fault === "auth_failure") {
      throw new ProviderConfigurationError("provider_auth_rejected", "The fake provider rejected the credentials.", 401);
    }
    if ("unknown" in fault) {
      if (fault.applied) {
        apply();
      }
      throw new ProviderOutcomeUnknownError(`The fake provider's answer was lost (${fault.unknown}).`, fault.unknown);
    }
    throw new ProviderRefundRejectedError(fault.rejectWith, "The fake provider refused the request.");
  }

  /**
   * @param {string} providerPaymentId A payment ID.
   * @return {number} What a new refund may still take: the payment's amount less
   *   every refund that is not `failed`.
   */
  function refundable(providerPaymentId: string): number {
    const payment = payments.get(providerPaymentId);
    if (!payment) {
      return 0;
    }
    let taken = 0;
    for (const refund of refundsById.values()) {
      if (refund.providerPaymentId === providerPaymentId && refund.status !== "failed") {
        taken += refund.amountInPaise;
      }
    }
    return payment.amountInPaise - taken;
  }

  /**
   * @param {string} providerPaymentId A payment ID.
   * @return {ProviderPayment} The payment with its refunded total filled in.
   */
  function snapshotPayment(providerPaymentId: string): ProviderPayment {
    const payment = payments.get(providerPaymentId);
    if (!payment) {
      throw new ProviderRefundRejectedError("payment_not_found", "No such payment.");
    }
    const refunded = payment.amountInPaise - refundable(providerPaymentId);
    return {
      ...payment,
      amountRefundedInPaise: refunded,
      status: refunded === payment.amountInPaise && payment.status === "captured" ? "refunded" : payment.status,
      captured: payment.status === "captured" || payment.status === "refunded",
    };
  }

  /**
   * @param {CreateProviderRefundInput} input A refund request, already validated.
   * @return {ProviderRefund} The (possibly replayed) refund.
   */
  function applyCreate(input: CreateProviderRefundInput): ProviderRefund {
    if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      throw new ProviderRefundRejectedError("invalid_idempotency_key", "The idempotency key is not valid.");
    }
    const fingerprint = JSON.stringify([
      input.providerPaymentId, input.amountInPaise, input.speed, input.receipt, input.notes,
    ]);
    const prior = byIdempotencyKey.get(input.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new ProviderRefundRejectedError(
          "idempotency_conflict", "A different request used this idempotency key.",
        );
      }
      return refundsById.get(prior.refundId) as ProviderRefund;
    }

    const payment = payments.get(input.providerPaymentId);
    if (!payment) {
      throw new ProviderRefundRejectedError("payment_not_found", "No such payment.");
    }
    // Like the real provider's documented behaviour: a receipt is unique per payment, and a
    // repeat under a DIFFERENT idempotency key says an earlier attempt already landed.
    for (const existing of refundsById.values()) {
      if (existing.providerPaymentId === input.providerPaymentId && existing.receipt === input.receipt) {
        throw new ProviderOutcomeUnknownError("Duplicate receipt found.", "duplicate_receipt", 400);
      }
    }
    if (payment.status !== "captured") {
      throw new ProviderRefundRejectedError("payment_not_captured", "Only a captured payment can be refunded.");
    }
    if (!Number.isSafeInteger(input.amountInPaise) || input.amountInPaise < 1) {
      throw new ProviderRefundRejectedError("invalid_amount", "The refund amount must be a whole number of paise.");
    }
    if (input.amountInPaise > refundable(input.providerPaymentId)) {
      throw new ProviderRefundRejectedError(
        "refund_amount_exceeds_remaining", "The refund amount exceeds what can still be refunded.",
      );
    }

    sequence += 1;
    const refund: ProviderRefund = {
      id: `rfnd_fake_${sequence}`,
      providerPaymentId: input.providerPaymentId,
      amountInPaise: input.amountInPaise,
      currency: payment.currency,
      status: nextStatuses.shift() ?? "pending",
      receipt: input.receipt,
      notes: {...input.notes},
      speedRequested: "normal",
      createdAtEpochSeconds: 1_700_000_000 + sequence,
    };
    refundsById.set(refund.id, refund);
    byIdempotencyKey.set(input.idempotencyKey, {fingerprint, refundId: refund.id});
    return refund;
  }

  return {
    addPayment(payment) {
      payments.set(payment.id, {
        id: payment.id,
        providerOrderId: payment.providerOrderId,
        amountInPaise: payment.amountInPaise,
        currency: payment.currency,
        status: payment.status ?? "captured",
        captured: (payment.status ?? "captured") === "captured",
        amountRefundedInPaise: 0,
      });
    },
    script(method, ...queued) {
      faults.set(method, [...(faults.get(method) ?? []), ...queued]);
    },
    nextRefundStatus(...statuses) {
      nextStatuses.push(...statuses);
    },
    settleRefund(providerRefundId, status) {
      const refund = refundsById.get(providerRefundId);
      if (!refund) {
        throw new Error(`No fake refund ${providerRefundId}.`);
      }
      refundsById.set(providerRefundId, {...refund, status});
    },
    get calls() {
      return calls;
    },
    refunds() {
      return [...refundsById.values()].map((refund) => ({...refund, notes: {...refund.notes}}));
    },
    async createRefund(input) {
      return withFault(begin("createRefund", input), () => applyCreate(input));
    },
    async fetchRefund(providerRefundId) {
      return withFault(begin("fetchRefund", providerRefundId), () => {
        const refund = refundsById.get(providerRefundId);
        if (!refund) {
          throw new ProviderRefundRejectedError("refund_not_found", "No such refund.");
        }
        return refund;
      });
    },
    async listPaymentRefunds(providerPaymentId) {
      return withFault(begin("listPaymentRefunds", providerPaymentId), () =>
        [...refundsById.values()].filter((refund) => refund.providerPaymentId === providerPaymentId));
    },
    async fetchPayment(providerPaymentId) {
      return withFault(begin("fetchPayment", providerPaymentId), () => snapshotPayment(providerPaymentId));
    },
  };
}

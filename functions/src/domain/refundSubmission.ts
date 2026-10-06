import {Timestamp, type Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  isRefundProviderError,
  type ProviderRefund,
  type RefundProviderGateway,
} from "../providers/refundGateway";
import {findMatchingProviderRefund} from "../providers/refundLookup";
import {readRefundAggregates} from "./refundAmounts";
import {
  REFUND_PROVIDER_SPEED,
  isTerminalRefundStatus,
  parseRefundId,
  type Refund,
} from "./refunds";
import {
  adoptExternalRefund,
  applyRefundEvidence,
  flagRefundAttention,
  readRefundContext,
  PENDING_POLL_INTERVAL_MS,
  recordSubmitBookkeeping,
  safeFailureCode,
  type RefundEvidenceResult,
  type RefundLocation,
} from "./refundTransitions";

/**
 * `submitRefund` — the ONE driver that moves a refund forward with the provider.
 * The creation trigger, the scheduled reconciler and any later route all call it;
 * there is no second path.
 *
 * Shape (never a provider call inside a Firestore transaction):
 *
 *   1. CLAIM (transaction): read the refund; refuse unless it is live, unflagged,
 *      due and not leased; take a LEASE (`submitLeaseExpiresAt`) and count the
 *      attempt (`submitAttempts`). Two workers cannot both claim: the second one's
 *      transaction sees the first's lease. A lease that expires (the worker died)
 *      says NOTHING about the provider — the refund stays `requested`/`pending`.
 *   2. PROVIDER CALL (no transaction): for a first submission, create the refund;
 *      for any later one, LOOK UP FIRST (the earlier attempt may have been applied
 *      with its response lost) and only create when the provider holds no refund
 *      that is Zesto's; for a `pending` refund, fetch its status.
 *   3. RESULT (separate transaction): `applyRefundEvidence` moves the refund, the
 *      payment's aggregates and the order's mirror together — or, for an outcome
 *      that proves nothing (timeout, 5xx, rate limit, bad credentials, failed
 *      lookup), `recordSubmitBookkeeping` releases the lease and schedules the next
 *      attempt WITHOUT touching status or money.
 *
 * A refund is `failed` only when the provider definitively refuses the create
 * request, or reports the refund itself failed. Anything ambiguous stays
 * recoverable. After `MAX_AUTOMATIC_SUBMIT_ATTEMPTS` inconclusive attempts the
 * refund is flagged `attentionRequired` and automatic work stops (still not `failed`).
 *
 * The lookup uses `findMatchingProviderRefund`: provider refund ID first, then
 * Zesto's own refund ID in the receipt/notes — never the amount alone. A
 * conflicting match, or an unattributed same-amount refund, flags the refund
 * instead of guessing.
 */

/** How long one worker owns a refund. Longer than a lookup plus a create at the gateway's timeouts. */
export const REFUND_LEASE_MS = 2 * 60 * 1000;
/** Inconclusive attempts after which automatic work stops and a person is asked to look. */
export const MAX_AUTOMATIC_SUBMIT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;
/** Bad credentials are an operator problem: look again later, quietly. */
export const CONFIGURATION_BACKOFF_MS = 15 * 60 * 1000;
/** A failed status lookup of an accepted (`pending`) refund. */
export const PENDING_LOOKUP_BACKOFF_MS = 60 * 60 * 1000;

/** Provider rejections that are Zesto's own request being wrong, not the provider refusing the refund. */
const ZESTO_SIDE_REJECTION_CODES: ReadonlySet<string> = new Set(["invalid_input", "idempotency_key_conflict"]);

/**
 * @param {number} attempts How many attempts have been made (at least 1).
 * @return {number} Milliseconds to wait before the next: 1m, 2m, 4m, ... capped at 1h.
 */
export function submitBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

export interface SubmitRefundOptions {
  /** Injected clock, for tests. */
  now?: () => Timestamp;
  leaseMs?: number;
  /**
   * Whether to refuse a refund whose `nextAttemptAt` is still in the future. The
   * creation trigger sets this false for a refund nobody has attempted yet (its
   * `nextAttemptAt` is only the reconciler's safety net).
   */
  honorSchedule?: boolean;
}

export type SubmitRefundResult =
  | {kind: "not_found" | "malformed"}
  | {kind: "terminal"}
  | {kind: "attention_required"}
  | {kind: "not_due"}
  | {kind: "leased"}
  | {kind: "inconsistent"}
  /** The provider's answer (or a lookup) was applied; `result` says whether it moved anything. */
  | {kind: "applied"; via: "create" | "lookup" | "status_sync"; result: RefundEvidenceResult}
  /** An anomaly was found and the refund flagged for a person. */
  | {kind: "flagged"; code: string}
  /** The attempt proved nothing; the next one is scheduled. Status and money are unchanged. */
  | {kind: "deferred"; reason: "outcome_unknown" | "provider_unavailable" | "provider_configuration" | "lookup_failed"; exhausted: boolean}
  /** Somebody else (a webhook, a newer worker) moved the refund on while this call ran. */
  | {kind: "superseded"};

interface Claim {
  refund: Refund;
  leaseExpiresAt: Timestamp;
  /** Attempts made BEFORE this one: above 0, the provider may already hold the refund. */
  priorAttempts: number;
  attempt: number;
}

type ClaimOutcome =
  | {kind: "claimed"; claim: Claim}
  | Exclude<SubmitRefundResult, {kind: "applied" | "flagged" | "deferred" | "superseded"}>;

/**
 * Moves one refund forward with the provider. See the file header.
 *
 * Never throws for a provider failure — every one is recorded as the refund's
 * state. Throws only for an unexpected local failure (e.g. Firestore), in which
 * case the lease simply expires and the next worker looks the refund up first.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundProviderGateway} gateway The provider (a fake in tests).
 * @param {RefundLocation} loc The refund's coordinates (validated against the stored documents).
 * @param {SubmitRefundOptions} [options] Clock, lease length, schedule handling.
 * @return {Promise<SubmitRefundResult>} What happened.
 */
export async function submitRefund(
  db: Firestore,
  gateway: RefundProviderGateway,
  loc: RefundLocation,
  options: SubmitRefundOptions = {},
): Promise<SubmitRefundResult> {
  const clock = options.now ?? (() => Timestamp.now());
  const leaseMs = options.leaseMs ?? REFUND_LEASE_MS;

  const claimed = await claimRefund(db, loc, clock(), leaseMs, options.honorSchedule ?? true);
  if (claimed.kind !== "claimed") {
    if (claimed.kind === "inconsistent") {
      await flagRefundAttention(db, loc, "zesto_side_request_error", "inconsistent_documents", "submit", clock());
    }
    return claimed;
  }
  const {claim} = claimed;

  if (claim.refund.status === "pending") {
    return syncPendingRefund(db, gateway, loc, claim, clock);
  }

  if (claim.priorAttempts > 0) {
    const looked = await lookupBeforeRetry(db, gateway, loc, claim, clock);
    if (looked !== null) {
      return looked;
    }
  }
  return createAtProvider(db, gateway, loc, claim, clock);
}

/**
 * Phase 1: the lease. See the file header.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {Timestamp} now The clock reading.
 * @param {number} leaseMs The lease length.
 * @param {boolean} honorSchedule Whether `nextAttemptAt` in the future refuses the claim.
 * @return {Promise<ClaimOutcome>} The claim, or why there is none.
 */
async function claimRefund(
  db: Firestore,
  loc: RefundLocation,
  now: Timestamp,
  leaseMs: number,
  honorSchedule: boolean,
): Promise<ClaimOutcome> {
  return db.runTransaction(async (tx): Promise<ClaimOutcome> => {
    const read = await readRefundContext(db, tx, loc);
    if (read.kind === "missing") {
      return {kind: "not_found"};
    }
    if (read.kind === "malformed") {
      return {kind: "malformed"};
    }
    const {refund, payment, refundRef} = read.context;

    if (isTerminalRefundStatus(refund.status)) {
      return {kind: "terminal"};
    }
    if (refund.attentionRequired) {
      return {kind: "attention_required"};
    }
    try {
      const aggregates = readRefundAggregates(payment);
      if (
        payment.status !== "succeeded" ||
        refund.amountInPaise > aggregates.refundPendingInPaise ||
        refund.orderId !== read.context.order.id ||
        refund.userId !== read.context.order.userId
      ) {
        return {kind: "inconsistent"};
      }
    } catch {
      return {kind: "inconsistent"};
    }

    if (refund.submitLeaseExpiresAt !== undefined && refund.submitLeaseExpiresAt.toMillis() > now.toMillis()) {
      return {kind: "leased"};
    }

    const isFirstAttempt = refund.status === "requested" && refund.submitAttempts === 0;
    if (
      honorSchedule && !isFirstAttempt &&
      refund.nextAttemptAt !== undefined && refund.nextAttemptAt.toMillis() > now.toMillis()
    ) {
      return {kind: "not_due"};
    }

    const leaseExpiresAt = Timestamp.fromMillis(now.toMillis() + leaseMs);
    const counted = refund.status === "requested";
    const attempt = counted ? refund.submitAttempts + 1 : refund.submitAttempts;
    tx.update(refundRef, {
      submitLeaseExpiresAt: leaseExpiresAt,
      // The sweep time: a worker that dies leaves the refund findable once its lease is over.
      nextAttemptAt: leaseExpiresAt,
      updatedAt: now,
      ...(counted ? {submitAttempts: attempt, lastSubmitAt: now} : {}),
    });
    return {
      kind: "claimed",
      claim: {
        refund: {...refund, submitAttempts: attempt},
        leaseExpiresAt,
        priorAttempts: refund.submitAttempts,
        attempt,
      },
    };
  });
}

/**
 * A `pending` refund: ask the provider for its status and apply it.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundProviderGateway} gateway The provider.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {Claim} claim The lease.
 * @param {() => Timestamp} clock The clock.
 * @return {Promise<SubmitRefundResult>} What happened.
 */
async function syncPendingRefund(
  db: Firestore,
  gateway: RefundProviderGateway,
  loc: RefundLocation,
  claim: Claim,
  clock: () => Timestamp,
): Promise<SubmitRefundResult> {
  const providerRefundId = claim.refund.providerRefundId;
  if (providerRefundId === undefined) {
    return {kind: "flagged", code: "inconsistent_documents"};
  }
  let providerRefund: ProviderRefund;
  try {
    providerRefund = await gateway.fetchRefund(providerRefundId);
  } catch (error) {
    return recordInconclusive(db, loc, claim, error, clock, "lookup_failed", PENDING_LOOKUP_BACKOFF_MS, false);
  }
  const now = clock();
  const result = await applyRefundEvidence(
    db, loc, {kind: "provider_refund", providerRefund, source: "reconciliation"}, now,
  );
  if (result.kind === "noop") {
    // Still pending at the provider: give the lease back and look again later.
    await recordSubmitBookkeeping(db, loc, {
      leaseExpiresAt: claim.leaseExpiresAt,
      outcome: undefined,
      nextAttemptAt: Timestamp.fromMillis(now.toMillis() + PENDING_POLL_INTERVAL_MS),
    }, now);
  }
  return {kind: "applied", via: "status_sync", result};
}

/**
 * Lost-response recovery for a refund that was attempted before: list the
 * payment's refunds and adopt Zesto's own if the provider has it.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundProviderGateway} gateway The provider.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {Claim} claim The lease.
 * @param {() => Timestamp} clock The clock.
 * @return {Promise<SubmitRefundResult | null>} A final result, or null when the provider
 *   holds no refund of Zesto's and a create may be sent (with the same idempotency key).
 */
async function lookupBeforeRetry(
  db: Firestore,
  gateway: RefundProviderGateway,
  loc: RefundLocation,
  claim: Claim,
  clock: () => Timestamp,
): Promise<SubmitRefundResult | null> {
  const {refund} = claim;
  let listed: ProviderRefund[];
  try {
    listed = await gateway.listPaymentRefunds(refund.providerPaymentId);
  } catch (error) {
    return recordInconclusive(db, loc, claim, error, clock, "lookup_failed", undefined, true);
  }

  const match = findMatchingProviderRefund(listed, {
    providerPaymentId: refund.providerPaymentId,
    zestoRefundId: refund.id,
    providerRefundId: refund.providerRefundId,
    amountInPaise: refund.amountInPaise,
  });

  if (match.kind === "conflict") {
    await flagRefundAttention(db, loc, "conflicting_provider_refunds", refund.id, "lookup", clock());
    return {kind: "flagged", code: "conflicting_provider_refunds"};
  }
  if (match.kind === "matched") {
    const result = await applyRefundEvidence(
      db, loc, {kind: "provider_refund", providerRefund: match.refund, source: "lookup"}, clock(),
    );
    return {kind: "applied", via: "lookup", result};
  }
  if (match.unattributedSameAmount.length > 0) {
    // Same money, no Zesto identifier: probably a refund made by hand. Sending another
    // could refund twice, adopting it on amount alone could be wrong — a person decides.
    await flagRefundAttention(db, loc, "unattributed_same_amount_refund", refund.id, "lookup", clock());
    return {kind: "flagged", code: "unattributed_same_amount_refund"};
  }

  await adoptUnknownRefunds(db, loc, listed, clock());
  return null;
}

/**
 * Adopts, as `external`, provider refunds of this payment that carry no Zesto
 * identifier (best effort: a failure here never blocks the refund's own recovery).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund being recovered.
 * @param {ProviderRefund[]} listed Every refund the provider lists for the payment.
 * @param {Timestamp} now The clock reading.
 */
async function adoptUnknownRefunds(
  db: Firestore,
  loc: RefundLocation,
  listed: ProviderRefund[],
  now: Timestamp,
): Promise<void> {
  for (const providerRefund of listed) {
    const named = [providerRefund.receipt, providerRefund.notes.zestoRefundId]
      .some((value) => value !== undefined && parseRefundId(value) !== null);
    if (named) {
      continue;
    }
    try {
      await adoptExternalRefund(db, loc, providerRefund, "reconciliation", now);
    } catch (error) {
      logger.error("Adopting an external provider refund failed.", {
        refundId: loc.refundId, error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

/**
 * Phase 2/3 for a create: send the request with the deterministic idempotency key
 * and apply — or record — the outcome.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundProviderGateway} gateway The provider.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {Claim} claim The lease.
 * @param {() => Timestamp} clock The clock.
 * @return {Promise<SubmitRefundResult>} What happened.
 */
async function createAtProvider(
  db: Firestore,
  gateway: RefundProviderGateway,
  loc: RefundLocation,
  claim: Claim,
  clock: () => Timestamp,
): Promise<SubmitRefundResult> {
  const {refund} = claim;
  let providerRefund: ProviderRefund;
  try {
    providerRefund = await gateway.createRefund({
      providerPaymentId: refund.providerPaymentId,
      amountInPaise: refund.amountInPaise,
      speed: REFUND_PROVIDER_SPEED,
      idempotencyKey: refund.idempotencyKey,
      receipt: refund.id,
      notes: {zestoRefundId: refund.id, zestoOrderId: refund.orderId},
    });
  } catch (error) {
    if (isRefundProviderError(error) && error.category === "DEFINITIVE_FAILURE") {
      if (ZESTO_SIDE_REJECTION_CODES.has(error.code)) {
        await flagRefundAttention(db, loc, "zesto_side_request_error", error.code, "submit", clock());
        return {kind: "flagged", code: "zesto_side_request_error"};
      }
      const result = await applyRefundEvidence(
        db, loc, {kind: "definitive_rejection", code: error.code, message: error.message, source: "submit"}, clock(),
      );
      return {kind: "applied", via: "create", result};
    }
    return recordInconclusive(db, loc, claim, error, clock, "outcome_unknown", undefined, true);
  }
  const result = await applyRefundEvidence(
    db, loc, {kind: "provider_refund", providerRefund, source: "submit"}, clock(),
  );
  return {kind: "applied", via: "create", result};
}

/**
 * An attempt that proved nothing: release the lease and schedule the next one.
 * Never touches status or money.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {Claim} claim The lease.
 * @param {unknown} error What the provider call threw.
 * @param {() => Timestamp} clock The clock.
 * @param {"outcome_unknown" | "lookup_failed"} fallbackReason The reason when the error is not more specific.
 * @param {number | undefined} fixedBackoffMs A fixed delay (otherwise exponential in the attempts).
 * @param {boolean} countsTowardExhaustion Whether attempts are limited (a `pending` refund's lookups are not).
 * @return {Promise<SubmitRefundResult>} The `deferred` result.
 */
async function recordInconclusive(
  db: Firestore,
  loc: RefundLocation,
  claim: Claim,
  error: unknown,
  clock: () => Timestamp,
  fallbackReason: "outcome_unknown" | "lookup_failed",
  fixedBackoffMs: number | undefined,
  countsTowardExhaustion: boolean,
): Promise<SubmitRefundResult> {
  const now = clock();
  let reason: "outcome_unknown" | "provider_unavailable" | "provider_configuration" | "lookup_failed" = fallbackReason;
  let code = "unexpected_error";
  let message = "The provider call did not complete.";
  let mayHaveBeenApplied = true;
  let backoff = fixedBackoffMs ?? submitBackoffMs(claim.attempt);
  if (isRefundProviderError(error)) {
    code = error.code;
    message = error.message;
    mayHaveBeenApplied = error.mayHaveBeenApplied;
    if (error.category === "AUTH_CONFIGURATION") {
      reason = "provider_configuration";
      backoff = CONFIGURATION_BACKOFF_MS;
      logger.error("The refund provider's credentials are missing or were rejected.", {refundId: loc.refundId});
    } else if (error.category === "RETRYABLE_FAILURE" && reason === "outcome_unknown") {
      reason = "provider_unavailable";
    }
  } else {
    logger.error("A refund provider call failed unexpectedly.", {
      refundId: loc.refundId, error: error instanceof Error ? error.name : "unknown",
    });
  }
  const exhausted = countsTowardExhaustion && reason !== "provider_configuration" &&
    claim.attempt >= MAX_AUTOMATIC_SUBMIT_ATTEMPTS;
  const recorded = await recordSubmitBookkeeping(db, loc, {
    leaseExpiresAt: claim.leaseExpiresAt,
    outcome: mayHaveBeenApplied && claim.refund.status === "requested" ? "unknown" : undefined,
    failureCode: safeFailureCode(code),
    failureMessage: message,
    nextAttemptAt: Timestamp.fromMillis(now.toMillis() + backoff),
    exhausted,
  }, now);
  if (recorded === "superseded") {
    return {kind: "superseded"};
  }
  return {kind: "deferred", reason, exhausted};
}

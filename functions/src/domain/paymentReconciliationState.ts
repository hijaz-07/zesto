import {Timestamp, FieldValue} from "firebase-admin/firestore";
import {z} from "zod";

/**
 * The bookkeeping a payment carries while Zesto might not yet know what the provider
 * did with it (see `paymentReconciliation.ts`). Kept in its own small module so
 * `payments.ts` (which schedules and un-schedules it) and the reconciler (which
 * drives it) share one definition without importing each other.
 *
 * It lives in a `reconciliation` map ON the payment document, like a refund's
 * `nextAttemptAt`, so the scheduled sweep is one bounded collection-group query on
 * `reconciliation.nextAttemptAt` (`firestore.indexes.json`) and never scans tenant
 * data. It is internal: never part of `PaymentResponse`.
 *
 * `nextAttemptAt` is the ONLY selector. It is present exactly while the payment is
 * unresolved and automatic work should continue:
 * - set when the provider order is first attached (`claimProviderOrder`);
 * - moved forward by each claim (to the lease end) and by each evaluation;
 * - deleted when the payment succeeds (same transaction as the success), when the
 *   window closes, or when an anomaly needs a person (`attentionRequired`).
 */

/** How long after the provider order is attached the first check happens: the customer is
 * usually still in Checkout and the webhook / Checkout verification normally lands first. */
export const FIRST_CHECK_DELAY_MS = 15 * 60 * 1000;
/** The longest a payment is reconciled for, from its creation. A provider order that has seen
 * no capture for this long is abandoned; the webhook remains the path for anything later. */
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Spacing between checks of a payment the provider reports as not (yet) captured. */
const CHECK_BASE_MS = 15 * 60 * 1000;
const CHECK_CAP_MS = 12 * 60 * 60 * 1000;
/** Retry spacing after a lookup that proved nothing (outage, timeout, rate limit, unreadable answer). */
const INCONCLUSIVE_BASE_MS = 2 * 60 * 1000;
const INCONCLUSIVE_CAP_MS = 60 * 60 * 1000;
/** Bad credentials are an operator problem: look again later, quietly. */
export const CONFIGURATION_BACKOFF_MS = 15 * 60 * 1000;
/** Consecutive inconclusive lookups after which the failure is logged at error severity every time. */
export const INCONCLUSIVE_ALERT_STREAK = 8;

/** What the provider showed on the last evaluation. */
export type ReconciliationProviderState =
  "no_payments" | "created" | "authorized" | "failed" | "captured";

export interface PaymentReconciliation {
  /** When the next evaluation is due; absent when nothing further will run automatically. */
  nextAttemptAt?: Timestamp;
  /** Held by the worker that claimed the payment; a second worker skips it until it lapses. */
  leaseExpiresAt?: Timestamp;
  /** Evaluations that reached the provider. */
  attempts: number;
  /** Consecutive lookups that proved nothing; reset by any usable answer. */
  inconclusiveStreak: number;
  lastAttemptAt?: Timestamp;
  lastProviderState?: ReconciliationProviderState;
  /** A short, machine-readable result of the last evaluation. */
  lastOutcome?: string;
  lastFailureCode?: string;
  /** An anomaly needs a person; automatic work has stopped. */
  attentionRequired?: boolean;
  attentionCode?: string;
  attentionAt?: Timestamp;
  /** How the payment left reconciliation. */
  resolution?: "captured_recovered" | "already_succeeded" | "not_reconcilable" | "window_closed";
  resolvedAt?: Timestamp;
}

const timestampSchema = z.custom<Timestamp>(
  (value) => value instanceof Timestamp,
  "must be a Firestore Timestamp",
);

export const paymentReconciliationSchema = z.object({
  nextAttemptAt: timestampSchema.optional(),
  leaseExpiresAt: timestampSchema.optional(),
  attempts: z.number().int().min(0),
  inconclusiveStreak: z.number().int().min(0),
  lastAttemptAt: timestampSchema.optional(),
  lastProviderState: z.enum(["no_payments", "created", "authorized", "failed", "captured"]).optional(),
  lastOutcome: z.string().max(100).optional(),
  lastFailureCode: z.string().max(100).optional(),
  attentionRequired: z.boolean().optional(),
  attentionCode: z.string().max(100).optional(),
  attentionAt: timestampSchema.optional(),
  resolution: z.enum(["captured_recovered", "already_succeeded", "not_reconcilable", "window_closed"]).optional(),
  resolvedAt: timestampSchema.optional(),
});

/**
 * @param {Timestamp} now The time the provider order was attached.
 * @return {PaymentReconciliation} The state a newly connected payment starts with: first check due shortly.
 */
export function initialReconciliation(now: Timestamp): PaymentReconciliation {
  return {
    nextAttemptAt: Timestamp.fromMillis(now.toMillis() + FIRST_CHECK_DELAY_MS),
    attempts: 0,
    inconclusiveStreak: 0,
  };
}

/**
 * The field updates that take a payment out of the sweep. Merged into the transaction
 * that makes the payment `succeeded`, so a captured payment is never selected again.
 * Deleting a field of a map that does not exist (a payment from before reconciliation
 * existed) is a no-op.
 *
 * @return {Record<string, FieldValue>} Dotted-path deletes for `Transaction.update`.
 */
export function unscheduleReconciliationUpdate(): Record<string, FieldValue> {
  return {
    "reconciliation.nextAttemptAt": FieldValue.delete(),
    "reconciliation.leaseExpiresAt": FieldValue.delete(),
  };
}

/**
 * @param {Timestamp} createdAt The payment's creation time.
 * @return {Timestamp} When its reconciliation window ends.
 */
export function reconciliationWindowEnd(createdAt: Timestamp): Timestamp {
  return Timestamp.fromMillis(createdAt.toMillis() + RECONCILE_WINDOW_MS);
}

/**
 * @param {number} attempts Evaluations that reached the provider, including this one (at least 1).
 * @return {number} Milliseconds until the next look at a payment that is not captured yet:
 *   15m, 30m, 1h, 2h, 4h, 8h, then every 12h.
 */
export function nextCheckDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(CHECK_BASE_MS * 2 ** exponent, CHECK_CAP_MS);
}

/**
 * @param {number} streak Consecutive inconclusive lookups, including this one (at least 1).
 * @return {number} Milliseconds until the next try: 2m, 4m, 8m, ... capped at 1h.
 */
export function inconclusiveBackoffMs(streak: number): number {
  const exponent = Math.min(Math.max(streak, 1) - 1, 20);
  return Math.min(INCONCLUSIVE_BASE_MS * 2 ** exponent, INCONCLUSIVE_CAP_MS);
}

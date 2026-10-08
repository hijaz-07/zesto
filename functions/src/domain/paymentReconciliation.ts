import {createHash} from "node:crypto";
import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";
import {isValidDocumentId} from "../auth/membership";
import type {PaymentLookupGateway, ProviderOrderPayment} from "../providers/paymentLookupGateway";
import {isRefundProviderError} from "../providers/refundGateway";
import {parseOrder, type Order} from "./orders";
import {locatePaymentByProviderField} from "./paymentLookup";
import {
  CONFIGURATION_BACKOFF_MS,
  INCONCLUSIVE_ALERT_STREAK,
  inconclusiveBackoffMs,
  nextCheckDelayMs,
  reconciliationWindowEnd,
  type ReconciliationProviderState,
} from "./paymentReconciliationState";
import {markPaymentFailed, markPaymentSucceeded, parsePayment, type Payment} from "./payments";

/**
 * PAYMENT RECONCILIATION — the safety net for a payment the provider captured but Zesto
 * never heard about (the browser closed before `payment/verify`, AND every webhook
 * delivery failed or was refused). It follows the shape of refund reconciliation
 * (`refundSubmission.ts` / `refundReconciliation.ts`):
 *
 *   1. CLAIM (transaction): read the order and its payment, refuse anything that is
 *      resolved, flagged, leased or not yet due, take a LEASE and count the attempt. Two
 *      workers cannot both claim; a lease that lapses (the worker died) says nothing
 *      about the payment.
 *   2. PROVIDER LOOKUP (no transaction): list the payments the provider holds for the
 *      payment's own `providerOrderId` — an identifier Zesto stored itself, before the
 *      customer could pay. Read-only: reconciliation never creates, captures or refunds.
 *   3. APPLY (separate transactions): `evaluateOrderPayments` turns the listing into ONE
 *      decision, and only the existing trusted transitions move money-bearing state:
 *      `markPaymentSucceeded` (order -> confirmed, or — for an order cancelled meanwhile —
 *      the late-capture refund) and `markPaymentFailed`. There is no second implementation
 *      of "a payment succeeded".
 *
 * WHAT IS ADOPTED. A provider payment is adopted ONLY if all of these hold:
 *   - it is in the listing of THIS payment's own provider order, and its `order_id` says
 *     so (anything else in the answer is ignored and recorded, never adopted);
 *   - the provider reports it `captured` (an `authorized`/`created` payment is NOT paid);
 *   - its amount and currency equal the STORED payment's (which came from the order,
 *     never from the client or from the provider);
 *   - it is the only captured payment, with nothing refunded outside Zesto;
 *   - its provider payment ID is not already attached to any other Zesto payment.
 * Amount alone never identifies a payment. Anything that fails these is an ANOMALY: the
 * payment is flagged `attentionRequired`, automatic work stops, nothing is confirmed.
 * An already-`succeeded` payment is never overwritten: a different captured payment ID
 * is recorded as an anomaly beside it.
 *
 * AMBIGUITY. A lookup that fails (outage, timeout, rate limit, bad credentials, an
 * unreadable or self-contradictory answer) proves NOTHING: no status changes, the lease
 * is released, the next try is scheduled with backoff. It is never "not paid".
 *
 * BOUNDS. The sweep selects only payments whose `reconciliation.nextAttemptAt` is due,
 * oldest first, at most `limit`, within a time budget. A payment is looked at on a
 * widening schedule (15m, 30m, 1h, ... 12h) and for at most `RECONCILE_WINDOW_MS` from
 * its creation; the evaluation that would be the last closes it (`window_closed`).
 */

export const DEFAULT_PAYMENT_RECONCILE_LIMIT = 25;
export const DEFAULT_PAYMENT_RECONCILE_BUDGET_MS = 4 * 60 * 1000;
/** One worker's ownership of a payment; longer than a lookup at the gateway's timeout. */
export const PAYMENT_LEASE_MS = 2 * 60 * 1000;
/** Most ignored provider IDs kept in an audit record. */
const MAX_AUDITED_IDS = 10;

/** Where one payment lives. Validated against the stored documents. */
export interface PaymentLocation {
  organizationId: string;
  outletId: string;
  menuId: string;
  orderId: string;
  /** Equals `orderId` (one payment per order); kept separate so the path is never assumed. */
  paymentId: string;
}

/**
 * @param {string} path A Firestore document path.
 * @return {PaymentLocation | null} The payment's coordinates, or null unless the path is exactly
 *   `organizations/{o}/outlets/{ou}/menus/{m}/orders/{ord}/payments/{p}` with valid IDs and `p === ord`.
 */
export function paymentLocationFromPath(path: string): PaymentLocation | null {
  const s = path.split("/");
  if (
    s.length !== 10 ||
    s[0] !== "organizations" || s[2] !== "outlets" || s[4] !== "menus" ||
    s[6] !== "orders" || s[8] !== "payments" ||
    ![s[1], s[3], s[5], s[7], s[9]].every(isValidDocumentId) ||
    s[7] !== s[9]
  ) {
    return null;
  }
  return {organizationId: s[1], outletId: s[3], menuId: s[5], orderId: s[7], paymentId: s[9]};
}

// ---------------------------------------------------------------------------
// Matching: the provider's listing -> one decision
// ---------------------------------------------------------------------------

/** Why a payment was flagged for a person. Stable codes (they are stored). */
export type PaymentAnomalyCode =
  | "multiple_captured_payments"
  | "captured_amount_mismatch"
  | "captured_with_external_refund"
  | "captured_then_refunded"
  | "conflicting_captured_payment"
  | "provider_payment_claimed_elsewhere"
  | "capture_not_applicable"
  | "inconsistent_documents"
  | "window_closed_unverified"
  | "authorized_not_captured";

export type OrderPaymentsEvaluation =
  | {kind: "captured"; providerPaymentId: string; amountInPaise: number; currency: string}
  | {kind: "anomaly"; code: PaymentAnomalyCode; discriminator: string}
  /** The listing contradicts itself or the provider's own rules: unusable, so inconclusive. */
  | {kind: "unusable"}
  | {kind: "failed"; providerPaymentId: string}
  | {kind: "open"; state: "no_payments" | "created" | "authorized"};

export interface OrderPaymentsVerdict {
  evaluation: OrderPaymentsEvaluation;
  /** IDs of listed payments that belong to a DIFFERENT provider order (ignored, never adopted). */
  foreignPaymentIds: string[];
}

/**
 * The matching rules, pure. See the file header for what is adopted and why.
 *
 * @param {Pick<Payment, "providerOrderId" | "amountInPaise" | "currency">} payment Zesto's STORED payment.
 * @param {ProviderOrderPayment[]} listed What the provider says it holds for that order.
 * @return {OrderPaymentsVerdict} The one decision, and the listed payments that were ignored.
 */
export function evaluateOrderPayments(
  payment: Pick<Payment, "providerOrderId" | "amountInPaise" | "currency">,
  listed: readonly ProviderOrderPayment[],
): OrderPaymentsVerdict {
  const own = listed.filter((p) => p.providerOrderId === payment.providerOrderId);
  const foreignPaymentIds = listed.filter((p) => p.providerOrderId !== payment.providerOrderId).map((p) => p.id);
  const verdict = (evaluation: OrderPaymentsEvaluation): OrderPaymentsVerdict => ({evaluation, foreignPaymentIds});

  // A payment that appears twice, or whose status and `captured` flag disagree, is not an
  // answer to act on: wait for the provider to be consistent.
  const seen = new Set<string>();
  for (const p of own) {
    const captured = p.status === "captured" || p.status === "refunded";
    const coherent = p.status === "refunded" ? true : p.captured === captured;
    if (seen.has(p.id) || !coherent) {
      return verdict({kind: "unusable"});
    }
    seen.add(p.id);
  }

  const captured = own.filter((p) => p.status === "captured");
  const refunded = own.filter((p) => p.status === "refunded");
  if (refunded.length > 0) {
    return verdict({kind: "anomaly", code: "captured_then_refunded", discriminator: refunded.map((p) => p.id).sort().join(",")});
  }
  if (captured.length > 1) {
    return verdict({kind: "anomaly", code: "multiple_captured_payments", discriminator: captured.map((p) => p.id).sort().join(",")});
  }
  if (captured.length === 1) {
    const only = captured[0];
    if (only.amountRefundedInPaise > 0) {
      return verdict({kind: "anomaly", code: "captured_with_external_refund", discriminator: only.id});
    }
    if (only.amountInPaise !== payment.amountInPaise || only.currency !== payment.currency) {
      return verdict({kind: "anomaly", code: "captured_amount_mismatch", discriminator: only.id});
    }
    return verdict({kind: "captured", providerPaymentId: only.id, amountInPaise: only.amountInPaise, currency: only.currency});
  }

  if (own.some((p) => p.status === "authorized")) {
    return verdict({kind: "open", state: "authorized"});
  }
  if (own.some((p) => p.status === "created")) {
    return verdict({kind: "open", state: "created"});
  }
  const failed = own.filter((p) => p.status === "failed");
  if (failed.length > 0) {
    // The newest attempt (by the provider's creation time; list order breaks a tie or a missing time).
    const newest = failed.reduce((a, b) => ((b.createdAtEpochSeconds ?? 0) >= (a.createdAtEpochSeconds ?? 0) ? b : a));
    return verdict({kind: "failed", providerPaymentId: newest.id});
  }
  return verdict({kind: "open", state: "no_payments"});
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

interface Context {
  order: Order;
  payment: Payment;
  orderRef: DocumentReference;
  paymentRef: DocumentReference;
  /** The stored `reconciliation` map exactly as it is (tolerant of a missing or odd one). */
  rawReconciliation: unknown;
}

type ReadResult =
  | {kind: "missing"}
  | {kind: "malformed"; paymentRef: DocumentReference; rawReconciliation: unknown}
  | {kind: "ok"; context: Context};

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment's coordinates.
 * @return {{orderRef: DocumentReference; paymentRef: DocumentReference}} Its order and payment documents.
 */
function refsFor(db: Firestore, loc: PaymentLocation): {orderRef: DocumentReference; paymentRef: DocumentReference} {
  const orderRef = db
    .collection("organizations").doc(loc.organizationId)
    .collection("outlets").doc(loc.outletId)
    .collection("menus").doc(loc.menuId)
    .collection("orders").doc(loc.orderId);
  return {orderRef, paymentRef: orderRef.collection("payments").doc(loc.paymentId)};
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The transaction to read in.
 * @param {PaymentLocation} loc The payment's coordinates.
 * @return {Promise<ReadResult>} The order and payment, validated against the path they were read from.
 */
async function readContext(db: Firestore, tx: Transaction, loc: PaymentLocation): Promise<ReadResult> {
  const {orderRef, paymentRef} = refsFor(db, loc);
  const [orderSnap, paymentSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef)]);
  if (!paymentSnap.exists) {
    return {kind: "missing"};
  }
  const rawReconciliation: unknown = paymentSnap.get("reconciliation");
  if (!orderSnap.exists) {
    return {kind: "malformed", paymentRef, rawReconciliation};
  }
  try {
    const order = parseOrder(orderSnap.data(), loc.orderId, loc.organizationId, loc.outletId, loc.menuId);
    const payment = parsePayment(paymentSnap.data(), loc.paymentId, loc.orderId, loc.organizationId, loc.outletId, loc.menuId);
    return {kind: "ok", context: {order, payment, orderRef, paymentRef, rawReconciliation}};
  } catch {
    return {kind: "malformed", paymentRef, rawReconciliation};
  }
}

/**
 * Builds the next `reconciliation` map from the stored one. Tolerant of a missing or odd
 * map (it starts a fresh one), never writes `undefined`, and drops the `remove`d keys.
 *
 * @param {unknown} current The stored map.
 * @param {Record<string, unknown>} set Fields to set (`undefined` values are skipped).
 * @param {string[]} [remove] Fields to drop.
 * @return {Record<string, unknown>} The whole map to write.
 */
function nextReconciliation(current: unknown, set: Record<string, unknown>, remove: string[] = []): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current) ? {...(current as Record<string, unknown>)} : {};
  if (typeof base.attempts !== "number") {
    base.attempts = 0;
  }
  if (typeof base.inconclusiveStreak !== "number") {
    base.inconclusiveStreak = 0;
  }
  for (const key of remove) {
    delete base[key];
  }
  for (const [key, value] of Object.entries(set)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  return base;
}

/** The keys that take a payment out of the sweep. */
const UNSCHEDULE = ["nextAttemptAt", "leaseExpiresAt"];

/**
 * @param {DocumentReference} paymentRef The payment.
 * @param {string} kind The audit record's kind.
 * @param {string} code A short code.
 * @param {string} discriminator Makes a repeat of this exact record the same document.
 * @return {DocumentReference} The audit document (deterministic, so a repeat writes the same record).
 */
function auditRef(paymentRef: DocumentReference, kind: string, code: string, discriminator: string): DocumentReference {
  const id = createHash("sha256").update(`${kind}:${code}:${discriminator}`).digest("hex").slice(0, 24);
  return paymentRef.collection("reconciliationAudit").doc(`${kind}_${code}_${id}`);
}

/**
 * Stages the flag that stops automatic work and asks a person to look. Writes the payment's
 * `reconciliation` map and an audit record; never touches the payment's status or the order.
 *
 * @param {Transaction} tx The transaction.
 * @param {DocumentReference} paymentRef The payment.
 * @param {unknown} rawReconciliation The stored map.
 * @param {PaymentAnomalyCode} code What is wrong.
 * @param {string} discriminator Makes a repeat of this exact anomaly the same record.
 * @param {Timestamp} now The write time.
 * @param {Record<string, unknown>} [extra] Further bookkeeping fields to set.
 */
function stageAttention(
  tx: Transaction,
  paymentRef: DocumentReference,
  rawReconciliation: unknown,
  code: PaymentAnomalyCode,
  discriminator: string,
  now: Timestamp,
  extra: Record<string, unknown> = {},
): void {
  tx.update(paymentRef, {
    reconciliation: nextReconciliation(rawReconciliation, {
      attentionRequired: true, attentionCode: code, attentionAt: now, lastOutcome: `anomaly:${code}`, ...extra,
    }, UNSCHEDULE),
  });
  tx.set(auditRef(paymentRef, "anomaly", code, discriminator), {kind: "anomaly", code, orderId: paymentRef.parent.parent?.id, at: now});
  logger.error("A payment needs attention.", {orderId: paymentRef.parent.parent?.id, code});
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export interface ReconcilePaymentOptions {
  /** Injected clock, for tests. */
  now?: () => Timestamp;
  leaseMs?: number;
  /** Whether to refuse a payment whose `nextAttemptAt` is still in the future (default true). */
  honorSchedule?: boolean;
}

export type ReconcilePaymentResult =
  | {kind: "not_found" | "malformed" | "not_due" | "leased" | "attention_required"}
  /** Already `succeeded`: taken out of the sweep without asking the provider. */
  | {kind: "already_resolved"}
  | {kind: "not_reconcilable"}
  /** A captured payment was adopted (`lateCapture`: the order was cancelled meanwhile, so a refund was reserved). */
  | {kind: "recovered"; providerPaymentId: string; lateCapture: boolean}
  /** Nothing captured yet: the provider showed `state`; `failedRecorded` if the payment was marked failed. */
  | {kind: "pending"; state: ReconciliationProviderState; failedRecorded: boolean}
  /** The window ended without a capture; reconciliation of this payment is over. */
  | {kind: "window_closed"}
  /** An anomaly was found and the payment flagged for a person. */
  | {kind: "flagged"; code: PaymentAnomalyCode}
  /** The lookup proved nothing; the next attempt is scheduled. Status and money are unchanged. */
  | {kind: "deferred"; reason: "provider_unavailable" | "provider_configuration" | "unusable_answer" | "unexpected_error"; streak: number}
  /** A newer worker (or the success path) took over while this call ran. */
  | {kind: "superseded"};

interface Claim {
  context: Context;
  leaseExpiresAt: Timestamp;
  attempt: number;
}

type ClaimOutcome =
  | {kind: "claimed"; claim: Claim}
  | Exclude<ReconcilePaymentResult, {kind: "recovered" | "pending" | "window_closed" | "deferred" | "superseded"}>;

/**
 * Looks at one unresolved payment and, if the provider shows it captured, adopts it. See
 * the file header. Never throws for a provider failure — each is recorded as a deferral.
 * Throws only for an unexpected local failure (e.g. Firestore), in which case the lease
 * lapses and the next worker simply tries again.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLookupGateway} gateway The provider (a fake in tests).
 * @param {PaymentLocation} loc The payment's coordinates (validated against the stored documents).
 * @param {ReconcilePaymentOptions} [options] Clock, lease length, schedule handling.
 * @return {Promise<ReconcilePaymentResult>} What happened.
 */
export async function reconcilePayment(
  db: Firestore,
  gateway: PaymentLookupGateway,
  loc: PaymentLocation,
  options: ReconcilePaymentOptions = {},
): Promise<ReconcilePaymentResult> {
  const clock = options.now ?? (() => Timestamp.now());
  const claimed = await claimPayment(db, loc, clock(), options.leaseMs ?? PAYMENT_LEASE_MS, options.honorSchedule ?? true);
  if (claimed.kind !== "claimed") {
    return claimed;
  }
  const {claim} = claimed;
  const {payment} = claim.context;
  // `claimPayment` only returns a claim for a payment with a provider order.
  const providerOrderId = payment.providerOrderId as string;

  let listed: ProviderOrderPayment[];
  try {
    listed = await gateway.listOrderPayments(providerOrderId);
  } catch (error) {
    return recordInconclusive(db, loc, claim, error, clock);
  }

  const {evaluation, foreignPaymentIds} = evaluateOrderPayments(payment, listed);
  if (foreignPaymentIds.length > 0) {
    await recordForeignPayments(db, loc, foreignPaymentIds, clock());
  }

  switch (evaluation.kind) {
  case "unusable":
    return recordInconclusive(db, loc, claim, new UnusableAnswer(), clock);
  case "anomaly":
    return flagPayment(db, loc, evaluation.code, evaluation.discriminator, clock());
  case "captured":
    return adoptCapture(db, loc, claim, evaluation, clock);
  case "failed":
    return recordFailedAttempt(db, loc, claim, evaluation.providerPaymentId, clock);
  case "open":
    return scheduleNext(db, loc, claim, evaluation.state, false, clock);
  }
}

/** An answer the provider gave that cannot be acted on (see `evaluateOrderPayments`'s `unusable`). */
class UnusableAnswer extends Error {
  /** Creates the marker error. */
  constructor() {
    super("The provider's listing contradicts itself.");
    this.name = "UnusableAnswer";
  }
}

/**
 * Phase 1: validate, resolve what can be resolved without the provider, and take the lease.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment's coordinates.
 * @param {Timestamp} now The clock reading.
 * @param {number} leaseMs The lease length.
 * @param {boolean} honorSchedule Whether `nextAttemptAt` in the future refuses the claim.
 * @return {Promise<ClaimOutcome>} The claim, or why there is none.
 */
async function claimPayment(
  db: Firestore,
  loc: PaymentLocation,
  now: Timestamp,
  leaseMs: number,
  honorSchedule: boolean,
): Promise<ClaimOutcome> {
  return db.runTransaction(async (tx): Promise<ClaimOutcome> => {
    const read = await readContext(db, tx, loc);
    if (read.kind === "missing") {
      return {kind: "not_found"};
    }
    if (read.kind === "malformed") {
      // Parked and flagged, so one bad record cannot sit at the head of the sweep forever.
      stageAttention(tx, read.paymentRef, read.rawReconciliation, "inconsistent_documents", "malformed", now);
      return {kind: "malformed"};
    }
    const {context} = read;
    const {order, payment, paymentRef, rawReconciliation} = context;
    const state = payment.reconciliation;

    if (payment.status === "succeeded") {
      // Take it out of the sweep, but never overwrite how it was resolved earlier (e.g. recovered).
      if (state?.resolution === undefined || state.nextAttemptAt !== undefined || state.leaseExpiresAt !== undefined) {
        tx.update(paymentRef, {
          reconciliation: nextReconciliation(
            rawReconciliation, state?.resolution === undefined ? {resolution: "already_succeeded", resolvedAt: now} : {}, UNSCHEDULE,
          ),
        });
      }
      return {kind: "already_resolved"};
    }
    if (payment.provider !== "razorpay" || payment.providerOrderId === undefined) {
      tx.update(paymentRef, {
        reconciliation: nextReconciliation(rawReconciliation, {resolution: "not_reconcilable", resolvedAt: now}, UNSCHEDULE),
      });
      return {kind: "not_reconcilable"};
    }
    if (state?.attentionRequired === true) {
      return {kind: "attention_required"};
    }
    // A payment that is not succeeded can only belong to an order still awaiting payment or one
    // cancelled meanwhile (a late capture); anything else, or a disagreement between the two
    // documents, is not something to act on.
    if (
      payment.orderId !== order.id || payment.userId !== order.userId ||
      payment.amountInPaise !== order.totalInPaise || payment.currency !== order.currency ||
      (order.status !== "pending_payment" && order.status !== "cancelled")
    ) {
      stageAttention(tx, paymentRef, rawReconciliation, "inconsistent_documents", "claim", now);
      return {kind: "flagged", code: "inconsistent_documents"};
    }

    if (state?.leaseExpiresAt !== undefined && state.leaseExpiresAt.toMillis() > now.toMillis()) {
      return {kind: "leased"};
    }
    if (honorSchedule && state?.nextAttemptAt !== undefined && state.nextAttemptAt.toMillis() > now.toMillis()) {
      return {kind: "not_due"};
    }

    const leaseExpiresAt = Timestamp.fromMillis(now.toMillis() + leaseMs);
    const attempt = (state?.attempts ?? 0) + 1;
    tx.update(paymentRef, {
      reconciliation: nextReconciliation(rawReconciliation, {
        leaseExpiresAt,
        // The sweep time: a worker that dies leaves the payment findable once its lease is over.
        nextAttemptAt: leaseExpiresAt,
        attempts: attempt,
        lastAttemptAt: now,
      }),
    });
    return {kind: "claimed", claim: {context, leaseExpiresAt, attempt}};
  });
}

/**
 * Whether this worker still owns the payment's lease (a lapsed lease may have been re-claimed).
 *
 * @param {Payment} payment The payment as read in the transaction.
 * @param {Timestamp} leaseExpiresAt The lease this worker took.
 * @return {boolean} True if the stored lease is still this worker's.
 */
function holdsLease(payment: Payment, leaseExpiresAt: Timestamp): boolean {
  return payment.reconciliation?.leaseExpiresAt?.toMillis() === leaseExpiresAt.toMillis();
}

/**
 * Records, without any decision, which provider payments of ANOTHER order were in an answer
 * about this one. They are ignored; the record is the audit trail.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment.
 * @param {string[]} ids The ignored provider payment IDs.
 * @param {Timestamp} now The write time.
 */
async function recordForeignPayments(db: Firestore, loc: PaymentLocation, ids: string[], now: Timestamp): Promise<void> {
  const {paymentRef} = refsFor(db, loc);
  const sorted = [...ids].sort();
  logger.error("The provider listed payments of another order for a payment; they were ignored.", {
    orderId: loc.orderId, count: sorted.length,
  });
  await auditRef(paymentRef, "ignored", "foreign_provider_payments", sorted.join(",")).set({kind: "ignored", code: "foreign_provider_payments", providerPaymentIds: sorted.slice(0, MAX_AUDITED_IDS), count: sorted.length, orderId: loc.orderId, at: now});
}

/**
 * Flags a payment for a person, in its own transaction. Idempotent.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment.
 * @param {PaymentAnomalyCode} code What is wrong.
 * @param {string} discriminator Makes a repeat the same record.
 * @param {Timestamp} now The write time.
 * @return {Promise<ReconcilePaymentResult>} `flagged`, or `not_found` if the payment is gone.
 */
async function flagPayment(
  db: Firestore,
  loc: PaymentLocation,
  code: PaymentAnomalyCode,
  discriminator: string,
  now: Timestamp,
): Promise<ReconcilePaymentResult> {
  const {paymentRef} = refsFor(db, loc);
  return db.runTransaction(async (tx): Promise<ReconcilePaymentResult> => {
    const snap = await tx.get(paymentRef);
    if (!snap.exists) {
      return {kind: "not_found"};
    }
    stageAttention(tx, paymentRef, snap.get("reconciliation"), code, discriminator, now);
    return {kind: "flagged", code};
  });
}

/**
 * The provider reports exactly one captured payment that matches. Adopt it through the
 * trusted transition, unless something already on file contradicts it.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment.
 * @param {Claim} claim The lease.
 * @param {{providerPaymentId: string; amountInPaise: number; currency: string}} captured The matched payment.
 * @param {() => Timestamp} clock The clock.
 * @return {Promise<ReconcilePaymentResult>} What happened.
 */
async function adoptCapture(
  db: Firestore,
  loc: PaymentLocation,
  claim: Claim,
  captured: {providerPaymentId: string; amountInPaise: number; currency: string},
  clock: () => Timestamp,
): Promise<ReconcilePaymentResult> {
  const {paymentRef} = refsFor(db, loc);

  // 1. The provider payment must not already belong to a DIFFERENT Zesto payment.
  const owner = await locatePaymentByProviderField(db, "providerPaymentId", captured.providerPaymentId);
  const ownedElsewhere = owner.kind === "ambiguous" ||
    (owner.kind === "found" && (owner.payment.id !== loc.paymentId || owner.payment.orderId !== loc.orderId));
  if (ownedElsewhere) {
    return flagPayment(db, loc, "provider_payment_claimed_elsewhere", captured.providerPaymentId, clock());
  }

  // 2. A payment that succeeded meanwhile (webhook, Checkout) is never overwritten.
  const fresh = await paymentRef.get();
  const before = fresh.exists ?
    parsePayment(fresh.data(), loc.paymentId, loc.orderId, loc.organizationId, loc.outletId, loc.menuId) :
    null;
  if (before === null) {
    return {kind: "not_found"};
  }
  if (before.status === "succeeded") {
    return before.providerPaymentId === captured.providerPaymentId ?
      resolve(db, loc, "already_succeeded", captured.providerPaymentId, clock()) :
      flagPayment(db, loc, "conflicting_captured_payment", `${before.providerPaymentId ?? ""}|${captured.providerPaymentId}`, clock());
  }

  // 3. The one trusted success transition (re-checks status, order and amount itself).
  let result: Awaited<ReturnType<typeof markPaymentSucceeded>>;
  try {
    result = await markPaymentSucceeded(db, {
      orderId: loc.orderId,
      paymentId: loc.paymentId,
      amountInPaise: captured.amountInPaise,
      currency: captured.currency,
      providerPaymentId: captured.providerPaymentId,
    });
  } catch (error) {
    if (error instanceof HttpsError && error.code === "failed-precondition") {
      return flagPayment(db, loc, "capture_not_applicable", captured.providerPaymentId, clock());
    }
    if (error instanceof HttpsError && error.code === "not-found") {
      return flagPayment(db, loc, "inconsistent_documents", "adopt", clock());
    }
    throw error;
  }
  if (result.payment.providerPaymentId !== captured.providerPaymentId) {
    // Another success won the race with a different provider payment: keep it, report ours.
    return flagPayment(
      db, loc, "conflicting_captured_payment", `${result.payment.providerPaymentId ?? ""}|${captured.providerPaymentId}`, clock(),
    );
  }

  const lateCapture = result.refundId !== undefined;
  logger.warn("A payment captured at the provider was recovered by reconciliation.", {
    orderId: loc.orderId, lateCapture, ...(lateCapture ? {refundId: result.refundId} : {}),
  });
  return resolve(db, loc, "captured_recovered", captured.providerPaymentId, clock(), lateCapture);
}

/**
 * Records that a payment left reconciliation because it is now `succeeded` (nothing here
 * changes its status — the success was committed by `markPaymentSucceeded`).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment.
 * @param {"captured_recovered" | "already_succeeded"} resolution How it left.
 * @param {string} providerPaymentId The provider payment behind it.
 * @param {Timestamp} now The write time.
 * @param {boolean} [lateCapture] Whether the order was cancelled meanwhile.
 * @return {Promise<ReconcilePaymentResult>} `recovered` or `already_resolved`.
 */
async function resolve(
  db: Firestore,
  loc: PaymentLocation,
  resolution: "captured_recovered" | "already_succeeded",
  providerPaymentId: string,
  now: Timestamp,
  lateCapture = false,
): Promise<ReconcilePaymentResult> {
  const {paymentRef} = refsFor(db, loc);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(paymentRef);
    if (!snap.exists) {
      return;
    }
    tx.update(paymentRef, {
      reconciliation: nextReconciliation(snap.get("reconciliation"), {
        resolution, resolvedAt: now, lastProviderState: "captured", lastOutcome: resolution, inconclusiveStreak: 0,
      }, [...UNSCHEDULE, "lastFailureCode"]),
    });
    if (resolution === "captured_recovered") {
      tx.set(auditRef(paymentRef, "recovered", "captured", providerPaymentId), {
        kind: "recovered", providerPaymentId, lateCapture, orderId: loc.orderId, at: now,
      });
    }
  });
  return resolution === "captured_recovered" ?
    {kind: "recovered", providerPaymentId, lateCapture} :
    {kind: "already_resolved"};
}

/**
 * Every payment attempt the provider shows failed: record the failure through the trusted
 * transition (a no-op if it already is failed or has succeeded) and keep watching — the
 * customer may try again against the same provider order.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment.
 * @param {Claim} claim The lease.
 * @param {string} providerPaymentId The newest failed attempt.
 * @param {() => Timestamp} clock The clock.
 * @return {Promise<ReconcilePaymentResult>} What happened.
 */
async function recordFailedAttempt(
  db: Firestore,
  loc: PaymentLocation,
  claim: Claim,
  providerPaymentId: string,
  clock: () => Timestamp,
): Promise<ReconcilePaymentResult> {
  let failedRecorded = false;
  if (claim.context.payment.status === "pending") {
    try {
      const after = await markPaymentFailed(db, {orderId: loc.orderId, paymentId: loc.paymentId, providerPaymentId});
      failedRecorded = after.status === "failed";
    } catch (error) {
      if (error instanceof HttpsError && error.code === "not-found") {
        return flagPayment(db, loc, "inconsistent_documents", "fail", clock());
      }
      throw error;
    }
  }
  return scheduleNext(db, loc, claim, "failed", failedRecorded, clock);
}

/**
 * Phase 3 for a payment that is not captured yet: release the lease and schedule the next
 * look — or, if that look would fall outside the window, close the payment instead.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment.
 * @param {Claim} claim The lease.
 * @param {ReconciliationProviderState} state What the provider showed.
 * @param {boolean} failedRecorded Whether this call recorded the payment as failed.
 * @param {() => Timestamp} clock The clock.
 * @return {Promise<ReconcilePaymentResult>} `pending`, `window_closed` or `superseded`.
 */
async function scheduleNext(
  db: Firestore,
  loc: PaymentLocation,
  claim: Claim,
  state: ReconciliationProviderState,
  failedRecorded: boolean,
  clock: () => Timestamp,
): Promise<ReconcilePaymentResult> {
  const {paymentRef} = refsFor(db, loc);
  return db.runTransaction(async (tx): Promise<ReconcilePaymentResult> => {
    const read = await readContext(db, tx, loc);
    if (read.kind !== "ok") {
      return {kind: "superseded"};
    }
    const {payment, rawReconciliation} = read.context;
    if (payment.status === "succeeded" || !holdsLease(payment, claim.leaseExpiresAt)) {
      return {kind: "superseded"};
    }
    const now = clock();
    const nextAt = Timestamp.fromMillis(now.toMillis() + nextCheckDelayMs(claim.attempt));
    if (nextAt.toMillis() > reconciliationWindowEnd(payment.createdAt).toMillis()) {
      return stageWindowClosed(tx, paymentRef, rawReconciliation, state, now);
    }
    tx.update(paymentRef, {
      reconciliation: nextReconciliation(rawReconciliation, {
        nextAttemptAt: nextAt, lastProviderState: state, lastOutcome: failedRecorded ? "failed_recorded" : state, inconclusiveStreak: 0,
      }, ["leaseExpiresAt", "lastFailureCode"]),
    });
    return {kind: "pending", state, failedRecorded};
  });
}

/**
 * Stages the end of a payment's reconciliation window. If the provider last showed an
 * `authorized` payment that was never captured, that is flagged for a person; otherwise
 * the payment simply leaves the sweep.
 *
 * @param {Transaction} tx The transaction.
 * @param {DocumentReference} paymentRef The payment.
 * @param {unknown} rawReconciliation The stored map.
 * @param {ReconciliationProviderState | "unverified"} state What the provider last showed.
 * @param {Timestamp} now The write time.
 * @return {ReconcilePaymentResult} `window_closed` (or `flagged` for an authorized or unverified end).
 */
function stageWindowClosed(
  tx: Transaction,
  paymentRef: DocumentReference,
  rawReconciliation: unknown,
  state: ReconciliationProviderState | "unverified",
  now: Timestamp,
): ReconcilePaymentResult {
  if (state === "authorized" || state === "unverified") {
    const code: PaymentAnomalyCode = state === "authorized" ? "authorized_not_captured" : "window_closed_unverified";
    stageAttention(tx, paymentRef, rawReconciliation, code, "window", now, {resolution: "window_closed", resolvedAt: now});
    return {kind: "flagged", code};
  }
  tx.update(paymentRef, {
    reconciliation: nextReconciliation(rawReconciliation, {
      resolution: "window_closed", resolvedAt: now, lastProviderState: state, lastOutcome: "window_closed",
    }, UNSCHEDULE),
  });
  tx.set(auditRef(paymentRef, "closed", "window", "window"), {kind: "closed", code: "window_closed", lastProviderState: state, at: now});
  logger.warn("A payment's reconciliation window ended without a capture.", {orderId: paymentRef.parent.parent?.id, lastProviderState: state});
  return {kind: "window_closed"};
}

/**
 * A lookup that proved nothing: release the lease and schedule the next try with backoff.
 * Never touches the payment's status or the order. A lookup that cannot succeed before the
 * window ends closes the payment as `window_closed_unverified` instead.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLocation} loc The payment.
 * @param {Claim} claim The lease.
 * @param {unknown} error What the lookup threw (or an `UnusableAnswer`).
 * @param {() => Timestamp} clock The clock.
 * @return {Promise<ReconcilePaymentResult>} The `deferred` result (or `window_closed`/`superseded`).
 */
async function recordInconclusive(
  db: Firestore,
  loc: PaymentLocation,
  claim: Claim,
  error: unknown,
  clock: () => Timestamp,
): Promise<ReconcilePaymentResult> {
  let reason: "provider_unavailable" | "provider_configuration" | "unusable_answer" | "unexpected_error" = "unexpected_error";
  let code = "unexpected_error";
  let configuration = false;
  if (error instanceof UnusableAnswer) {
    reason = "unusable_answer";
    code = "inconsistent_provider_listing";
  } else if (isRefundProviderError(error)) {
    code = error.code;
    if (error.category === "AUTH_CONFIGURATION") {
      reason = "provider_configuration";
      configuration = true;
      logger.error("The payment provider's credentials are missing or were rejected.", {orderId: loc.orderId});
    } else {
      reason = "provider_unavailable";
    }
  } else {
    logger.error("A payment provider lookup failed unexpectedly.", {
      orderId: loc.orderId, error: error instanceof Error ? error.name : "unknown",
    });
  }

  const {paymentRef} = refsFor(db, loc);
  return db.runTransaction(async (tx): Promise<ReconcilePaymentResult> => {
    const read = await readContext(db, tx, loc);
    if (read.kind !== "ok") {
      return {kind: "superseded"};
    }
    const {payment, rawReconciliation} = read.context;
    if (payment.status === "succeeded" || !holdsLease(payment, claim.leaseExpiresAt)) {
      return {kind: "superseded"};
    }
    const now = clock();
    const streak = (payment.reconciliation?.inconclusiveStreak ?? 0) + (configuration ? 0 : 1);
    const backoff = configuration ? CONFIGURATION_BACKOFF_MS : inconclusiveBackoffMs(streak);
    const nextAt = Timestamp.fromMillis(now.toMillis() + backoff);
    if (streak >= INCONCLUSIVE_ALERT_STREAK) {
      logger.error("Payment reconciliation keeps failing to reach a conclusion.", {orderId: loc.orderId, streak, code});
    } else {
      logger.warn("A payment reconciliation lookup was inconclusive; it will be retried.", {orderId: loc.orderId, streak, code});
    }
    if (nextAt.toMillis() > reconciliationWindowEnd(payment.createdAt).toMillis()) {
      return stageWindowClosed(tx, paymentRef, rawReconciliation, "unverified", now);
    }
    tx.update(paymentRef, {
      reconciliation: nextReconciliation(rawReconciliation, {
        nextAttemptAt: nextAt, inconclusiveStreak: streak, lastFailureCode: code, lastOutcome: `inconclusive:${code}`,
      }, ["leaseExpiresAt"]),
    });
    return {kind: "deferred", reason, streak};
  });
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface ReconcilePaymentsOptions {
  now?: () => Timestamp;
  limit?: number;
  budgetMs?: number;
}

export interface ReconcilePaymentsSummary {
  examined: number;
  stoppedForBudget: boolean;
  /** Counts by `ReconcilePaymentResult.kind`, plus the sweep's own `skipped_*` and `error`. */
  results: Record<string, number>;
}

/**
 * The scheduled sweep. One collection-group query over payments whose
 * `reconciliation.nextAttemptAt` has passed, oldest first, at most `limit`; each payment is
 * validated by path and then handled by `reconcilePayment` (which validates the documents).
 * It never scans tenant data, never creates or amends a payment, and is safe to run twice at
 * once (leases). One payment's failure never stops the rest. A wall-clock budget stops it
 * before the function's timeout; whatever is left waits for the next run.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentLookupGateway} gateway The provider.
 * @param {ReconcilePaymentsOptions} [options] Clock, batch size and time budget.
 * @return {Promise<ReconcilePaymentsSummary>} What the sweep did (never document contents).
 */
export async function reconcileDuePayments(
  db: Firestore,
  gateway: PaymentLookupGateway,
  options: ReconcilePaymentsOptions = {},
): Promise<ReconcilePaymentsSummary> {
  const clock = options.now ?? (() => Timestamp.now());
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_PAYMENT_RECONCILE_LIMIT, 100));
  const budgetMs = options.budgetMs ?? DEFAULT_PAYMENT_RECONCILE_BUDGET_MS;
  const startedAt = Date.now();

  const due = await db
    .collectionGroup("payments")
    .where("reconciliation.nextAttemptAt", "<=", clock())
    .orderBy("reconciliation.nextAttemptAt", "asc")
    .limit(limit)
    .get();

  const summary: ReconcilePaymentsSummary = {examined: 0, stoppedForBudget: false, results: {}};
  const count = (key: string): void => {
    summary.results[key] = (summary.results[key] ?? 0) + 1;
  };

  for (const doc of due.docs) {
    if (Date.now() - startedAt > budgetMs) {
      summary.stoppedForBudget = true;
      break;
    }
    summary.examined += 1;
    const loc = paymentLocationFromPath(doc.ref.path);
    if (loc === null) {
      count("skipped_malformed_path");
      logger.error("A payment at an unexpected path was skipped.", {path: doc.ref.path});
      continue;
    }
    try {
      const result = await reconcilePayment(db, gateway, loc, {now: clock});
      count(result.kind);
    } catch (error) {
      // One payment's failure never stops the sweep; its lease lapses and it is retried next run.
      count("error");
      logger.error("Reconciling a payment failed.", {
        orderId: loc.orderId, error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return summary;
}

import {createHash} from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {isValidDocumentId} from "../auth/membership";
import type {ProviderRefund} from "../providers/refundGateway";
import {recordRefundNotificationEvent} from "./notificationEvents";
import {parseOrder, type Order} from "./orders";
import {parsePayment, type Payment} from "./payments";
import {
  assessPaymentRefundability,
  deriveRefundState,
  readRefundAggregates,
  type RefundAggregates,
} from "./refundAmounts";
import {orderRefundMirror, readNextRefundSlot} from "./refundCreation";
import {
  REFUND_FAILURE_MESSAGE_MAX_LENGTH,
  REFUND_SYSTEM_INITIATOR,
  isTerminalRefundStatus,
  parseRefund,
  parseRefundId,
  planRefundTransition,
  refundIdempotencyKeyFor,
  type ProviderRefundStatus,
  type Refund,
  type RefundStatus,
  type RefundSubmitOutcome,
} from "./refunds";

/**
 * The ONE place a refund's provider-reported state is applied to Zesto's records.
 *
 * Every driver — the submitter's API response, a lookup after a lost response, a
 * verified webhook, the scheduled reconciler — reduces what it learned to a
 * `RefundEvidenceInput` and calls `applyRefundEvidence`. It runs in ONE Firestore
 * transaction that re-reads the refund, its payment and its order, so arrival
 * order never matters: only the state read in the transaction does (a webhook that
 * beats the API response simply makes the later response a no-op).
 *
 * In that transaction, atomically:
 * - the refund moves (`requested -> pending|processed|failed`, `pending ->
 *   processed|failed`) — never out of a terminal state;
 * - the payment's refund aggregates move with it (`refundAmounts.ts`);
 * - the order's refund mirror is rewritten from the new payment figures;
 * - one audit record is written under `refunds/{id}/transitions`.
 *
 * Nothing here calls the provider. Evidence that contradicts what Zesto holds (a
 * different payment or amount, a status that contradicts a terminal state) is
 * never applied: it flags the refund and its payment `attentionRequired` and
 * writes an `anomaly` audit record.
 *
 * Audit records are internal: backend-only, never part of any API response, and
 * hold only IDs, statuses, timestamps and short codes — never a provider payload,
 * a credential or anything about the customer.
 */

/** Where one refund lives. Every field is validated against the document path it was read from. */
export interface RefundLocation {
  organizationId: string;
  outletId: string;
  menuId: string;
  orderId: string;
  /** Equals `orderId` today; kept separate so the path is never assumed. */
  paymentId: string;
  refundId: string;
}

/**
 * @param {string} path A Firestore document path.
 * @return {RefundLocation | null} The refund's coordinates, or null if the path is
 *   not exactly `organizations/{o}/outlets/{ou}/menus/{m}/orders/{ord}/payments/{p}/refunds/{r}`
 *   with valid IDs and a refund ID that encodes its order.
 */
export function refundLocationFromPath(path: string): RefundLocation | null {
  const s = path.split("/");
  if (
    s.length !== 12 ||
    s[0] !== "organizations" || s[2] !== "outlets" || s[4] !== "menus" ||
    s[6] !== "orders" || s[8] !== "payments" || s[10] !== "refunds" ||
    ![s[1], s[3], s[5], s[7], s[9], s[11]].every(isValidDocumentId)
  ) {
    return null;
  }
  const identity = parseRefundId(s[11]);
  if (identity === null || identity.orderId !== s[7]) {
    return null;
  }
  return {
    organizationId: s[1], outletId: s[3], menuId: s[5], orderId: s[7], paymentId: s[9], refundId: s[11],
  };
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @return {DocumentReference} The order's document.
 */
export function orderRefFor(db: Firestore, loc: Omit<RefundLocation, "paymentId" | "refundId">): DocumentReference {
  return db
    .collection("organizations").doc(loc.organizationId)
    .collection("outlets").doc(loc.outletId)
    .collection("menus").doc(loc.menuId)
    .collection("orders").doc(loc.orderId);
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @return {DocumentReference} The payment's document.
 */
export function paymentRefFor(db: Firestore, loc: Omit<RefundLocation, "refundId">): DocumentReference {
  return orderRefFor(db, loc).collection("payments").doc(loc.paymentId);
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @return {DocumentReference} The refund's document.
 */
export function refundRefFor(db: Firestore, loc: RefundLocation): DocumentReference {
  return paymentRefFor(db, loc).collection("refunds").doc(loc.refundId);
}

/** Everything a transition needs, read in one transaction and validated against the path. */
export interface RefundContext {
  refundRef: DocumentReference;
  paymentRef: DocumentReference;
  orderRef: DocumentReference;
  refund: Refund;
  payment: Payment;
  order: Order;
}

export type RefundContextRead =
  | {kind: "ok"; context: RefundContext}
  | {kind: "missing"; what: "refund" | "payment" | "order"}
  | {kind: "malformed"; what: "refund" | "payment" | "order"};

/**
 * Reads a refund with its payment and order inside `tx`. Never throws for a
 * missing or malformed document: the caller decides (a webhook acknowledges, a
 * scheduler skips and logs).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The transaction (reads only here).
 * @param {RefundLocation} loc The refund's coordinates.
 * @return {Promise<RefundContextRead>} The documents, or what is wrong.
 */
export async function readRefundContext(
  db: Firestore,
  tx: Transaction,
  loc: RefundLocation,
): Promise<RefundContextRead> {
  const refundRef = refundRefFor(db, loc);
  const paymentRef = paymentRefFor(db, loc);
  const orderRef = orderRefFor(db, loc);
  const [refundSnap, paymentSnap, orderSnap] = await Promise.all([
    tx.get(refundRef), tx.get(paymentRef), tx.get(orderRef),
  ]);
  if (!refundSnap.exists) {
    return {kind: "missing", what: "refund"};
  }
  if (!paymentSnap.exists) {
    return {kind: "missing", what: "payment"};
  }
  if (!orderSnap.exists) {
    return {kind: "missing", what: "order"};
  }
  try {
    const order = parseOrder(orderSnap.data(), loc.orderId, loc.organizationId, loc.outletId, loc.menuId);
    const payment = parsePayment(
      paymentSnap.data(), loc.paymentId, loc.orderId, loc.organizationId, loc.outletId, loc.menuId,
    );
    const refund = parseRefund(
      refundSnap.data(), loc.refundId, loc.paymentId, loc.orderId, loc.organizationId, loc.outletId, loc.menuId,
    );
    return {kind: "ok", context: {refundRef, paymentRef, orderRef, refund, payment, order}};
  } catch (error) {
    logger.error("A refund, its payment or its order is malformed.", {
      refundId: loc.refundId, orderId: loc.orderId, error: error instanceof Error ? error.message : "unknown",
    });
    return {kind: "malformed", what: "refund"};
  }
}

// ---------------------------------------------------------------------------
// Audit records
// ---------------------------------------------------------------------------

/** What caused a transition, for the audit trail. */
export type RefundTransitionSource = "submit" | "lookup" | "webhook" | "reconciliation" | "adoption";

export type RefundAnomalyCode =
  | "provider_payment_mismatch"
  | "provider_amount_mismatch"
  | "provider_currency_mismatch"
  | "provider_refund_id_mismatch"
  | "conflicting_provider_refunds"
  | "unattributed_same_amount_refund"
  | "contradicts_terminal_state"
  | "rejection_after_provider_acceptance"
  | "zesto_side_request_error"
  | "attempts_exhausted"
  | "external_refund_not_applicable";

/** Longest `failureCode` the refund schema allows. */
const FAILURE_CODE_MAX = 100;

/**
 * @param {string} value Any short code or message.
 * @param {number} max The maximum length.
 * @return {string} The value, whitespace-collapsed and cut to `max`.
 */
function bounded(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param {string} code A provider or Zesto short code.
 * @return {string} A code safe to store: alphanumerics, `_`, `-` and `.` only, bounded.
 */
export function safeFailureCode(code: string): string {
  const cleaned = code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, FAILURE_CODE_MAX);
  return cleaned.length > 0 ? cleaned : "unknown";
}

interface TransitionAuditInput {
  from: RefundStatus;
  to: RefundStatus;
  source: RefundTransitionSource;
  at: Timestamp;
  providerEventKey?: string;
  providerStatus?: ProviderRefundStatus;
  failureCode?: string;
}

/**
 * @param {DocumentReference} refundRef The refund.
 * @param {TransitionAuditInput} audit The transition.
 * @param {Refund} refund The refund (for its coordinates).
 * @return {{ref: DocumentReference, data: Record<string, unknown>}} The audit document.
 */
function transitionAudit(refundRef: DocumentReference, audit: TransitionAuditInput, refund: Refund) {
  return {
    // A refund makes each (from, to) move at most once, so the ID makes a repeat a conflict, never a double.
    ref: refundRef.collection("transitions").doc(`${audit.from}_to_${audit.to}`),
    data: {
      kind: "transition",
      refundId: refund.id,
      orderId: refund.orderId,
      from: audit.from,
      to: audit.to,
      source: audit.source,
      actor: audit.source === "webhook" ? "provider" : REFUND_SYSTEM_INITIATOR,
      at: audit.at,
      ...(audit.providerEventKey !== undefined ? {providerEventKey: audit.providerEventKey} : {}),
      ...(audit.providerStatus !== undefined ? {providerStatus: audit.providerStatus} : {}),
      ...(audit.failureCode !== undefined ? {failureCode: audit.failureCode} : {}),
    } as Record<string, unknown>,
  };
}

/**
 * @param {DocumentReference} parentRef The refund (or payment) the anomaly is about.
 * @param {RefundAnomalyCode} code What was wrong.
 * @param {string} discriminator Distinguishes anomalies of one code (an event key, a provider refund ID).
 * @return {DocumentReference} A deterministic document, so a repeat delivery writes the same record.
 */
function anomalyRef(parentRef: DocumentReference, code: RefundAnomalyCode, discriminator: string): DocumentReference {
  const id = createHash("sha256").update(`${code}:${discriminator}`).digest("hex").slice(0, 24);
  return parentRef.collection("anomalies").doc(`${code}_${id}`);
}

// ---------------------------------------------------------------------------
// Attention flag + payment/order figures
// ---------------------------------------------------------------------------

/**
 * The payment and order writes after a refund change: the payment's aggregates
 * and derived summary, and the order's mirror, all from the SAME figures.
 *
 * `attention_required` on a payment is sticky until a person clears it: it is set
 * whenever any of its refunds is flagged and never recomputed away here.
 *
 * @param {RefundAggregates} aggregates The payment's figures after the change.
 * @param {boolean} attention Whether the payment is (now) flagged.
 * @param {Timestamp} now The write time.
 * @return {{payment: Record<string, unknown>; order: Record<string, unknown>}} The updates.
 */
function figuresUpdates(
  aggregates: RefundAggregates,
  attention: boolean,
  now: Timestamp,
): {payment: Record<string, unknown>; order: Record<string, unknown>} {
  const mirror = orderRefundMirror(aggregates, attention);
  return {
    payment: {
      capturedAmountInPaise: aggregates.capturedInPaise,
      refundedAmountInPaise: aggregates.refundedInPaise,
      refundPendingInPaise: aggregates.refundPendingInPaise,
      refundState: deriveRefundState(aggregates, attention),
      updatedAt: now,
    },
    // No refund activity left to show: the mirror fields are removed, never left stale.
    order: mirror !== null ?
      {...mirror, updatedAt: now} :
      {refundStatus: FieldValue.delete(), refundedInPaise: FieldValue.delete(), updatedAt: now},
  };
}

/**
 * @param {Payment} payment The payment.
 * @return {boolean} Whether a refund of it has been flagged for a person.
 */
function paymentIsFlagged(payment: Payment): boolean {
  return payment.refundState === "attention_required";
}

// ---------------------------------------------------------------------------
// applyRefundEvidence
// ---------------------------------------------------------------------------

export type RefundEvidenceInput =
  | {
    kind: "provider_refund";
    /** The provider's refund — from a create response, a lookup, a fetch or a verified webhook. */
    providerRefund: Pick<ProviderRefund, "id" | "providerPaymentId" | "amountInPaise" | "currency" | "status"> &
      Partial<Pick<ProviderRefund, "speedRequested" | "speedProcessed">>;
    source: RefundTransitionSource;
    providerEventKey?: string;
  }
  | {
    /** The provider DEFINITIVELY refused the create request (nothing was created). */
    kind: "definitive_rejection";
    code: string;
    message: string;
    source: RefundTransitionSource;
  };

export type RefundEvidenceResult =
  | {kind: "applied"; from: RefundStatus; to: RefundStatus}
  | {kind: "noop"; reason: "already_in_state" | "stale_event"}
  | {kind: "anomaly"; code: RefundAnomalyCode}
  | {kind: "missing_or_malformed"; what: "refund" | "payment" | "order"};

/**
 * Applies one piece of evidence in a single transaction (see the file header).
 * Idempotent and order-independent: repeated or late evidence is a no-op or an
 * anomaly record, never a second movement of money.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {RefundEvidenceInput} input What was learned.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<RefundEvidenceResult>} What happened.
 */
export async function applyRefundEvidence(
  db: Firestore,
  loc: RefundLocation,
  input: RefundEvidenceInput,
  now: Timestamp = Timestamp.now(),
): Promise<RefundEvidenceResult> {
  return db.runTransaction(async (tx): Promise<RefundEvidenceResult> => {
    const read = await readRefundContext(db, tx, loc);
    if (read.kind !== "ok") {
      return {kind: "missing_or_malformed", what: read.what};
    }
    const ctx = read.context;
    return stageEvidence(tx, ctx, input, now);
  });
}

/**
 * The transaction body of `applyRefundEvidence`, over already-read documents.
 *
 * @param {Transaction} tx The transaction (writes only here).
 * @param {RefundContext} ctx The documents as read in `tx`.
 * @param {RefundEvidenceInput} input What was learned.
 * @param {Timestamp} now The write time.
 * @return {RefundEvidenceResult} What was staged.
 */
function stageEvidence(
  tx: Transaction,
  ctx: RefundContext,
  input: RefundEvidenceInput,
  now: Timestamp,
): RefundEvidenceResult {
  const {refund, payment} = ctx;
  const eventKey = input.kind === "provider_refund" ? input.providerEventKey : undefined;

  if (input.kind === "provider_refund") {
    const pr = input.providerRefund;
    const mismatch: RefundAnomalyCode | null =
      pr.providerPaymentId !== refund.providerPaymentId ? "provider_payment_mismatch" :
        pr.amountInPaise !== refund.amountInPaise ? "provider_amount_mismatch" :
          pr.currency !== refund.currency ? "provider_currency_mismatch" :
            refund.providerRefundId !== undefined && refund.providerRefundId !== pr.id ?
              "provider_refund_id_mismatch" : null;
    if (mismatch !== null) {
      stageAnomaly(tx, ctx, mismatch, `${pr.id}:${eventKey ?? input.source}`, input.source, now, eventKey);
      return {kind: "anomaly", code: mismatch};
    }
  }

  const aggregates = readRefundAggregates(payment);
  const evidence = input.kind === "provider_refund" ?
    {kind: "provider_status" as const, providerStatus: input.providerRefund.status} :
    {kind: "definitive_rejection" as const};
  const plan = planRefundTransition({
    current: refund.status,
    amountInPaise: refund.amountInPaise,
    aggregates,
    evidence,
  });
  const {decision} = plan;

  if (decision.outcome === "noop") {
    return {kind: "noop", reason: decision.reason};
  }
  if (decision.outcome === "reject") {
    const code: RefundAnomalyCode = input.kind === "definitive_rejection" ?
      "rejection_after_provider_acceptance" : "contradicts_terminal_state";
    stageAnomaly(
      tx, ctx, code,
      `${input.kind === "provider_refund" ? input.providerRefund.id : "rejection"}:${eventKey ?? input.source}:${refund.status}`,
      input.source, now, eventKey,
    );
    return {kind: "anomaly", code};
  }

  // decision.outcome === "apply"
  const to = decision.to;
  const next: Refund = {...refund, status: to, updatedAt: now};
  let failureCode: string | undefined;
  if (input.kind === "provider_refund") {
    const pr = input.providerRefund;
    next.providerRefundId = pr.id;
    next.providerStatus = pr.status;
    if (pr.speedRequested !== undefined) {
      next.providerSpeedRequested = pr.speedRequested;
    }
    if (pr.speedProcessed !== undefined) {
      next.providerSpeedProcessed = pr.speedProcessed;
    }
    if (input.source === "submit") {
      next.lastSubmitOutcome = "ok";
    }
    if (eventKey !== undefined) {
      next.lastWebhookEventKey = eventKey;
    }
    if (to === "failed") {
      failureCode = "provider_refund_failed";
    }
  } else {
    next.lastSubmitOutcome = "definitive_rejection";
    failureCode = safeFailureCode(input.code);
    next.failureMessage = bounded(input.message, REFUND_FAILURE_MESSAGE_MAX_LENGTH) || "The provider refused the refund.";
  }
  if (failureCode !== undefined) {
    next.failureCode = failureCode;
    next.failureMessage ??= "The refund did not complete.";
  } else {
    delete next.failureCode;
    delete next.failureMessage;
  }
  if (to === "pending") {
    next.pendingAt = refund.pendingAt ?? now;
  } else if (to === "processed") {
    next.processedAt = now;
  } else {
    next.failedAt = now;
  }
  // Only a live (non-terminal) refund is ever scheduled or leased.
  delete next.submitLeaseExpiresAt;
  if (isTerminalRefundStatus(to)) {
    delete next.nextAttemptAt;
  } else {
    next.nextAttemptAt = Timestamp.fromMillis(now.toMillis() + PENDING_POLL_INTERVAL_MS);
  }
  parseRefund(next, next.id, next.paymentId, next.orderId, next.organizationId, next.outletId, next.menuId);

  if (to === "failed") {
    // The customer's money has NOT been returned: a person must see it (and may retry). A terminal
    // refund is never scheduled, so this only affects what the payment and order report.
    next.attentionRequired = true;
  }
  const flagged = paymentIsFlagged(payment) || next.attentionRequired;
  const updates = figuresUpdates(plan.aggregates, flagged, now);
  const audit = transitionAudit(ctx.refundRef, {
    from: decision.from,
    to,
    source: input.source,
    at: now,
    providerEventKey: eventKey,
    providerStatus: input.kind === "provider_refund" ? input.providerRefund.status : undefined,
    failureCode,
  }, refund);

  tx.set(ctx.refundRef, next);
  tx.update(ctx.paymentRef, updates.payment);
  tx.update(ctx.orderRef, updates.order);
  tx.create(audit.ref, audit.data);
  // The outbox event for this logical fact, in this same transaction (see `notificationEvents.ts`).
  // `pending` is internal progress and has none; a repeat is a no-op above and never reaches here.
  if (to === "processed" || to === "failed") {
    recordRefundNotificationEvent(
      ctx.refundRef.firestore, tx, next, to === "processed" ? "refund_completed" : "refund_failed", now,
    );
  }
  return {kind: "applied", from: decision.from, to};
}

/** How long a `pending` refund waits before the reconciler looks it up again (webhooks are the fast path). */
export const PENDING_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Flags a refund (and so its payment and the order's mirror) as needing a person
 * and records why. Stops all automatic work on the refund.
 *
 * @param {Transaction} tx The transaction.
 * @param {RefundContext} ctx The documents as read in `tx`.
 * @param {RefundAnomalyCode} code What is wrong.
 * @param {string} discriminator Makes a repeat of this exact anomaly the same record.
 * @param {RefundTransitionSource} source What noticed it.
 * @param {Timestamp} now The write time.
 * @param {string} [eventKey] The webhook event, if one.
 */
function stageAnomaly(
  tx: Transaction,
  ctx: RefundContext,
  code: RefundAnomalyCode,
  discriminator: string,
  source: RefundTransitionSource,
  now: Timestamp,
  eventKey?: string,
): void {
  const aggregates = readRefundAggregates(ctx.payment);
  const updates = figuresUpdates(aggregates, true, now);
  tx.update(ctx.refundRef, {
    attentionRequired: true,
    updatedAt: now,
    nextAttemptAt: FieldValue.delete(),
    submitLeaseExpiresAt: FieldValue.delete(),
  });
  tx.update(ctx.paymentRef, updates.payment);
  tx.update(ctx.orderRef, updates.order);
  tx.set(anomalyRef(ctx.refundRef, code, discriminator), {
    kind: "anomaly",
    code,
    refundId: ctx.refund.id,
    orderId: ctx.refund.orderId,
    refundStatus: ctx.refund.status,
    source,
    at: now,
    ...(eventKey !== undefined ? {providerEventKey: eventKey} : {}),
  });
  logger.error("A refund needs attention.", {refundId: ctx.refund.id, orderId: ctx.refund.orderId, code, source});
}

/**
 * Flags a refund for a person without any provider evidence (lookup conflict,
 * exhausted attempts, a Zesto-side request error), in its own transaction.
 * Idempotent.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {RefundAnomalyCode} code What is wrong.
 * @param {string} discriminator Makes a repeat the same record.
 * @param {RefundTransitionSource} source What noticed it.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<boolean>} Whether a refund was flagged (false if it is gone or malformed).
 */
export async function flagRefundAttention(
  db: Firestore,
  loc: RefundLocation,
  code: RefundAnomalyCode,
  discriminator: string,
  source: RefundTransitionSource,
  now: Timestamp = Timestamp.now(),
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const read = await readRefundContext(db, tx, loc);
    if (read.kind !== "ok") {
      return false;
    }
    stageAnomaly(tx, read.context, code, discriminator, source, now);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Recording a submission attempt that moved nothing
// ---------------------------------------------------------------------------

export interface SubmitBookkeepingInput {
  /** The lease this caller took; bookkeeping applies only while it is still the current one. */
  leaseExpiresAt: Timestamp;
  outcome: RefundSubmitOutcome | undefined;
  /** Absent: the attempt found nothing wrong (a `pending` refund still pending); old failure info is cleared. */
  failureCode?: string;
  failureMessage?: string;
  nextAttemptAt: Timestamp;
  /** Stop all automatic work: the refund needs a person. */
  exhausted?: boolean;
}

/**
 * Records that an attempt ended without moving the refund (a timeout, a retryable
 * or configuration failure, a failed lookup): releases the lease, schedules the
 * next attempt and keeps the failure's short code. NEVER changes `status` or any
 * money — a lease timeout or a failed call is not a failed refund.
 *
 * Applies only if this caller's lease is still the refund's current one and the
 * refund is still non-terminal: otherwise somebody else (a webhook, a newer
 * worker) already moved on and this is a no-op.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundLocation} loc The refund's coordinates.
 * @param {SubmitBookkeepingInput} input The attempt's outcome.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<"recorded" | "superseded">} Whether it was recorded.
 */
export async function recordSubmitBookkeeping(
  db: Firestore,
  loc: RefundLocation,
  input: SubmitBookkeepingInput,
  now: Timestamp = Timestamp.now(),
): Promise<"recorded" | "superseded"> {
  return db.runTransaction(async (tx) => {
    const read = await readRefundContext(db, tx, loc);
    if (read.kind !== "ok") {
      return "superseded";
    }
    const ctx = read.context;
    const lease = ctx.refund.submitLeaseExpiresAt;
    if (isTerminalRefundStatus(ctx.refund.status) || lease === undefined || !lease.isEqual(input.leaseExpiresAt)) {
      return "superseded";
    }
    const update: Record<string, unknown> = {
      submitLeaseExpiresAt: FieldValue.delete(),
      updatedAt: now,
      ...(input.failureCode !== undefined ?
        {
          failureCode: safeFailureCode(input.failureCode),
          failureMessage: bounded(input.failureMessage ?? "", REFUND_FAILURE_MESSAGE_MAX_LENGTH) ||
            "The attempt did not complete.",
        } :
        {failureCode: FieldValue.delete(), failureMessage: FieldValue.delete()}),
    };
    if (input.outcome !== undefined) {
      update.lastSubmitOutcome = input.outcome;
    }
    if (input.exhausted === true) {
      const aggregates = readRefundAggregates(ctx.payment);
      const figures = figuresUpdates(aggregates, true, now);
      update.attentionRequired = true;
      update.nextAttemptAt = FieldValue.delete();
      tx.update(ctx.paymentRef, figures.payment);
      tx.update(ctx.orderRef, figures.order);
      tx.set(anomalyRef(ctx.refundRef, "attempts_exhausted", ctx.refund.id), {
        kind: "anomaly",
        code: "attempts_exhausted",
        refundId: ctx.refund.id,
        orderId: ctx.refund.orderId,
        refundStatus: ctx.refund.status,
        source: "submit",
        at: now,
        failureCode: safeFailureCode(input.failureCode ?? "unknown"),
      });
      logger.error("A refund needs attention: automatic attempts are exhausted.", {
        refundId: ctx.refund.id, orderId: ctx.refund.orderId, failureCode: input.failureCode ?? "unknown",
      });
    } else {
      update.nextAttemptAt = input.nextAttemptAt;
    }
    tx.update(ctx.refundRef, update);
    return "recorded";
  });
}

// ---------------------------------------------------------------------------
// External / manual refund adoption
// ---------------------------------------------------------------------------

export type AdoptExternalRefundResult =
  | {kind: "adopted"; refundId: string}
  | {kind: "already_known"; refundId: string}
  | {kind: "belongs_to_zesto_refund"; refundId: string}
  | {kind: "not_adoptable"; code: RefundAnomalyCode};

/**
 * Adopts a refund the provider holds for a Zesto payment that Zesto did not
 * create (made by hand in the provider's dashboard, or any refund with no local
 * document): creates a local refund of source `reconciliation`, reason `external`,
 * flagged `attentionRequired` because its provenance is uncertain, and books its
 * money exactly like a refund of the same status would be.
 *
 * It never cancels the order and never assumes Zesto caused it. If the figures
 * would break the payment's invariant (`refunded + pending <= captured`) or the
 * payment is not safely refundable, NOTHING is adopted: the payment is flagged
 * and an anomaly record written, so local accounting is never corrupted.
 *
 * Idempotent: a provider refund already adopted (or already a Zesto refund's
 * `providerRefundId`) is reported, never duplicated. A provider refund that carries
 * a Zesto refund's own identifier belongs to that refund and is NOT adopted here.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Omit<RefundLocation, "refundId">} paymentLoc The payment's coordinates.
 * @param {ProviderRefund} providerRefund The provider's refund.
 * @param {RefundTransitionSource} source What found it.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<AdoptExternalRefundResult>} What happened.
 */
export async function adoptExternalRefund(
  db: Firestore,
  paymentLoc: Omit<RefundLocation, "refundId">,
  providerRefund: ProviderRefund,
  source: RefundTransitionSource,
  now: Timestamp = Timestamp.now(),
): Promise<AdoptExternalRefundResult> {
  return db.runTransaction(async (tx): Promise<AdoptExternalRefundResult> => {
    const orderRef = orderRefFor(db, paymentLoc);
    const paymentRef = paymentRefFor(db, paymentLoc);
    const [orderSnap, paymentSnap, known] = await Promise.all([
      tx.get(orderRef),
      tx.get(paymentRef),
      tx.get(paymentRef.collection("refunds").where("providerRefundId", "==", providerRefund.id).limit(1)),
    ]);
    if (!orderSnap.exists || !paymentSnap.exists) {
      return {kind: "not_adoptable", code: "external_refund_not_applicable"};
    }
    if (!known.empty) {
      return {kind: "already_known", refundId: known.docs[0].id};
    }
    const order = parseOrder(
      orderSnap.data(), paymentLoc.orderId, paymentLoc.organizationId, paymentLoc.outletId, paymentLoc.menuId,
    );
    const payment = parsePayment(
      paymentSnap.data(), paymentLoc.paymentId, paymentLoc.orderId,
      paymentLoc.organizationId, paymentLoc.outletId, paymentLoc.menuId,
    );

    // A refund that names one of Zesto's own refunds is not external.
    const claimedId = [providerRefund.receipt, providerRefund.notes.zestoRefundId]
      .find((value): value is string => value !== undefined && parseRefundId(value)?.orderId === order.id);
    if (claimedId !== undefined) {
      return {kind: "belongs_to_zesto_refund", refundId: claimedId};
    }

    const refundability = assessPaymentRefundability(payment);
    const fits = refundability.kind === "refundable" &&
      payment.providerPaymentId === providerRefund.providerPaymentId &&
      providerRefund.currency === "INR" &&
      Number.isSafeInteger(providerRefund.amountInPaise) && providerRefund.amountInPaise >= 1 &&
      (providerRefund.status === "failed" ||
        providerRefund.amountInPaise <= refundability.remainingInPaise);
    if (!fits || refundability.kind !== "refundable") {
      const aggregates = readRefundAggregates(payment);
      const flaggedUpdates = figuresUpdates(aggregates, true, now);
      tx.update(paymentRef, flaggedUpdates.payment);
      tx.update(orderRef, flaggedUpdates.order);
      tx.set(anomalyRef(paymentRef, "external_refund_not_applicable", providerRefund.id), {
        kind: "anomaly",
        code: "external_refund_not_applicable",
        orderId: order.id,
        providerRefundId: providerRefund.id,
        providerStatus: providerRefund.status,
        amountInPaise: providerRefund.amountInPaise,
        source,
        at: now,
      });
      logger.error("A provider refund cannot be adopted without breaking the payment's accounting.", {
        orderId: order.id, providerRefundId: providerRefund.id, source,
      });
      return {kind: "not_adoptable", code: "external_refund_not_applicable"};
    }

    const slot = await readNextRefundSlot(tx, paymentRef, payment);
    const status: RefundStatus = providerRefund.status;
    let aggregates = refundability.aggregates;
    if (status === "pending") {
      aggregates = {...aggregates, refundPendingInPaise: aggregates.refundPendingInPaise + providerRefund.amountInPaise};
    } else if (status === "processed") {
      aggregates = {...aggregates, refundedInPaise: aggregates.refundedInPaise + providerRefund.amountInPaise};
    }
    const refund: Refund = {
      id: slot.refundId,
      paymentId: payment.id,
      orderId: order.id,
      organizationId: order.organizationId,
      outletId: order.outletId,
      menuId: order.menuId,
      userId: order.userId,
      providerPaymentId: providerRefund.providerPaymentId,
      amountInPaise: providerRefund.amountInPaise,
      currency: "INR",
      status,
      reason: "external",
      source: "reconciliation",
      initiatedBy: REFUND_SYSTEM_INITIATOR,
      initiatedByRole: "system",
      idempotencyKey: refundIdempotencyKeyFor(slot.refundId),
      providerRefundId: providerRefund.id,
      providerStatus: providerRefund.status,
      submitAttempts: 0,
      createdAt: now,
      updatedAt: now,
      // Provenance is uncertain by definition: a person should look at it.
      attentionRequired: true,
      ...(status === "pending" ? {pendingAt: now} : {}),
      ...(status === "processed" ? {processedAt: now} : {}),
      ...(status === "failed" ? {failedAt: now, failureCode: "provider_refund_failed", failureMessage: "The refund did not complete."} : {}),
    };
    parseRefund(refund, refund.id, payment.id, order.id, order.organizationId, order.outletId, order.menuId);

    const figures = figuresUpdates(aggregates, true, now);
    tx.create(slot.refundRef, refund);
    tx.update(paymentRef, {...figures.payment, refundSeq: slot.seq});
    tx.update(orderRef, figures.order);
    tx.create(slot.refundRef.collection("transitions").doc("adopted"), {
      kind: "adoption",
      refundId: refund.id,
      orderId: order.id,
      to: status,
      source,
      actor: REFUND_SYSTEM_INITIATOR,
      at: now,
      providerStatus: providerRefund.status,
    });
    logger.warn("An external provider refund was adopted and flagged for review.", {
      orderId: order.id, refundId: refund.id, source,
    });
    return {kind: "adopted", refundId: refund.id};
  });
}

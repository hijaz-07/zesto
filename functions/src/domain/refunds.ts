import {Timestamp} from "firebase-admin/firestore";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {
  releaseFailedRefund,
  settleProcessedRefund,
  type RefundAggregates,
} from "./refundAmounts";

/**
 * `organizations/{org}/outlets/{outlet}/menus/{menu}/orders/{orderId}/payments/{paymentId}/refunds/{refundId}`
 * — one REFUND ATTEMPT against a captured payment: the authoritative local
 * ledger of one conversation with the provider about one slice of money.
 * Nested under the payment like `payments` is under the order, so tenant
 * isolation is structural.
 *
 * This module is the foundation only: the schema, the identifiers, the state
 * machine and its money accounting — all pure. Nothing here creates a document,
 * calls the provider, or reads a clock; those belong to later checkpoints.
 *
 * A refund is its own lifecycle, independent of the order's. An order can be
 * `cancelled` while its refund is still `requested`/`pending`, or has `failed`.
 * `payment.status` stays `succeeded` throughout — the money WAS captured; the
 * aggregates on the payment (`domain/refundAmounts.ts`) track how much has
 * been, or is being, given back.
 *
 * Status:
 * - `requested`: the intent is committed locally. The provider's outcome is
 *   unknown or not yet attempted. Money is reserved (`refundPendingInPaise`).
 * - `pending`: the provider accepted it and gave it an ID; not yet settled.
 * - `processed`: the provider says it is done. Terminal.
 * - `failed`: the provider confirmed failure, or definitively rejected the
 *   request. Terminal; a retry is a NEW refund (a new ID and idempotency key),
 *   never a reopening of this one.
 */

export const REFUND_STATUS_VALUES = ["requested", "pending", "processed", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUS_VALUES)[number];

/** Why money is being given back. */
export const REFUND_REASON_VALUES = [
  "customer_cancelled",
  "outlet_cancelled",
  "system_cancelled",
  "late_capture_after_cancel",
  "external",
] as const;
export type RefundReason = (typeof REFUND_REASON_VALUES)[number];

/**
 * What started this refund. A refund adopted from the provider's own records
 * (made from the provider's dashboard) is `reconciliation` with reason
 * `external`.
 */
export const REFUND_SOURCE_VALUES = ["cancellation", "retry", "reconciliation"] as const;
export type RefundSource = (typeof REFUND_SOURCE_VALUES)[number];

/** Who started it: a person, or Zesto itself. */
export const REFUND_INITIATOR_ROLE_VALUES = ["customer", "organization", "system"] as const;
export type RefundInitiatorRole = (typeof REFUND_INITIATOR_ROLE_VALUES)[number];

/** The `initiatedBy` value for a refund no person started. */
export const REFUND_SYSTEM_INITIATOR = "system";

/** The provider's own refund status, as last seen (never invented locally). */
export const PROVIDER_REFUND_STATUS_VALUES = ["pending", "processed", "failed"] as const;
export type ProviderRefundStatus = (typeof PROVIDER_REFUND_STATUS_VALUES)[number];

/** What the last attempt to submit the refund to the provider concluded. */
export const REFUND_SUBMIT_OUTCOME_VALUES = ["ok", "definitive_rejection", "unknown"] as const;
export type RefundSubmitOutcome = (typeof REFUND_SUBMIT_OUTCOME_VALUES)[number];

/** Longest stored `failureMessage` (bounded; never a stack trace or a payload). */
export const REFUND_FAILURE_MESSAGE_MAX_LENGTH = 300;

/**
 * Refunds use the provider's normal flow. The speed is not a stored choice and
 * not an input anywhere: this is the one value, named so no caller invents another.
 */
export const REFUND_PROVIDER_SPEED = "normal";

export interface Refund {
  /** Deterministic: `refundIdFor(orderId, seq)`. */
  id: string;
  paymentId: string;
  orderId: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  /** The customer who placed the order and is being refunded. */
  userId: string;
  /**
   * The provider's payment being refunded. Stored here rather than inferred from
   * the payment document, whose `providerPaymentId` can be overwritten by a
   * later attempt.
   */
  providerPaymentId: string;
  /** Integer paise, at least 1. Immutable once written. */
  amountInPaise: number;
  currency: "INR";
  status: RefundStatus;
  reason: RefundReason;
  source: RefundSource;
  /** A user's Descope ID, or `REFUND_SYSTEM_INITIATOR`. */
  initiatedBy: string;
  initiatedByRole: RefundInitiatorRole;
  /** Sent to the provider so a repeat of the same request cannot refund twice. Equals `id`. */
  idempotencyKey: string;
  providerRefundId?: string;
  providerStatus?: ProviderRefundStatus;
  providerSpeedRequested?: "normal" | "optimum";
  providerSpeedProcessed?: "normal" | "instant";
  /** How many times submission to the provider has been started. */
  submitAttempts: number;
  lastSubmitAt?: Timestamp;
  lastSubmitOutcome?: RefundSubmitOutcome;
  /** While in the future, one submitter owns this refund. */
  submitLeaseExpiresAt?: Timestamp;
  /** When a retry or reconciliation may next look at it. */
  nextAttemptAt?: Timestamp;
  failureCode?: string;
  failureMessage?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  pendingAt?: Timestamp;
  processedAt?: Timestamp;
  failedAt?: Timestamp;
  /** Set when something about this refund needs a person (an anomaly amounts cannot show). */
  attentionRequired: boolean;
  /** The last webhook event (`razorpayWebhookEvents` key) that touched this refund. */
  lastWebhookEventKey?: string;
}

// ---------------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------------

/** The provider's idempotency-key alphabet and minimum length (alphanumerics, `_`, `-`; 10+). */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{10,}$/;
const REFUND_ID_PATTERN = /^(.+)-r([1-9][0-9]*)$/;

/**
 * The deterministic refund ID: `${orderId}-r${seq}`. `seq` is the payment's
 * `refundSeq` after increment, so the Nth refund of an order is always the same
 * document — which is what lets creating it be `create` (never a double).
 *
 * Injective: `seq` is digits only after a literal `-r`, so no two
 * (orderId, seq) pairs produce the same ID, even for order IDs that themselves
 * contain `-r<digits>`.
 *
 * @param {string} orderId The order's document ID.
 * @param {number} seq The refund's number for this payment, starting at 1.
 * @return {string} The refund's document ID.
 * @throws {Error} If `orderId` is not a valid document ID or `seq` not a positive safe integer.
 */
export function refundIdFor(orderId: string, seq: number): string {
  if (!isValidDocumentId(orderId)) {
    throw new Error("Invalid order ID for a refund ID.");
  }
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("A refund sequence number must be a positive safe integer.");
  }
  return `${orderId}-r${seq}`;
}

/**
 * @param {string} refundId A refund document ID.
 * @return {{orderId: string; seq: number} | null} The pair it encodes, or null
 *   if it is not in `refundIdFor`'s form.
 */
export function parseRefundId(refundId: string): {orderId: string; seq: number} | null {
  const match = REFUND_ID_PATTERN.exec(refundId);
  if (!match) {
    return null;
  }
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq) || !isValidDocumentId(match[1])) {
    return null;
  }
  return {orderId: match[1], seq};
}

/**
 * The provider idempotency key for a refund: the refund's own deterministic ID.
 * There is no reason to mint a second identifier — a retry of the same refund
 * reuses the same key by construction, and a NEW refund (a new `seq`) gets a new one.
 *
 * @param {string} refundId A refund's deterministic ID.
 * @return {string} The idempotency key.
 * @throws {Error} If the ID is not usable as a provider idempotency key (too
 *   short, or outside the provider's alphabet) — an order ID containing other
 *   characters cannot be refunded safely and must fail loudly, not be mangled.
 */
export function refundIdempotencyKeyFor(refundId: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(refundId)) {
    throw new Error("This refund ID is not usable as a provider idempotency key.");
  }
  return refundId;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const timestampSchema = (field: string) => z.custom<Timestamp>(
  (value) => value instanceof Timestamp,
  `${field} must be a Firestore Timestamp`,
);

const refundDocSchema = z.object({
  id: z.string().min(1),
  paymentId: z.string().min(1),
  orderId: z.string().min(1),
  organizationId: z.string().min(1),
  outletId: z.string().min(1),
  menuId: z.string().min(1),
  userId: z.string().min(1),
  providerPaymentId: z.string().min(1),
  amountInPaise: z.number().int().min(1),
  currency: z.literal("INR"),
  status: z.enum(REFUND_STATUS_VALUES),
  reason: z.enum(REFUND_REASON_VALUES),
  source: z.enum(REFUND_SOURCE_VALUES),
  initiatedBy: z.string().min(1),
  initiatedByRole: z.enum(REFUND_INITIATOR_ROLE_VALUES),
  idempotencyKey: z.string().min(1),
  providerRefundId: z.string().min(1).optional(),
  providerStatus: z.enum(PROVIDER_REFUND_STATUS_VALUES).optional(),
  providerSpeedRequested: z.enum(["normal", "optimum"]).optional(),
  providerSpeedProcessed: z.enum(["normal", "instant"]).optional(),
  submitAttempts: z.number().int().min(0),
  lastSubmitAt: timestampSchema("lastSubmitAt").optional(),
  lastSubmitOutcome: z.enum(REFUND_SUBMIT_OUTCOME_VALUES).optional(),
  submitLeaseExpiresAt: timestampSchema("submitLeaseExpiresAt").optional(),
  nextAttemptAt: timestampSchema("nextAttemptAt").optional(),
  failureCode: z.string().min(1).max(100).optional(),
  failureMessage: z.string().min(1).max(REFUND_FAILURE_MESSAGE_MAX_LENGTH).optional(),
  createdAt: timestampSchema("createdAt"),
  updatedAt: timestampSchema("updatedAt"),
  pendingAt: timestampSchema("pendingAt").optional(),
  processedAt: timestampSchema("processedAt").optional(),
  failedAt: timestampSchema("failedAt").optional(),
  attentionRequired: z.boolean(),
  lastWebhookEventKey: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  const need = (present: boolean, field: string, message: string): void => {
    if (!present) {
      ctx.addIssue({code: "custom", message, path: [field]});
    }
  };
  const forbid = (present: boolean, field: string): void => {
    if (present) {
      ctx.addIssue({code: "custom", message: `${field} is not allowed while ${value.status}.`, path: [field]});
    }
  };

  // Each status carries exactly the evidence that put it there.
  switch (value.status) {
  case "requested":
    forbid(value.providerRefundId !== undefined, "providerRefundId");
    forbid(value.pendingAt !== undefined, "pendingAt");
    forbid(value.processedAt !== undefined, "processedAt");
    forbid(value.failedAt !== undefined, "failedAt");
    break;
  case "pending":
    need(value.providerRefundId !== undefined, "providerRefundId", "A pending refund has a provider refund ID.");
    need(value.pendingAt !== undefined, "pendingAt", "A pending refund records when it became pending.");
    forbid(value.processedAt !== undefined, "processedAt");
    forbid(value.failedAt !== undefined, "failedAt");
    break;
  case "processed":
    need(value.providerRefundId !== undefined, "providerRefundId", "A processed refund has a provider refund ID.");
    need(value.processedAt !== undefined, "processedAt", "A processed refund records when it was processed.");
    forbid(value.failedAt !== undefined, "failedAt");
    break;
  case "failed":
    need(value.failedAt !== undefined, "failedAt", "A failed refund records when it failed.");
    forbid(value.processedAt !== undefined, "processedAt");
    break;
  }

  const identity = parseRefundId(value.id);
  if (identity === null || identity.orderId !== value.orderId) {
    ctx.addIssue({code: "custom", message: "The refund ID does not encode its order.", path: ["id"]});
  }
  if (value.idempotencyKey !== value.id) {
    ctx.addIssue({code: "custom", message: "The idempotency key must equal the refund ID.", path: ["idempotencyKey"]});
  }
});

/**
 * Parses a stored refund document, validating it was written in the expected
 * shape and that its coordinates match the path it was read from (the same
 * discipline as `parsePayment`).
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The refund document ID it was read from.
 * @param {string} expectedPaymentId The parent payment's ID.
 * @param {string} expectedOrderId The parent order's ID.
 * @param {string} expectedOrganizationId The parent order's organization ID.
 * @param {string} expectedOutletId The parent order's outlet ID.
 * @param {string} expectedMenuId The parent order's menu ID.
 * @return {Refund} The parsed refund.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parseRefund(
  data: unknown,
  expectedId: string,
  expectedPaymentId: string,
  expectedOrderId: string,
  expectedOrganizationId: string,
  expectedOutletId: string,
  expectedMenuId: string,
): Refund {
  const parsed = refundDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== expectedId ||
    parsed.data.paymentId !== expectedPaymentId ||
    parsed.data.orderId !== expectedOrderId ||
    parsed.data.organizationId !== expectedOrganizationId ||
    parsed.data.outletId !== expectedOutletId ||
    parsed.data.menuId !== expectedMenuId
  ) {
    throw new Error(
      `Malformed refund document at .../orders/${expectedOrderId}/payments/${expectedPaymentId}/refunds/${expectedId}.`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** `processed` and `failed` are terminal: nothing moves out of them. */
export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = ["processed", "failed"];

/**
 * @param {RefundStatus} status A refund status.
 * @return {boolean} Whether it is terminal.
 */
export function isTerminalRefundStatus(status: RefundStatus): boolean {
  return TERMINAL_REFUND_STATUSES.includes(status);
}

/**
 * What a transition is justified by. A transition needs EVIDENCE; "nothing
 * came back" is not evidence of anything.
 * - `provider_status`: the provider reported this status for the refund — in an
 *   API response, a verified webhook, or a lookup.
 * - `definitive_rejection`: the provider's API definitively REFUSED the create
 *   request (a 4xx that creates nothing). Only valid from `requested`.
 * - `unknown_outcome`: a timeout, network error or 5xx — the request may or may
 *   not have been applied. Never causes a transition.
 */
export type RefundTransitionEvidence =
  | {kind: "provider_status"; providerStatus: ProviderRefundStatus}
  | {kind: "definitive_rejection"}
  | {kind: "unknown_outcome"};

export type RefundTransitionRejectionCode =
  | "processed_is_terminal"
  | "failed_is_terminal"
  | "rejection_not_applicable"
  | "insufficient_evidence";

export type RefundTransitionDecision =
  | {outcome: "apply"; from: RefundStatus; to: Exclude<RefundStatus, "requested">}
  | {outcome: "noop"; reason: "already_in_state" | "stale_event"}
  | {outcome: "reject"; code: RefundTransitionRejectionCode; anomaly: boolean};

/**
 * Decides, from a refund's CURRENT status and one piece of evidence alone,
 * whether to move it, ignore the evidence, or refuse it. Pure; the later
 * transactional layer calls it on the freshly-read refund, so arrival order
 * never matters — only state does.
 *
 * Valid moves: `requested` -> `pending` | `processed` | `failed`, and
 * `pending` -> `processed` | `failed`. (`requested` -> `processed` is the
 * webhook that beats the API response.)
 *
 * - Repeated evidence for the state already held: `noop` / `already_in_state`.
 * - A late, earlier-stage event (`pending` after `processed` or `failed`):
 *   `noop` / `stale_event` — out-of-order delivery is expected and harmless.
 * - Evidence that contradicts a terminal state (`failed` after `processed`;
 *   `processed` after `failed`) is REFUSED and flagged `anomaly`: the provider
 *   and Zesto disagree about money, which a person must look at. It is never
 *   accepted as a normal transition.
 * - `unknown_outcome` never moves anything (`insufficient_evidence`).
 *
 * @param {RefundStatus} current The refund's status as stored.
 * @param {RefundTransitionEvidence} evidence What was learned.
 * @return {RefundTransitionDecision} What to do.
 */
export function decideRefundTransition(
  current: RefundStatus,
  evidence: RefundTransitionEvidence,
): RefundTransitionDecision {
  if (evidence.kind === "unknown_outcome") {
    return {outcome: "reject", code: "insufficient_evidence", anomaly: false};
  }

  if (evidence.kind === "definitive_rejection") {
    switch (current) {
    case "requested":
      return {outcome: "apply", from: "requested", to: "failed"};
    case "failed":
      return {outcome: "noop", reason: "already_in_state"};
    case "pending":
    case "processed":
      // A refund the provider already knows cannot also have been refused.
      return {outcome: "reject", code: "rejection_not_applicable", anomaly: true};
    }
  }

  const to = evidence.providerStatus;
  switch (current) {
  case "requested":
    return {outcome: "apply", from: "requested", to};
  case "pending":
    return to === "pending" ?
      {outcome: "noop", reason: "already_in_state"} :
      {outcome: "apply", from: "pending", to};
  case "processed":
    if (to === "processed") {
      return {outcome: "noop", reason: "already_in_state"};
    }
    return to === "pending" ?
      {outcome: "noop", reason: "stale_event"} :
      {outcome: "reject", code: "processed_is_terminal", anomaly: true};
  case "failed":
    if (to === "failed") {
      return {outcome: "noop", reason: "already_in_state"};
    }
    return to === "pending" ?
      {outcome: "noop", reason: "stale_event"} :
      {outcome: "reject", code: "failed_is_terminal", anomaly: true};
  }
}

/**
 * The payment's refund figures after a refund moves between statuses. `pending`
 * moves no money; `processed` settles the reservation into `refunded`; `failed`
 * releases it back to `remaining`. Any other pair is not a move at all.
 *
 * @param {RefundAggregates} aggregates The payment's figures before.
 * @param {number} amountInPaise The refund's amount.
 * @param {RefundStatus} from The refund's status before.
 * @param {Exclude<RefundStatus, "requested">} to Its status after.
 * @return {RefundAggregates} The figures after.
 * @throws {Error} If `from`/`to` is not a legal move, or the amounts do not hold
 *   (`RefundAmountError`).
 */
export function aggregatesAfterRefundTransition(
  aggregates: RefundAggregates,
  amountInPaise: number,
  from: RefundStatus,
  to: Exclude<RefundStatus, "requested">,
): RefundAggregates {
  if (from === "requested" && to === "pending") {
    return aggregates;
  }
  if ((from === "requested" || from === "pending") && to === "processed") {
    return settleProcessedRefund(aggregates, amountInPaise);
  }
  if ((from === "requested" || from === "pending") && to === "failed") {
    return releaseFailedRefund(aggregates, amountInPaise);
  }
  throw new Error(`Not a refund transition: ${from} -> ${to}.`);
}

export interface PlanRefundTransitionInput {
  current: RefundStatus;
  amountInPaise: number;
  aggregates: RefundAggregates;
  evidence: RefundTransitionEvidence;
}

export interface RefundTransitionPlan {
  decision: RefundTransitionDecision;
  /** The figures to store: moved only when the decision is `apply`, else unchanged. */
  aggregates: RefundAggregates;
}

/**
 * The decision and the money it implies, together, so the two cannot disagree.
 *
 * @param {PlanRefundTransitionInput} input The refund's state, amount, the
 *   payment's figures and the evidence.
 * @return {RefundTransitionPlan} The decision and the resulting figures.
 */
export function planRefundTransition(input: PlanRefundTransitionInput): RefundTransitionPlan {
  const decision = decideRefundTransition(input.current, input.evidence);
  if (decision.outcome !== "apply") {
    return {decision, aggregates: input.aggregates};
  }
  return {
    decision,
    aggregates: aggregatesAfterRefundTransition(input.aggregates, input.amountInPaise, decision.from, decision.to),
  };
}

import type {Firestore} from "firebase-admin/firestore";
import {z} from "zod";
import type {ProviderRefund} from "../providers/refundGateway";
import {locatePaymentByProviderField} from "./paymentLookup";
import {
  adoptExternalRefund,
  applyRefundEvidence,
  refundLocationFromPath,
  type RefundLocation,
} from "./refundTransitions";
import {parseRefundId, PROVIDER_REFUND_STATUS_VALUES, type ProviderRefundStatus} from "./refunds";

/**
 * Razorpay REFUND webhooks: `refund.created`, `refund.processed`, `refund.failed`.
 *
 * They ride the existing pipeline (`razorpayWebhooks.ts`): the HMAC over the raw
 * body, the event claim/lease and the body-fingerprint conflict check all happen
 * BEFORE anything here runs. This module only parses the refund entity and
 * reconciles it:
 *
 * 1. LOCATE the local refund — by the provider's refund ID first (a collection-group
 *    lookup that must match exactly one), else by Zesto's own refund ID in the
 *    entity's `receipt`/`notes` (how a webhook that beats the create response is
 *    found), under the payment the event names. Never by amount.
 * 2. VALIDATE and APPLY through `applyRefundEvidence`: the provider payment, amount
 *    and currency must equal the stored refund's, and the move must be a valid
 *    monotonic one. A mismatch or a contradiction of a terminal state is recorded
 *    as an anomaly and flags the refund; it never changes money.
 * 3. A refund no local document accounts for, on a payment that IS Zesto's, is
 *    adopted as `external` (flagged for a person) — see `adoptExternalRefund`.
 *
 * Only a few fields of the entity are read (IDs, amount, currency, status, receipt,
 * Zesto's own two notes); everything else (customer, bank and fee details) is
 * stripped by the schema and never stored or logged.
 */

export const SUPPORTED_REFUND_WEBHOOK_EVENT_TYPES = ["refund.created", "refund.processed", "refund.failed"] as const;
export type RefundWebhookEventType = (typeof SUPPORTED_REFUND_WEBHOOK_EVENT_TYPES)[number];

/** `notes` is an object, or `[]` when empty. */
const notesSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const refundEntitySchema = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  amount: z.number().int().min(0),
  currency: z.string().min(1),
  status: z.string().min(1),
  receipt: z.string().min(1).nullish(),
  notes: notesSchema.nullish(),
});

export const refundEventSchema = z.object({
  event: z.enum(SUPPORTED_REFUND_WEBHOOK_EVENT_TYPES),
  payload: z.object({refund: z.object({entity: refundEntitySchema})}),
});

/** A supported refund event, reduced to what reconciliation uses. */
export interface RefundWebhookEvent {
  type: RefundWebhookEventType;
  providerRefundId: string;
  providerPaymentId: string;
  amountInPaise: number;
  currency: string;
  /** The entity's own `status` in this event's snapshot (unvalidated). */
  providerStatus: string;
  receipt?: string;
  zestoRefundId?: string;
  zestoOrderId?: string;
}

/**
 * @param {unknown} json The already-authenticated, parsed body.
 * @return {RefundWebhookEvent | null} The reduced event, or null if the payload lacks what reconciliation needs.
 */
export function parseRefundWebhookEvent(json: unknown): RefundWebhookEvent | null {
  const parsed = refundEventSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const entity = parsed.data.payload.refund.entity;
  const notes: Record<string, unknown> =
    entity.notes !== null && entity.notes !== undefined && !Array.isArray(entity.notes) ? entity.notes : {};
  const note = (key: string): string | undefined => {
    const value = notes[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const zestoRefundId = note("zestoRefundId");
  const zestoOrderId = note("zestoOrderId");
  return {
    type: parsed.data.event,
    providerRefundId: entity.id,
    providerPaymentId: entity.payment_id,
    amountInPaise: entity.amount,
    currency: entity.currency,
    providerStatus: entity.status,
    ...(entity.receipt ? {receipt: entity.receipt} : {}),
    ...(zestoRefundId !== undefined ? {zestoRefundId} : {}),
    ...(zestoOrderId !== undefined ? {zestoOrderId} : {}),
  };
}

/** What reconciliation did with an authenticated refund event. Every one is acknowledged with a 2xx. */
export type RefundWebhookOutcome =
  | "refund_pending"
  | "refund_processed"
  | "refund_failed"
  | "refund_noop_already_in_state"
  | "refund_noop_stale_event"
  | "refund_adopted_external"
  | "refund_external_already_known"
  | "ignored_unrecognized_refund"
  | "ignored_refund_status_mismatch"
  | "rejected_ambiguous_refund"
  | "rejected_ambiguous_payment"
  | "rejected_refund_payment_mismatch"
  | "rejected_refund_amount_mismatch"
  | "rejected_refund_currency_mismatch"
  | "rejected_refund_id_mismatch"
  | "rejected_refund_contradicts_terminal_state"
  | "rejected_external_refund_not_applicable";

/** The outcomes that mean Zesto's and Razorpay's records disagree and a person must look. */
export const ANOMALOUS_REFUND_OUTCOMES: ReadonlySet<string> = new Set<RefundWebhookOutcome>([
  "rejected_ambiguous_refund",
  "rejected_ambiguous_payment",
  "rejected_refund_payment_mismatch",
  "rejected_refund_amount_mismatch",
  "rejected_refund_currency_mismatch",
  "rejected_refund_id_mismatch",
  "rejected_refund_contradicts_terminal_state",
  "rejected_external_refund_not_applicable",
  "refund_adopted_external",
]);

/** The status each terminal event type must carry; `refund.created` carries whatever the refund is. */
const EXPECTED_STATUS: Partial<Record<RefundWebhookEventType, ProviderRefundStatus>> = {
  "refund.processed": "processed",
  "refund.failed": "failed",
};

type LocatedRefund =
  | {kind: "found"; loc: RefundLocation}
  | {kind: "none"}
  | {kind: "ambiguous"};

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundWebhookEvent} event The authenticated event.
 * @return {Promise<LocatedRefund>} The local refund the event is about, if any.
 */
async function locateRefund(db: Firestore, event: RefundWebhookEvent): Promise<LocatedRefund> {
  const byProviderId = await db
    .collectionGroup("refunds")
    .where("providerRefundId", "==", event.providerRefundId)
    .limit(2)
    .get();
  if (byProviderId.size > 1) {
    return {kind: "ambiguous"};
  }
  if (byProviderId.size === 1) {
    const loc = refundLocationFromPath(byProviderId.docs[0].ref.path);
    return loc === null ? {kind: "none"} : {kind: "found", loc};
  }

  // The provider ID is not known locally yet (the event beat the create response):
  // Zesto's own refund ID, which it put in the receipt and notes, finds it.
  const zestoRefundId = [event.zestoRefundId, event.receipt]
    .find((value): value is string => value !== undefined && parseRefundId(value) !== null);
  if (zestoRefundId === undefined) {
    return {kind: "none"};
  }
  const identity = parseRefundId(zestoRefundId);
  const located = await locatePaymentByProviderField(db, "providerPaymentId", event.providerPaymentId);
  if (located.kind === "ambiguous") {
    return {kind: "ambiguous"};
  }
  if (located.kind === "none" || identity === null || located.payment.orderId !== identity.orderId) {
    return {kind: "none"};
  }
  const p = located.payment;
  return {
    kind: "found",
    loc: {
      organizationId: p.organizationId, outletId: p.outletId, menuId: p.menuId,
      orderId: p.orderId, paymentId: p.id, refundId: zestoRefundId,
    },
  };
}

/**
 * Reconciles one authenticated, claimed refund event. See the file header.
 *
 * Idempotent and order-independent: a duplicate or out-of-order event is a no-op
 * (or an anomaly record), because the local transition re-reads the refund and
 * only ever moves it forward.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundWebhookEvent} event The authenticated event.
 * @param {string} eventKey The event's deduplication key (recorded in the audit trail).
 * @return {Promise<RefundWebhookOutcome>} What was done.
 */
export async function applyRefundWebhookEvent(
  db: Firestore,
  event: RefundWebhookEvent,
  eventKey: string,
): Promise<RefundWebhookOutcome> {
  const status = (PROVIDER_REFUND_STATUS_VALUES as readonly string[]).includes(event.providerStatus) ?
    (event.providerStatus as ProviderRefundStatus) : null;
  const expected = EXPECTED_STATUS[event.type];
  if (status === null || (expected !== undefined && status !== expected)) {
    return "ignored_refund_status_mismatch";
  }

  const located = await locateRefund(db, event);
  if (located.kind === "ambiguous") {
    return "rejected_ambiguous_refund";
  }

  if (located.kind === "found") {
    const result = await applyRefundEvidence(db, located.loc, {
      kind: "provider_refund",
      providerRefund: {
        id: event.providerRefundId,
        providerPaymentId: event.providerPaymentId,
        amountInPaise: event.amountInPaise,
        currency: event.currency,
        status,
      },
      source: "webhook",
      providerEventKey: eventKey,
    });
    switch (result.kind) {
    case "applied":
      return result.to === "pending" ? "refund_pending" :
        result.to === "processed" ? "refund_processed" : "refund_failed";
    case "noop":
      return result.reason === "already_in_state" ? "refund_noop_already_in_state" : "refund_noop_stale_event";
    case "missing_or_malformed":
      return "ignored_unrecognized_refund";
    case "anomaly":
      switch (result.code) {
      case "provider_payment_mismatch": return "rejected_refund_payment_mismatch";
      case "provider_amount_mismatch": return "rejected_refund_amount_mismatch";
      case "provider_currency_mismatch": return "rejected_refund_currency_mismatch";
      case "provider_refund_id_mismatch": return "rejected_refund_id_mismatch";
      default: return "rejected_refund_contradicts_terminal_state";
      }
    }
  }

  // No local refund accounts for this one: adopt it if the payment is Zesto's.
  const located2 = await locatePaymentByProviderField(db, "providerPaymentId", event.providerPaymentId);
  if (located2.kind === "none") {
    return "ignored_unrecognized_refund";
  }
  if (located2.kind === "ambiguous") {
    return "rejected_ambiguous_payment";
  }
  const p = located2.payment;
  const providerRefund: ProviderRefund = {
    id: event.providerRefundId,
    providerPaymentId: event.providerPaymentId,
    amountInPaise: event.amountInPaise,
    currency: event.currency,
    status,
    notes: event.zestoRefundId !== undefined ? {zestoRefundId: event.zestoRefundId} : {},
    ...(event.receipt !== undefined ? {receipt: event.receipt} : {}),
  };
  const adopted = await adoptExternalRefund(db, {
    organizationId: p.organizationId, outletId: p.outletId, menuId: p.menuId, orderId: p.orderId, paymentId: p.id,
  }, providerRefund, "webhook");
  switch (adopted.kind) {
  case "adopted":
    return "refund_adopted_external";
  case "already_known":
    return "refund_external_already_known";
  case "belongs_to_zesto_refund":
    // It names a Zesto refund that has no document: not ours to adopt, nothing to apply.
    return "ignored_unrecognized_refund";
  case "not_adoptable":
    return "rejected_external_refund_not_applicable";
  }
}

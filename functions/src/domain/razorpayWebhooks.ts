import {createHash} from "node:crypto";
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {
  markPaymentFailed,
  markPaymentSucceeded,
  parsePayment,
  type Payment,
} from "./payments";

/**
 * Razorpay webhook reconciliation (see root CLAUDE.md's "Never trust the
 * frontend for security" and docs/architecture/http-api.md's "Razorpay
 * webhook" section).
 *
 * The pipeline, in order — each stage only runs if the previous one passed:
 *
 * 1. SIGNATURE (route layer, `providers/razorpay.ts`'s
 *    `verifyWebhookSignature`): HMAC-SHA256 over the RAW request bytes with
 *    the webhook secret. Nothing below ever sees an unauthenticated body.
 * 2. PARSE (`parseWebhookBody`): JSON is parsed ONLY now, and only the few
 *    fields reconciliation needs are extracted.
 * 3. DEDUPE (`claimWebhookEvent`): a lease-based claim on
 *    `razorpayWebhookEvents/{eventKey}` so a retried or concurrent delivery
 *    of the same event performs the state-changing work at most once at a
 *    time — and a crash mid-processing never loses the event.
 * 4. RESOLVE + VALIDATE (`applyPaymentWebhookEvent`): the Zesto payment is
 *    found by Razorpay's own order ID (never by anything customer-supplied),
 *    and the provider, order ID, amount, currency, and event/payment status
 *    must all agree with Zesto's stored record.
 * 5. TRANSITION: the EXISTING trusted `markPaymentSucceeded` /
 *    `markPaymentFailed` do the work — this module deliberately contains no
 *    payment business logic of its own, so the webhook can never do
 *    something the Checkout-verification path could not.
 *
 * Delivery is at-least-once and unordered; every effect here is idempotent,
 * and an event is marked processed only AFTER its transition completed.
 */

/** Root collection holding webhook-event bookkeeping. Deliberately NOT under
 * a customer/organization path: a Razorpay webhook has no authenticated
 * customer. Backend-only (see firestore.rules). */
export const WEBHOOK_EVENTS_COLLECTION = "razorpayWebhookEvents";

/** v1 subscribes to exactly these two. NOT `order.paid`: subscribing to both
 * `payment.captured` and `order.paid` would deliver two success events for
 * one payment. */
export const SUPPORTED_WEBHOOK_EVENT_TYPES = ["payment.captured", "payment.failed"] as const;
export type SupportedWebhookEventType = (typeof SUPPORTED_WEBHOOK_EVENT_TYPES)[number];

/** How long a claim blocks other deliveries of the same event. Longer than
 * any realistic processing time (a couple of Firestore transactions), short
 * enough that a crashed attempt is retried promptly. */
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;

/** Longest event type string kept for logs/records. */
const MAX_EVENT_TYPE_LENGTH = 64;

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/** Only the fields reconciliation needs from Razorpay's payment entity.
 * Everything else in the payload (card/customer/bank details, fees, notes,
 * ...) is stripped by `safeParse` and never read, stored, or logged. */
const paymentEntitySchema = z.object({
  id: z.string().min(1),
  // Null/absent for payments not created through a Razorpay Order (e.g. a
  // payment link) — never a Zesto payment, so it's acknowledged and ignored
  // rather than rejected.
  order_id: z.string().min(1).nullish(),
  amount: z.number().int().min(0),
  currency: z.string().min(1),
  status: z.string().min(1),
});

const paymentEventSchema = z.object({
  event: z.enum(SUPPORTED_WEBHOOK_EVENT_TYPES),
  payload: z.object({
    payment: z.object({entity: paymentEntitySchema}),
  }),
});

const eventEnvelopeSchema = z.object({event: z.string().min(1)});

/** A supported payment event, reduced to what reconciliation uses. */
export interface PaymentWebhookEvent {
  type: SupportedWebhookEventType;
  /** Razorpay's payment ID (`pay_...`). */
  providerPaymentId: string;
  /** Razorpay's order ID (`order_...`), or null if the payment isn't tied to an order. */
  providerOrderId: string | null;
  amountInPaise: number;
  currency: string;
  /** The payment entity's own `status` in this event's snapshot. */
  providerPaymentStatus: string;
}

export type ParsedWebhookBody =
  | {kind: "malformed"}
  | {kind: "unsupported_event"; eventType: string}
  | {kind: "payment_event"; event: PaymentWebhookEvent};

/**
 * Parses an ALREADY-AUTHENTICATED webhook body. Call this only after
 * `verifyWebhookSignature` returned true for these exact bytes.
 *
 * - Not JSON, not an object, or no `event` string: `malformed`.
 * - An event type Zesto doesn't subscribe to: `unsupported_event` — safe to
 *   acknowledge, and never allowed to mutate anything.
 * - A supported type whose payload lacks the fields reconciliation needs:
 *   `malformed`.
 *
 * @param {Buffer} rawBody The verified raw request body.
 * @return {ParsedWebhookBody} The parse outcome.
 */
export function parseWebhookBody(rawBody: Buffer): ParsedWebhookBody {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return {kind: "malformed"};
  }

  const envelope = eventEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return {kind: "malformed"};
  }
  const eventType = envelope.data.event;
  if (!(SUPPORTED_WEBHOOK_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return {kind: "unsupported_event", eventType: eventType.slice(0, MAX_EVENT_TYPE_LENGTH)};
  }

  const parsed = paymentEventSchema.safeParse(json);
  if (!parsed.success) {
    return {kind: "malformed"};
  }
  const entity = parsed.data.payload.payment.entity;
  return {
    kind: "payment_event",
    event: {
      type: parsed.data.event,
      providerPaymentId: entity.id,
      providerOrderId: entity.order_id ?? null,
      amountInPaise: entity.amount,
      currency: entity.currency,
      providerPaymentStatus: entity.status,
    },
  };
}

// ---------------------------------------------------------------------------
// Event identity (deduplication key)
// ---------------------------------------------------------------------------

export interface WebhookEventIdentity {
  /** The Firestore document ID under `razorpayWebhookEvents`. */
  eventKey: string;
  keySource: "event_id_header" | "body_fingerprint";
  /** SHA-256 (hex) of the raw body. Stored with the event so the same event
   * ID can never be re-used to smuggle in a DIFFERENT body. */
  bodyFingerprint: string;
}

/** Razorpay's documented unique-per-event header (lower-cased, as Express
 * exposes it). */
export const WEBHOOK_EVENT_ID_HEADER = "x-razorpay-event-id";

const EVENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Derives the deduplication identity for an authenticated delivery.
 *
 * Razorpay documents `x-razorpay-event-id` as unique per event (the same
 * value on retries), so it is the primary key when present and well-formed.
 * Otherwise the key falls back to the SHA-256 fingerprint of the raw body —
 * deterministic for retries of the same payload, at the cost that two
 * distinct events with byte-identical bodies would collapse into one (not
 * expected: Razorpay payloads carry `created_at` and distinct entities).
 *
 * The header is NOT covered by the HMAC and is never used to authenticate
 * anything: signature verification has already succeeded by the time this
 * runs. And because it is unauthenticated metadata, the body fingerprint is
 * stored beside it so that re-using a known event ID with a different body
 * is detected (`claimWebhookEvent` → `fingerprint_conflict`) instead of
 * being mistaken for a harmless duplicate.
 *
 * Keys are namespaced (`evt_`/`body_`) so the two sources can never collide.
 *
 * @param {object} input The delivery's header and raw body.
 * @param {string | string[] | undefined} input.eventIdHeader The
 *   `x-razorpay-event-id` header value, if any.
 * @param {Buffer} input.rawBody The verified raw request body.
 * @return {WebhookEventIdentity} The event's identity.
 */
export function deriveWebhookEventIdentity(input: {
  eventIdHeader: string | string[] | undefined;
  rawBody: Buffer;
}): WebhookEventIdentity {
  const bodyFingerprint = createHash("sha256").update(input.rawBody).digest("hex");
  const header = Array.isArray(input.eventIdHeader) ? input.eventIdHeader[0] : input.eventIdHeader;
  const trimmed = header?.trim();
  if (trimmed && EVENT_ID_PATTERN.test(trimmed)) {
    return {eventKey: `evt_${trimmed}`, keySource: "event_id_header", bodyFingerprint};
  }
  return {eventKey: `body_${bodyFingerprint}`, keySource: "body_fingerprint", bodyFingerprint};
}

// ---------------------------------------------------------------------------
// Event claim / completion (deduplication)
// ---------------------------------------------------------------------------

export interface ClaimInput {
  identity: WebhookEventIdentity;
  eventType: string;
  providerOrderId?: string | null;
  providerPaymentId?: string;
}

export type ClaimResult =
  | {kind: "claimed"; attempt: number}
  | {kind: "already_processed"; outcome: string}
  | {kind: "in_progress"}
  | {kind: "fingerprint_conflict"};

/**
 * Atomically claims an event for processing, in one Firestore transaction.
 *
 * - No record yet: creates one (`status: "processing"`, with a lease) —
 *   this caller owns the work. Two concurrent first deliveries can't both
 *   create it: one transaction commits, the other retries, reads it, and
 *   falls into a branch below.
 * - Record is `processed`: a safe duplicate — nothing to do.
 * - Record is `processing` with an unexpired lease: another delivery is on
 *   it right now — NOT claimed, so only one performs the work.
 * - Record is `processing` with an EXPIRED lease: the earlier attempt died
 *   (crash/timeout) before completing — re-claimed, so the event is never
 *   lost. (Safe: the transition it re-runs is idempotent.)
 * - Same event ID but a different body fingerprint: `fingerprint_conflict`,
 *   never treated as a duplicate and never processed.
 *
 * The record is marked `processed` only by `completeWebhookEvent`, after the
 * payment transition has finished — never here.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {ClaimInput} input The authenticated event's identity and metadata.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<ClaimResult>} Whether this caller now owns the event.
 */
export async function claimWebhookEvent(
  db: Firestore,
  input: ClaimInput,
  now: Timestamp = Timestamp.now(),
): Promise<ClaimResult> {
  const ref = db.collection(WEBHOOK_EVENTS_COLLECTION).doc(input.identity.eventKey);
  const leaseExpiresAt = Timestamp.fromMillis(now.toMillis() + WEBHOOK_CLAIM_LEASE_MS);

  return db.runTransaction(async (tx): Promise<ClaimResult> => {
    const snapshot = await tx.get(ref);

    if (!snapshot.exists) {
      const record: Record<string, unknown> = {
        id: input.identity.eventKey,
        eventType: input.eventType.slice(0, MAX_EVENT_TYPE_LENGTH),
        keySource: input.identity.keySource,
        bodyFingerprint: input.identity.bodyFingerprint,
        status: "processing",
        attempts: 1,
        receivedAt: now,
        claimedAt: now,
        leaseExpiresAt,
      };
      if (input.providerOrderId) {
        record.providerOrderId = input.providerOrderId;
      }
      if (input.providerPaymentId) {
        record.providerPaymentId = input.providerPaymentId;
      }
      tx.create(ref, record);
      return {kind: "claimed", attempt: 1};
    }

    const data = snapshot.data() ?? {};
    if (data.bodyFingerprint !== input.identity.bodyFingerprint) {
      return {kind: "fingerprint_conflict"};
    }
    if (data.status === "processed") {
      return {kind: "already_processed", outcome: typeof data.outcome === "string" ? data.outcome : "unknown"};
    }

    const lease = data.leaseExpiresAt instanceof Timestamp ? data.leaseExpiresAt : null;
    if (lease && lease.toMillis() > now.toMillis()) {
      return {kind: "in_progress"};
    }

    const attempt = (typeof data.attempts === "number" ? data.attempts : 0) + 1;
    tx.update(ref, {attempts: attempt, claimedAt: now, leaseExpiresAt});
    return {kind: "claimed", attempt};
  });
}

/**
 * Marks a claimed event `processed` with its outcome. Called only after the
 * payment transition has completed. Idempotent: an already-processed record
 * keeps its original outcome.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} eventKey The event's document ID.
 * @param {string} outcome What reconciliation did with it.
 * @param {Timestamp} [now] Injected clock, for tests.
 */
export async function completeWebhookEvent(
  db: Firestore,
  eventKey: string,
  outcome: string,
  now: Timestamp = Timestamp.now(),
): Promise<void> {
  const ref = db.collection(WEBHOOK_EVENTS_COLLECTION).doc(eventKey);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      throw new Error(`Webhook event ${eventKey} vanished before completion.`);
    }
    if (snapshot.data()?.status === "processed") {
      return;
    }
    tx.update(ref, {status: "processed", outcome, processedAt: now});
  });
}

/**
 * Best-effort release of a claim whose processing failed, so a retried
 * delivery can re-claim immediately instead of waiting out the lease. A
 * failure to release is harmless (the lease simply expires on its own), so
 * this never throws.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} eventKey The event's document ID.
 * @param {Timestamp} [now] Injected clock, for tests.
 */
export async function releaseWebhookClaim(
  db: Firestore,
  eventKey: string,
  now: Timestamp = Timestamp.now(),
): Promise<void> {
  try {
    const ref = db.collection(WEBHOOK_EVENTS_COLLECTION).doc(eventKey);
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists && snapshot.data()?.status === "processing") {
        tx.update(ref, {leaseExpiresAt: now});
      }
    });
  } catch {
    // Intentionally ignored — see doc comment.
  }
}

// ---------------------------------------------------------------------------
// Resolving and validating the Zesto payment
// ---------------------------------------------------------------------------

/** What reconciliation did with an authenticated payment event. Every one of
 * these is acknowledged with a 2xx: retrying cannot change the answer. The
 * `rejected_*` ones indicate a Zesto/Razorpay inconsistency that needs a
 * human and are logged at error severity by the route. */
export type WebhookOutcome =
  | "payment_succeeded"
  | "success_noop_already_succeeded"
  | "success_conflicting_payment_id"
  | "payment_marked_failed"
  | "failure_noop_already_failed"
  | "failure_ignored_already_succeeded"
  | "ignored_unrecognized_payment"
  | "ignored_status_mismatch"
  | "rejected_ambiguous_payment"
  | "rejected_currency_mismatch"
  | "rejected_amount_mismatch"
  | "rejected_missing_order"
  | "rejected_order_not_payable";

/** The expected payment-entity status for each supported event type. */
const EXPECTED_PROVIDER_STATUS: Record<SupportedWebhookEventType, string> = {
  "payment.captured": "captured",
  "payment.failed": "failed",
};

/**
 * Checks a webhook event against Zesto's stored payment, BEFORE any
 * transition. Never trusts anything in the event beyond "Razorpay says X
 * happened to provider order Y": ownership and amounts always come from
 * Zesto's own record.
 *
 * @param {Payment} payment The Zesto payment found for the event's order.
 * @param {PaymentWebhookEvent} event The authenticated event.
 * @return {WebhookOutcome | null} A rejecting/ignoring outcome, or null if
 *   the event is consistent with the stored payment and may proceed.
 */
export function checkWebhookContext(
  payment: Payment,
  event: PaymentWebhookEvent,
): WebhookOutcome | null {
  if (payment.provider !== "razorpay" || payment.providerOrderId !== event.providerOrderId) {
    return "ignored_unrecognized_payment";
  }
  if (event.providerPaymentStatus !== EXPECTED_PROVIDER_STATUS[event.type]) {
    return "ignored_status_mismatch";
  }
  if (event.currency !== payment.currency) {
    return "rejected_currency_mismatch";
  }
  if (event.amountInPaise !== payment.amountInPaise) {
    return "rejected_amount_mismatch";
  }
  return null;
}

type LocatedPayment =
  | {kind: "none"}
  | {kind: "ambiguous"}
  | {kind: "found"; payment: Payment};

/**
 * Finds the Zesto payment for a Razorpay order ID with a collection-group
 * query over `payments.providerOrderId` (see firestore.indexes.json). The
 * ID is Razorpay's own, set by `ensureProviderOrder` before the customer
 * could ever pay; nothing customer-supplied takes part in the lookup.
 *
 * Exactly one match is required: none means the event isn't about Zesto (or
 * an order Zesto never persisted), more than one is a data anomaly that must
 * never be guessed at.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} providerOrderId Razorpay's order ID.
 * @return {Promise<LocatedPayment>} The lookup result.
 */
async function locatePaymentByProviderOrderId(
  db: Firestore,
  providerOrderId: string,
): Promise<LocatedPayment> {
  const snapshot = await db
    .collectionGroup("payments")
    .where("providerOrderId", "==", providerOrderId)
    .limit(2)
    .get();
  if (snapshot.empty) {
    return {kind: "none"};
  }
  if (snapshot.size > 1) {
    return {kind: "ambiguous"};
  }

  const doc = snapshot.docs[0];
  // organizations/{org}/outlets/{outlet}/menus/{menu}/orders/{order}/payments/{payment}
  const segments = doc.ref.path.split("/");
  const isOrderPayment =
    segments.length === 10 &&
    segments[0] === "organizations" &&
    segments[2] === "outlets" &&
    segments[4] === "menus" &&
    segments[6] === "orders" &&
    segments[8] === "payments";
  if (!isOrderPayment) {
    return {kind: "none"};
  }

  // Validates the stored document against the path it was found at; a
  // malformed stored record throws (-> generic 500), like every other read.
  const payment = parsePayment(
    doc.data(), segments[9], segments[7], segments[1], segments[3], segments[5],
  );
  return {kind: "found", payment};
}

/**
 * Reconciles one authenticated, claimed payment event against Zesto's
 * records, reusing the trusted state transitions.
 *
 * `payment.captured`:
 * - already `succeeded`: idempotent no-op (the browser's Checkout
 *   verification, or an earlier delivery, got there first). If the already
 *   recorded Razorpay payment differs from this event's, that is a second
 *   captured payment for one order — reported, never overwritten.
 * - otherwise `markPaymentSucceeded` (pending/failed → succeeded, order →
 *   confirmed/paid, atomically).
 *
 * `payment.failed`:
 * - already `succeeded`: ignored — a late failure never moves a successful
 *   payment backward.
 * - already `failed`: idempotent no-op.
 * - `pending`: `markPaymentFailed`. The ORDER is untouched and stays
 *   payable.
 *
 * The pre-read only chooses the outcome label; correctness never depends on
 * it — both transitions re-read inside their own transaction, so a race
 * between this read and the write resolves the same way.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {PaymentWebhookEvent} event The authenticated payment event.
 * @return {Promise<WebhookOutcome>} What was done.
 */
export async function applyPaymentWebhookEvent(
  db: Firestore,
  event: PaymentWebhookEvent,
): Promise<WebhookOutcome> {
  if (!event.providerOrderId) {
    return "ignored_unrecognized_payment";
  }

  const located = await locatePaymentByProviderOrderId(db, event.providerOrderId);
  if (located.kind === "none") {
    return "ignored_unrecognized_payment";
  }
  if (located.kind === "ambiguous") {
    return "rejected_ambiguous_payment";
  }

  const {payment} = located;
  const contextProblem = checkWebhookContext(payment, event);
  if (contextProblem) {
    return contextProblem;
  }

  if (event.type === "payment.captured") {
    if (payment.status === "succeeded") {
      const recorded = payment.providerPaymentId;
      return recorded && recorded !== event.providerPaymentId ?
        "success_conflicting_payment_id" :
        "success_noop_already_succeeded";
    }
    try {
      await markPaymentSucceeded(db, {
        orderId: payment.orderId,
        paymentId: payment.id,
        amountInPaise: event.amountInPaise,
        currency: event.currency,
        providerPaymentId: event.providerPaymentId,
      });
      return "payment_succeeded";
    } catch (error) {
      return outcomeForTransitionError(error);
    }
  }

  // payment.failed
  if (payment.status === "succeeded") {
    return "failure_ignored_already_succeeded";
  }
  if (payment.status === "failed") {
    return "failure_noop_already_failed";
  }
  try {
    const after = await markPaymentFailed(db, {
      orderId: payment.orderId,
      paymentId: payment.id,
      providerPaymentId: event.providerPaymentId,
    });
    return after.status === "succeeded" ? "failure_ignored_already_succeeded" : "payment_marked_failed";
  } catch (error) {
    return outcomeForTransitionError(error);
  }
}

/**
 * Maps a refusal from the trusted transitions to an outcome. Only the two
 * documented, non-retryable refusals are absorbed; anything else (e.g. a
 * transient Firestore failure) propagates so the delivery is retried.
 *
 * @param {unknown} error What the transition threw.
 * @return {WebhookOutcome} The outcome to record.
 * @throws {unknown} Anything that isn't a non-retryable refusal.
 */
function outcomeForTransitionError(error: unknown): WebhookOutcome {
  if (error instanceof HttpsError) {
    if (error.code === "not-found") {
      return "rejected_missing_order";
    }
    if (error.code === "failed-precondition") {
      return "rejected_order_not_payable";
    }
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ReceiveWebhookInput {
  /** The raw body — MUST already have passed `verifyWebhookSignature`. */
  rawBody: Buffer;
  /** The `x-razorpay-event-id` header, if present. */
  eventIdHeader: string | string[] | undefined;
}

export type ReceiveWebhookResult =
  | {kind: "malformed"}
  | {kind: "ignored"; eventType: string}
  | {kind: "duplicate"; eventKey: string; originalOutcome: string}
  | {kind: "in_progress"; eventKey: string}
  | {kind: "event_id_conflict"; eventKey: string}
  | {
    kind: "processed";
    eventKey: string;
    eventType: SupportedWebhookEventType;
    outcome: WebhookOutcome;
    providerOrderId: string | null;
    providerPaymentId: string;
  };

/**
 * Handles one AUTHENTICATED webhook delivery end to end (parse → dedupe →
 * reconcile → record). The caller must already have verified the signature
 * over `input.rawBody`; this function trusts that and does not re-check it.
 *
 * Nothing is recorded for a malformed body or an unsupported event type
 * (there is nothing to deduplicate, and no state to protect). If
 * reconciliation throws (e.g. a transient Firestore error) the claim is
 * released and the error propagates, so the route answers with a retryable
 * failure and the event is processed on redelivery.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {ReceiveWebhookInput} input The verified raw body and event-id header.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<ReceiveWebhookResult>} What happened to the delivery.
 */
export async function receiveRazorpayWebhook(
  db: Firestore,
  input: ReceiveWebhookInput,
  now: Timestamp = Timestamp.now(),
): Promise<ReceiveWebhookResult> {
  const parsed = parseWebhookBody(input.rawBody);
  if (parsed.kind === "malformed") {
    return {kind: "malformed"};
  }
  if (parsed.kind === "unsupported_event") {
    return {kind: "ignored", eventType: parsed.eventType};
  }

  const {event} = parsed;
  const identity = deriveWebhookEventIdentity({
    eventIdHeader: input.eventIdHeader,
    rawBody: input.rawBody,
  });

  const claim = await claimWebhookEvent(db, {
    identity,
    eventType: event.type,
    providerOrderId: event.providerOrderId,
    providerPaymentId: event.providerPaymentId,
  }, now);

  switch (claim.kind) {
  case "already_processed":
    return {kind: "duplicate", eventKey: identity.eventKey, originalOutcome: claim.outcome};
  case "in_progress":
    return {kind: "in_progress", eventKey: identity.eventKey};
  case "fingerprint_conflict":
    return {kind: "event_id_conflict", eventKey: identity.eventKey};
  case "claimed":
    break;
  }

  let outcome: WebhookOutcome;
  try {
    outcome = await applyPaymentWebhookEvent(db, event);
    await completeWebhookEvent(db, identity.eventKey, outcome);
  } catch (error) {
    await releaseWebhookClaim(db, identity.eventKey);
    throw error;
  }

  return {
    kind: "processed",
    eventKey: identity.eventKey,
    eventType: event.type,
    outcome,
    providerOrderId: event.providerOrderId,
    providerPaymentId: event.providerPaymentId,
  };
}

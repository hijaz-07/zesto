import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {
  PaymentProviderError,
  verifyCheckoutSignature,
  type PaymentProviderGateway,
} from "../providers/razorpay";
import {recordNotificationEvent, recordRefundNotificationEvent} from "./notificationEvents";
import {
  initialReconciliation,
  paymentReconciliationSchema,
  unscheduleReconciliationUpdate,
  type PaymentReconciliation,
} from "./paymentReconciliationState";
import {resolveOrderById, type Order} from "./orders";
import {
  PAYMENT_REFUND_STATE_VALUES,
  capturedAmountInPaise,
  refundAggregatesProblem,
  type PaymentRefundState,
} from "./refundAmounts";
import {planRefundCreation, readNextRefundSlot} from "./refundCreation";
import {REFUND_SYSTEM_INITIATOR} from "./refunds";

/**
 * `organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/orders/{orderId}/payments/{paymentId}`
 * — the v1 payment record for a single order (see root CLAUDE.md's "Never
 * trust the frontend for security" and this checkpoint's payment-foundation
 * notes). Nested one level under the order it belongs to, the same
 * relationship `items` has to its parent `Menu`.
 *
 * `preparePayment` itself stays provider-independent: it always writes
 * `provider: "none"` and never touches `providers/razorpay.ts` (see root
 * CLAUDE.md's "Keep Razorpay-specific behavior isolated from the core
 * payment domain as much as practical"). `ensureProviderOrder` is the one
 * function that talks to a provider (through the `PaymentProviderGateway`
 * abstraction, never the Razorpay SDK directly) and is what actually moves
 * `provider` to `"razorpay"` and sets `providerOrderId`. Creating a provider
 * order is NOT a payment: `payment.status` stays `pending` and
 * `order.status` stays `pending_payment` throughout — see that function's
 * doc comment.
 *
 * `providerPaymentId` is a DIFFERENT identifier from `providerOrderId`: the
 * former is the provider's reference for a completed PAYMENT (set only by
 * `markPaymentSucceeded`/`markPaymentFailed`, a later checkpoint's
 * concern), the latter is the provider's reference for the Razorpay ORDER
 * created to collect that payment (set by `ensureProviderOrder`). Never
 * confuse them, and never confuse either with this document's own `id`
 * (Zesto's internal payment ID) — three distinct identifiers on purpose.
 * Neither provider field is ever fabricated by this module.
 *
 * For v1, a payment's `id` always equals its parent order's `id` — there is
 * exactly one payment per order, ever (see `preparePayment`), so this
 * document is a deterministic, at-most-one-per-order singleton rather than
 * an auto-ID collection of attempts. This is what makes "prevent multiple
 * active payment records for the same logical payment attempt" (this
 * checkpoint's requirement) true by construction: a second `preparePayment`
 * call for the same order can only ever find-and-reuse the same document,
 * never create a second one. `orderId` is still validated independently
 * against the parent path on every read (see `parsePayment`), the same way
 * `Order` validates its own `organizationId`/`outletId`/`menuId` against its
 * path rather than trusting the nesting alone.
 */
export type PaymentStatus = "pending" | "succeeded" | "failed";
const PAYMENT_STATUS_VALUES = ["pending", "succeeded", "failed"] as const;

/** `"none"` until `ensureProviderOrder` connects a real provider order to
 * this payment; `"razorpay"` from then on. See the module doc comment for
 * why this is a separate concern from `PaymentProviderGateway` (the
 * provider abstraction itself, in `providers/razorpay.ts`) — this is just
 * the stored tag identifying WHICH provider, if any. */
export type PaymentProviderName = "none" | "razorpay";
const PAYMENT_PROVIDER_VALUES = ["none", "razorpay"] as const;

/** v1 supports exactly one currency, always inherited from the order. */
export type PaymentCurrency = "INR";

export interface Payment {
  id: string;
  orderId: string;
  userId: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  amountInPaise: number;
  currency: PaymentCurrency;
  status: PaymentStatus;
  provider: PaymentProviderName;
  /** The provider's ORDER reference (e.g. Razorpay's `order_...` ID), set
   * once `ensureProviderOrder` creates or reuses one. Distinct from
   * `providerPaymentId` — see the module doc comment. */
  providerOrderId?: string;
  /** The provider's own reference for a completed PAYMENT, once one
   * exists. Never fabricated — absent for every payment this checkpoint (or
   * the last) creates or transitions. */
  providerPaymentId?: string;
  /**
   * Refund accounting (see `domain/refundAmounts.ts`), all integer paise and all
   * optional: a payment written before refunds existed has none of them, and
   * is read as "`succeeded` with no `capturedAmountInPaise` -> captured is
   * `amountInPaise`; nothing refunded or pending" — no migration needed. They
   * are only ever non-absent on a `succeeded` payment, are written by a later
   * checkpoint's transactions together with every refund state change, and are
   * internal: never part of `PaymentResponse`.
   * - `capturedAmountInPaise`: what the provider captured (equals `amountInPaise`).
   * - `refundedAmountInPaise`: the sum of refunds that reached `processed`.
   * - `refundPendingInPaise`: the sum of refunds that are `requested` or `pending`.
   * - `refundSeq`: how many refunds have been created (the next refund's number is +1).
   * - `refundState`: the derived summary; see `deriveRefundState`.
   */
  capturedAmountInPaise?: number;
  refundedAmountInPaise?: number;
  refundPendingInPaise?: number;
  refundSeq?: number;
  refundState?: PaymentRefundState;
  /** Internal bookkeeping for `paymentReconciliation.ts`; absent on a payment written before it
   * existed (such a payment is simply never swept). Never part of `PaymentResponse`. */
  reconciliation?: PaymentReconciliation;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * The customer-safe API response shape for a `Payment` — never `userId`/
 * `organizationId`/`outletId`/`menuId` (internal Firestore path context) and
 * never a provider secret (this type has no field for one at all).
 * `providerPaymentId` is included once `verifyCheckoutPayment` has set it —
 * Razorpay's own reference for a completed payment, safe to hand back to the
 * frontend Checkout flow that just produced it. `providerKeyId` is
 * Razorpay's PUBLIC `key_id` — likewise safe to expose, unlike `key_secret`.
 */
export interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amountInPaise: number;
  currency: PaymentCurrency;
  status: PaymentStatus;
  provider: PaymentProviderName;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerKeyId?: string;
}

const paymentDocSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  outletId: z.string().min(1),
  menuId: z.string().min(1),
  amountInPaise: z.number().int().min(0),
  currency: z.literal("INR"),
  status: z.enum(PAYMENT_STATUS_VALUES),
  provider: z.enum(PAYMENT_PROVIDER_VALUES),
  providerOrderId: z.string().min(1).optional(),
  providerPaymentId: z.string().min(1).optional(),
  capturedAmountInPaise: z.number().int().min(0).optional(),
  refundedAmountInPaise: z.number().int().min(0).optional(),
  refundPendingInPaise: z.number().int().min(0).optional(),
  refundSeq: z.number().int().min(0).optional(),
  refundState: z.enum(PAYMENT_REFUND_STATE_VALUES).optional(),
  // Bookkeeping only: a damaged `reconciliation` map must never make the payment itself
  // unreadable (customers, webhooks and refunds all parse it), so it degrades to "none".
  reconciliation: paymentReconciliationSchema.optional().catch(undefined),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
  updatedAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "updatedAt must be a Firestore Timestamp",
  ),
}).superRefine((value, ctx) => {
  const hasRefundFields =
    value.capturedAmountInPaise !== undefined ||
    value.refundedAmountInPaise !== undefined ||
    value.refundPendingInPaise !== undefined ||
    (value.refundSeq ?? 0) > 0 ||
    (value.refundState !== undefined && value.refundState !== "none");
  if (hasRefundFields && value.status !== "succeeded") {
    ctx.addIssue({code: "custom", message: "Refund fields on a payment that did not succeed.", path: ["status"]});
    return;
  }
  if (value.capturedAmountInPaise !== undefined && value.capturedAmountInPaise !== value.amountInPaise) {
    ctx.addIssue({
      code: "custom",
      message: "The captured amount must equal the payment amount.",
      path: ["capturedAmountInPaise"],
    });
    return;
  }
  // Legacy-safe: a `succeeded` payment with no captured amount counts as
  // captured in full. Nothing to check on a payment that never succeeded.
  if (value.status === "succeeded") {
    const problem = refundAggregatesProblem({
      capturedInPaise: capturedAmountInPaise(value),
      refundedInPaise: value.refundedAmountInPaise ?? 0,
      refundPendingInPaise: value.refundPendingInPaise ?? 0,
    });
    if (problem !== null) {
      ctx.addIssue({code: "custom", message: "Inconsistent refund amounts.", path: ["refundedAmountInPaise"]});
    }
  }
});

/**
 * Parses a stored payment document, validating it was written in the
 * expected shape and that its `id`/`orderId`/`organizationId`/`outletId`/
 * `menuId` fields match the path (and parent order) it was read from.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The document ID it was read from.
 * @param {string} expectedOrderId The parent order's ID.
 * @param {string} expectedOrganizationId The parent order's organization ID.
 * @param {string} expectedOutletId The parent order's outlet ID.
 * @param {string} expectedMenuId The parent order's menu ID.
 * @return {Payment} The parsed payment.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parsePayment(
  data: unknown,
  expectedId: string,
  expectedOrderId: string,
  expectedOrganizationId: string,
  expectedOutletId: string,
  expectedMenuId: string,
): Payment {
  const parsed = paymentDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== expectedId ||
    parsed.data.orderId !== expectedOrderId ||
    parsed.data.organizationId !== expectedOrganizationId ||
    parsed.data.outletId !== expectedOutletId ||
    parsed.data.menuId !== expectedMenuId
  ) {
    throw new Error(
      "Malformed payment document at .../orders/" +
      `${expectedOrderId}/payments/${expectedId}.`,
    );
  }
  return parsed.data;
}

/**
 * @param {Payment} payment A stored payment.
 * @param {string} [providerKeyId] The provider's current PUBLIC key_id
 *   (e.g. `getRazorpayKeyId()`), to include in the response. Omitted when
 *   the caller has no provider context to give (e.g. a future endpoint that
 *   reads a payment without preparing a provider order).
 * @return {PaymentResponse} The customer-safe API response shape for it.
 */
export function toPaymentResponse(payment: Payment, providerKeyId?: string): PaymentResponse {
  const response: PaymentResponse = {
    paymentId: payment.id,
    orderId: payment.orderId,
    amountInPaise: payment.amountInPaise,
    currency: payment.currency,
    status: payment.status,
    provider: payment.provider,
  };
  if (payment.providerOrderId !== undefined) {
    response.providerOrderId = payment.providerOrderId;
  }
  if (payment.providerPaymentId !== undefined) {
    response.providerPaymentId = payment.providerPaymentId;
  }
  if (providerKeyId !== undefined) {
    response.providerKeyId = providerKeyId;
  }
  return response;
}

/**
 * @param {DocumentReference} orderRef The order's document reference.
 * @param {string} paymentId The payment document's ID.
 * @return {DocumentReference} The payment's document reference, nested under
 *   the order.
 */
function paymentRefFor(orderRef: DocumentReference, paymentId: string): DocumentReference {
  return orderRef.collection("payments").doc(paymentId);
}

/** The result of `preparePayment`: the payment (either newly created or the
 * reused existing record for this order), and whether it was actually
 * created by this call. */
export interface PreparePaymentResult {
  payment: Payment;
  /** `true` if this call created a new payment; `false` if it returned the
   * order's already-existing payment record (see the module doc comment's
   * "at most one payment per order" invariant). */
  created: boolean;
}

/**
 * Prepares a payment for an existing `pending_payment` order — the
 * server-authoritative boundary a future provider integration will sit
 * behind (see this checkpoint's "Payment creation" notes). No external
 * provider is called here; this only establishes the internal payment
 * record a future provider adapter needs (`paymentId`/`orderId`/
 * `amountInPaise`/`currency`).
 *
 * `userId` MUST already be the verified Descope session's own user id (see
 * `routes/orders.ts`) — never a client-supplied value. `amountInPaise` and
 * `currency` are always read from the order (`order.totalInPaise`/
 * `order.currency`), never accepted from a caller — there is no request body
 * for this operation to trust in the first place.
 *
 * Retry-safe: since a payment's document ID always equals its order's ID
 * (see the module doc comment), a repeated call for the same order simply
 * finds and returns the same document rather than creating another —
 * whatever its current status, this never resets or otherwise mutates an
 * existing payment.
 *
 * Runs entirely inside one Firestore transaction, so the order read, the
 * payment existence check, and the payment write are atomic — a concurrent
 * call can never create two payments for the same order.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @param {unknown} orderId The order's document ID, from the request path.
 * @return {Promise<PreparePaymentResult>} The payment and whether it was
 *   newly created.
 * @throws {HttpsError} `invalid-argument` (400) if `orderId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such order exists, or it
 *   exists but belongs to a different user (indistinguishable, the same
 *   reasoning `getOwnedOrder` uses).
 * @throws {HttpsError} `failed-precondition` (400) if the order is not
 *   currently `pending_payment` (already confirmed, cancelled, or otherwise
 *   not awaiting payment).
 */
export async function preparePayment(
  db: Firestore,
  userId: string,
  orderId: unknown,
): Promise<PreparePaymentResult> {
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }

  return db.runTransaction(async (tx): Promise<PreparePaymentResult> => {
    const {order, orderRef} = await resolveOrderById(db, tx, orderId);

    if (order.userId !== userId) {
      throw new HttpsError("not-found", "Order not found.");
    }
    if (order.status !== "pending_payment") {
      throw new HttpsError("failed-precondition", "This order is not awaiting payment.");
    }

    const paymentRef = paymentRefFor(orderRef, order.id);
    const paymentSnapshot = await tx.get(paymentRef);
    if (paymentSnapshot.exists) {
      const existing = parsePayment(
        paymentSnapshot.data(), order.id, order.id, order.organizationId, order.outletId, order.menuId,
      );
      return {payment: existing, created: false};
    }

    const now = Timestamp.now();
    const payment: Payment = {
      id: order.id,
      orderId: order.id,
      userId: order.userId,
      organizationId: order.organizationId,
      outletId: order.outletId,
      menuId: order.menuId,
      amountInPaise: order.totalInPaise,
      currency: order.currency,
      status: "pending",
      provider: "none",
      createdAt: now,
      updatedAt: now,
    };
    tx.create(paymentRef, payment);

    return {payment, created: true};
  });
}

/**
 * Resolves an order and its (already-existing) payment together, reading
 * both within an in-progress transaction — the shared lookup
 * `markPaymentSucceeded`/`markPaymentFailed` both start from.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The in-progress transaction to read within.
 * @param {unknown} orderId The order's document ID.
 * @param {unknown} paymentId The payment's document ID.
 * @return {Promise<{order: Order; orderRef: DocumentReference; payment: Payment; paymentRef: DocumentReference}>}
 *   The resolved order/payment and their document references.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed `orderId` or
 *   `paymentId`.
 * @throws {HttpsError} `not-found` (404) if no such order exists, or it has
 *   no payment with that ID.
 */
async function resolveOrderAndPayment(
  db: Firestore,
  tx: Transaction,
  orderId: unknown,
  paymentId: unknown,
): Promise<{
  order: Order;
  orderRef: DocumentReference;
  payment: Payment;
  paymentRef: DocumentReference;
}> {
  if (!isValidDocumentId(paymentId)) {
    throw new HttpsError("invalid-argument", "Invalid payment ID.");
  }

  const {order, orderRef} = await resolveOrderById(db, tx, orderId);

  const paymentRef = paymentRefFor(orderRef, paymentId);
  const paymentSnapshot = await tx.get(paymentRef);
  if (!paymentSnapshot.exists) {
    throw new HttpsError("not-found", "Payment not found.");
  }
  const payment = parsePayment(
    paymentSnapshot.data(), paymentId, order.id, order.organizationId, order.outletId, order.menuId,
  );

  return {order, orderRef, payment, paymentRef};
}

/** Input to `markPaymentSucceeded`: what a (future) verified provider result
 * asserts about a payment. `amountInPaise`/`currency` are checked against the
 * stored payment before anything is trusted — see that function's doc
 * comment. */
export interface MarkPaymentSucceededInput {
  orderId: unknown;
  paymentId: unknown;
  amountInPaise: number;
  currency: string;
  /** The provider's own reference for this successful payment, if any.
   * Never fabricated by this module's own callers in v1. */
  providerPaymentId?: string;
}

/** The result of a payment transition: the payment and order as they stand
 * after the call (whether this call changed them, or they already reflected
 * the requested outcome). */
export interface PaymentTransitionResult {
  payment: Payment;
  order: Order;
  /** Set only when THIS call captured a payment for an already-cancelled order
   * and reserved its refund (see `captureAfterCancellation`). */
  refundId?: string;
}

/**
 * The ONLY trusted way an order may move from `pending_payment` to
 * `confirmed` (see root CLAUDE.md's core payment rule: "The browser must
 * NEVER be able to mark an order as paid"). No route calls this in this
 * checkpoint — it exists so a future provider webhook adapter has a single,
 * safe operation to call once it has independently verified a payment
 * succeeded. Never call this from anything driven directly by client input.
 *
 * Verifies `input.amountInPaise`/`input.currency` against the STORED
 * payment's own `amountInPaise`/`currency` (which itself was set from
 * `order.totalInPaise`/`order.currency` at `preparePayment` time, never from
 * a client) before trusting the transition — this is what stops a
 * corrupted or malicious provider payload from confirming an order for the
 * wrong amount.
 *
 * State-machine rules (see the module doc comment):
 * - `succeeded` -> `succeeded`: idempotent no-op, returns the current
 *   payment/order unchanged. Repeated success notifications (e.g. a
 *   retried webhook delivery) never double-apply.
 * - `failed` -> `succeeded`: allowed — a payment that failed once may still
 *   succeed on a later attempt against the SAME order/payment (v1 has no
 *   separate "attempt" concept; see the module doc comment).
 * - `pending` -> `succeeded`: the normal path.
 * - A non-succeeded payment whose order is `cancelled`: a LATE CAPTURE. The
 *   success and the captured amount are recorded, the order is NOT reopened or
 *   confirmed (a cancelled order is never newly confirmed by a payment), and the
 *   captured money is reserved for a refund — see `captureAfterCancellation`.
 * - Any other status when `order.status` is not `pending_payment` (already
 *   `confirmed`, `preparing`, ...): rejected. It's checked only after the
 *   `succeeded` -> `succeeded` idempotent short-circuit above, since an
 *   already-succeeded payment's order is, by construction, already past
 *   `pending_payment` — that combination must return successfully, not fall
 *   into this rejection.
 *
 * Runs entirely inside one Firestore transaction: the payment's `status` and
 * the order's `status`/`paymentStatus` are set together, atomically — two
 * concurrent success notifications for the same order can only ever produce
 * one confirmed order, never a payment marked `succeeded` with the order
 * left `pending_payment`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {MarkPaymentSucceededInput} input The (future) verified provider
 *   result to apply.
 * @return {Promise<PaymentTransitionResult>} The payment and order as they
 *   stand after the call.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed `orderId` or
 *   `paymentId`.
 * @throws {HttpsError} `not-found` (404) if no such order or payment exists.
 * @throws {HttpsError} `failed-precondition` (400) if the order cannot be
 *   confirmed (not currently `pending_payment`), or if `input.amountInPaise`/
 *   `input.currency` don't match the stored payment.
 */
export async function markPaymentSucceeded(
  db: Firestore,
  input: MarkPaymentSucceededInput,
): Promise<PaymentTransitionResult> {
  if (!isValidDocumentId(input.orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }
  if (!isValidDocumentId(input.paymentId)) {
    throw new HttpsError("invalid-argument", "Invalid payment ID.");
  }

  const result = await db.runTransaction(async (tx): Promise<PaymentTransitionResult> => {
    const {order, orderRef, payment, paymentRef} =
      await resolveOrderAndPayment(db, tx, input.orderId, input.paymentId);

    if (payment.status === "succeeded") {
      return {payment, order};
    }

    const lateCapture = order.status === "cancelled";
    if (order.status !== "pending_payment" && !lateCapture) {
      throw new HttpsError(
        "failed-precondition",
        "This order cannot be confirmed by payment.",
      );
    }

    if (payment.amountInPaise !== input.amountInPaise || payment.currency !== input.currency) {
      throw new HttpsError(
        "failed-precondition",
        "Payment amount or currency does not match the order.",
      );
    }

    const now = Timestamp.now();
    // `capturedAmountInPaise` is written with EVERY new success, atomically with
    // the status: what the provider captured, which the check above just proved
    // equals the stored amount. (A payment that succeeded before this field
    // existed has none and is read as captured in full — see `refundAmounts.ts`.)
    const paymentUpdate: Partial<Payment> = {
      status: "succeeded",
      capturedAmountInPaise: payment.amountInPaise,
      updatedAt: now,
    };
    if (input.providerPaymentId !== undefined) {
      paymentUpdate.providerPaymentId = input.providerPaymentId;
    }
    if (lateCapture) {
      return captureAfterCancellation(tx, {order, orderRef, payment, paymentRef, paymentUpdate, now});
    }
    // A captured payment leaves the reconciliation sweep in the same transaction.
    tx.update(paymentRef, {...paymentUpdate, ...unscheduleReconciliationUpdate()});
    tx.update(orderRef, {status: "confirmed", paymentStatus: "paid", updatedAt: now});

    const confirmedOrder: Order = {...order, status: "confirmed", paymentStatus: "paid", updatedAt: now};
    // The notification outbox event, committed or rolled back together with the
    // confirmation itself. Only this branch writes it: the `succeeded` replay
    // above returned before reaching here, so a retried webhook or a repeated
    // Checkout verification never records a second one. Delivering it is a
    // separate, later step that can never fail this transition.
    recordNotificationEvent(db, tx, confirmedOrder, "order_confirmed", now);

    return {
      payment: {...payment, ...paymentUpdate},
      order: confirmedOrder,
    };
  });
  if (result.refundId !== undefined) {
    // After the commit, so a retried transaction never logs a refund that was not kept.
    logger.warn("Payment captured after the order was cancelled; a refund of the full amount is reserved.", {
      orderId: result.order.id,
      refundId: result.refundId,
    });
  }
  return result;
}

/**
 * LATE CAPTURE: the provider captured a payment for an order that was already
 * cancelled (the customer paid in one tab while cancelling in another, or a
 * webhook arrived after the cancellation). The money is real and must go back.
 *
 * Inside the caller's `markPaymentSucceeded` transaction, atomically:
 * - the payment becomes `succeeded` with its captured amount (and provider
 *   payment ID), exactly as for any capture;
 * - the order is NOT reopened — it stays `cancelled`, keeps its audit fields and
 *   gets no `order_confirmed` notification. It records the payment as it now is:
 *   `paymentStatus` becomes `paid` (the money was captured), together with the
 *   refund mirror and `updatedAt`, so it reads as cancelled, paid, refund in
 *   progress. `paymentStatus` only ever moves `pending` -> `paid` here, never back;
 * - the whole captured amount is reserved for one refund (reason
 *   `late_capture_after_cancel`, initiated by the system), created `requested`
 *   — the state a later dispatcher submits to the provider from. Nothing here
 *   calls the provider.
 *
 * Idempotent and race-safe by the same transaction: a repeated capture finds the
 * payment `succeeded` and returns before reaching here, so a second refund can
 * never be created; and a cancellation racing the capture serializes on the same
 * order and payment documents (whichever commits first, the other sees it).
 *
 * If the capture cannot be refunded safely (no provider payment ID, ...) the
 * whole call is refused and nothing is written, as before.
 *
 * @param {Transaction} tx The in-progress `markPaymentSucceeded` transaction;
 *   nothing has been written to it yet.
 * @param {object} facts What `markPaymentSucceeded` already read and decided.
 * @return {Promise<PaymentTransitionResult>} The payment and (still cancelled)
 *   order as they stand after the call, with the reserved refund's ID.
 * @throws {HttpsError} `failed-precondition` (400) if the capture cannot be refunded.
 */
async function captureAfterCancellation(
  tx: Transaction,
  facts: {
    order: Order;
    orderRef: DocumentReference;
    payment: Payment;
    paymentRef: DocumentReference;
    paymentUpdate: Partial<Payment>;
    now: Timestamp;
  },
): Promise<PaymentTransitionResult> {
  const {order, orderRef, payment, paymentRef, paymentUpdate, now} = facts;
  const captured: Payment = {...payment, ...paymentUpdate};

  const slot = await readNextRefundSlot(tx, paymentRef, captured);
  const plan = planRefundCreation({
    order,
    payment: captured,
    slot,
    reason: "late_capture_after_cancel",
    source: "cancellation",
    initiatedBy: REFUND_SYSTEM_INITIATOR,
    initiatedByRole: "system",
    now,
  });
  if (plan.kind === "not_refundable") {
    logger.warn("A payment was captured for a cancelled order and cannot be refunded; refusing it.", {
      orderId: order.id, reason: plan.reason,
    });
    throw new HttpsError("failed-precondition", "This order cannot be confirmed by payment.");
  }

  const stored: Payment = plan.kind === "create" ? {...captured, ...plan.paymentUpdate} : captured;
  const orderUpdate: Partial<Order> = {paymentStatus: "paid", ...(plan.mirror ?? {}), updatedAt: now};
  if (plan.kind === "create") {
    tx.create(plan.refundRef, plan.refund);
    recordRefundNotificationEvent(plan.refundRef.firestore, tx, plan.refund, "refund_requested", now);
    tx.update(paymentRef, {...paymentUpdate, ...plan.paymentUpdate, ...unscheduleReconciliationUpdate()});
  } else {
    tx.update(paymentRef, {...paymentUpdate, ...unscheduleReconciliationUpdate()});
  }
  tx.update(orderRef, orderUpdate);

  return {
    payment: stored,
    order: {...order, ...orderUpdate},
    ...(plan.kind === "create" ? {refundId: plan.refund.id} : {}),
  };
}

/** Input to `markPaymentFailed`. */
export interface MarkPaymentFailedInput {
  orderId: unknown;
  paymentId: unknown;
  /** The provider's own reference for this failed payment, if any. Never
   * fabricated by this module's own callers in v1. */
  providerPaymentId?: string;
}

/**
 * The trusted way a payment attempt is recorded as failed. No route calls
 * this in this checkpoint — like `markPaymentSucceeded`, it exists for a
 * future provider webhook adapter.
 *
 * Deliberately never touches the order: the order's `status` stays
 * `pending_payment` and its `paymentStatus` stays `pending` either way (see
 * root CLAUDE.md's "Demand-driven ordering" — a failed payment does not
 * cancel the order or clear the customer's cart; the customer may simply
 * retry).
 *
 * State-machine rules (see the module doc comment):
 * - `succeeded` -> (failure notification): ignored — returns the current
 *   payment unchanged. A later failure event must never move an
 *   already-successful payment backward.
 * - `failed` -> (failure notification): idempotent no-op, returns the
 *   current payment unchanged. Repeated failure notifications never
 *   double-apply.
 * - `pending` -> `failed`: the normal path.
 *
 * Runs inside one Firestore transaction (a single document write, but kept
 * consistent with `markPaymentSucceeded`'s shape).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {MarkPaymentFailedInput} input Identifies the payment to fail.
 * @return {Promise<Payment>} The payment as it stands after the call.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed `orderId` or
 *   `paymentId`.
 * @throws {HttpsError} `not-found` (404) if no such order or payment exists.
 */
export async function markPaymentFailed(
  db: Firestore,
  input: MarkPaymentFailedInput,
): Promise<Payment> {
  if (!isValidDocumentId(input.orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }
  if (!isValidDocumentId(input.paymentId)) {
    throw new HttpsError("invalid-argument", "Invalid payment ID.");
  }

  return db.runTransaction(async (tx): Promise<Payment> => {
    const {payment, paymentRef} =
      await resolveOrderAndPayment(db, tx, input.orderId, input.paymentId);

    if (payment.status === "succeeded" || payment.status === "failed") {
      return payment;
    }

    const now = Timestamp.now();
    const paymentUpdate: Partial<Payment> = {status: "failed", updatedAt: now};
    if (input.providerPaymentId !== undefined) {
      paymentUpdate.providerPaymentId = input.providerPaymentId;
    }
    tx.update(paymentRef, paymentUpdate);

    return {...payment, ...paymentUpdate};
  });
}

/** The result of `ensureProviderOrder`: the payment as it stands after the
 * call, its authoritative `providerOrderId`, and whether THIS call is the
 * one that created the provider order (as opposed to reusing one that
 * already existed, or losing a race to a concurrent call — see the
 * function's doc comment). */
export interface EnsureProviderOrderResult {
  payment: Payment;
  providerOrderId: string;
  created: boolean;
}

/**
 * Ensures the given payment has a Razorpay order to collect payment
 * against, creating one through `gateway` if it doesn't already — the
 * provider-order half of this checkpoint's extended `POST
 * /orders/{orderId}/payment` flow (`preparePayment` establishes the
 * internal payment; this connects it to a provider order). Creating a
 * provider order is NOT a payment: it never changes `payment.status` (stays
 * `pending`) or the order's `status`/`paymentStatus` (stay `pending_payment`/
 * `pending`) — see root CLAUDE.md's core payment rule.
 *
 * `amountInPaise`/`currency` sent to the provider always come from the
 * ALREADY-authoritative stored payment (itself set from the order's own
 * total at `preparePayment` time) — never recomputed from the order or
 * accepted from a caller. `receipt` is the payment's own `id` — deterministic
 * and bounded (a Firestore auto-ID, well under Razorpay's 40-character
 * receipt limit), so the created provider order is always traceable back to
 * this exact Zesto payment.
 *
 * Concurrency and the Firestore/HTTP atomicity gap (see this checkpoint's
 * "Idempotency"/"Concurrency" notes) — deliberately NOT pretending a
 * Firestore transaction and a remote Razorpay HTTP call are one atomic
 * operation:
 * 1. Read the payment (its own small transaction, no provider call inside
 *    it). If `providerOrderId` is already set, return it immediately — no
 *    provider call at all. This is the common case for every call after the
 *    first.
 * 2. Otherwise, call `gateway.createOrder` OUTSIDE any transaction — a
 *    provider order is created (or the call fails, in which case nothing
 *    else happens; see below).
 * 3. Persist the result with a GUARDED update (`claimProviderOrder`, its own
 *    fresh transaction): re-read the payment, and only write
 *    `providerOrderId` if it is STILL absent. If a concurrent call already
 *    won (see below), this call's own freshly-created provider order is
 *    simply discarded — an unpaid Razorpay order has no side effects and is
 *    never referenced again, so this is safe, not just convenient.
 *
 * This makes two simultaneous calls for the same payment (the "request A
 * sees no providerOrderId, request B sees no providerOrderId, both call
 * Razorpay" race this checkpoint calls out) resolve to exactly one
 * authoritative `providerOrderId` — both calls return the SAME id, whichever
 * one's guarded update actually won.
 *
 * Accepted, documented limitation: if step 2 succeeds but this process
 * crashes or loses network before step 3 runs, that created order is
 * orphaned (never persisted, never retried-into) and a later retry creates
 * a NEW one instead of finding it. This is deliberate, not an oversight —
 * reconciling it would mean querying Razorpay for a matching receipt before
 * every single call (including the overwhelmingly common case where no
 * such orphan exists), which this checkpoint's own "do not introduce
 * unnecessary complexity" guidance weighs against. The orphaned order is
 * inert (nothing is ever charged against it) and its deterministic
 * `receipt` (the payment's own `id`) leaves it identifiable by hand if it
 * ever needs cleaning up.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {unknown} orderId The order's document ID.
 * @param {unknown} paymentId The payment's document ID.
 * @param {PaymentProviderGateway} gateway The provider abstraction
 *   (defaults to the real Razorpay gateway; tests inject a fake).
 * @return {Promise<EnsureProviderOrderResult>} The payment, its
 *   authoritative `providerOrderId`, and whether this call created it.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed `orderId` or
 *   `paymentId`.
 * @throws {HttpsError} `not-found` (404) if no such order or payment exists.
 * @throws {HttpsError} `unavailable` (503) if the provider call fails — the
 *   payment is left exactly as it was (still `pending`, no `providerOrderId`),
 *   so a retry remains possible.
 */
export async function ensureProviderOrder(
  db: Firestore,
  orderId: unknown,
  paymentId: unknown,
  gateway: PaymentProviderGateway,
): Promise<EnsureProviderOrderResult> {
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }
  if (!isValidDocumentId(paymentId)) {
    throw new HttpsError("invalid-argument", "Invalid payment ID.");
  }

  const {payment: initialPayment} = await db.runTransaction((tx) =>
    resolveOrderAndPayment(db, tx, orderId, paymentId));

  if (initialPayment.providerOrderId !== undefined) {
    return {payment: initialPayment, providerOrderId: initialPayment.providerOrderId, created: false};
  }

  let providerOrderId: string;
  try {
    const providerOrder = await gateway.createOrder({
      amountInPaise: initialPayment.amountInPaise,
      currency: initialPayment.currency,
      receipt: initialPayment.id,
    });
    providerOrderId = providerOrder.id;
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new HttpsError(
        "unavailable",
        "The payment provider is temporarily unavailable. Please try again.",
      );
    }
    throw error;
  }

  return claimProviderOrder(db, orderId, paymentId, providerOrderId);
}

/**
 * The guarded-update half of `ensureProviderOrder`: persists
 * `candidateProviderOrderId` onto the payment ONLY if it still has none,
 * inside a fresh transaction that never touches the provider. If a
 * concurrent call already won, this returns THAT authoritative id instead
 * of the candidate — the candidate's own (now-orphaned) provider order is
 * simply never referenced again.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {unknown} orderId The order's document ID.
 * @param {unknown} paymentId The payment's document ID.
 * @param {string} candidateProviderOrderId The provider order ID this call
 *   just created, to persist if no one beat it to it.
 * @return {Promise<EnsureProviderOrderResult>} The authoritative result.
 */
async function claimProviderOrder(
  db: Firestore,
  orderId: unknown,
  paymentId: unknown,
  candidateProviderOrderId: string,
): Promise<EnsureProviderOrderResult> {
  return db.runTransaction(async (tx): Promise<EnsureProviderOrderResult> => {
    const {payment, paymentRef} = await resolveOrderAndPayment(db, tx, orderId, paymentId);

    if (payment.providerOrderId !== undefined) {
      return {payment, providerOrderId: payment.providerOrderId, created: false};
    }

    const now = Timestamp.now();
    // From here a customer can pay, so from here Zesto must be able to notice a payment it
    // never hears about: schedule the first reconciliation check (see `paymentReconciliation.ts`).
    const update: Partial<Payment> = {
      provider: "razorpay",
      providerOrderId: candidateProviderOrderId,
      reconciliation: initialReconciliation(now),
      updatedAt: now,
    };
    tx.update(paymentRef, update);

    return {payment: {...payment, ...update}, providerOrderId: candidateProviderOrderId, created: true};
  });
}

/**
 * Validates the `POST /orders/{orderId}/payment/verify` request body — the
 * three identifiers Razorpay Checkout hands the browser once a payment
 * attempt completes. Deliberately just these three: `amount`/`currency`/
 * `userId`/`organizationId`/payment or order status/`providerOrderId` are
 * never accepted from the client (see `verifyCheckoutPayment`'s doc
 * comment) — there is nothing else in the body for a client to override,
 * and any other field a client sends is silently stripped by `safeParse`,
 * never trusted.
 */
export const verifyCheckoutPaymentBodySchema = z.object({
  razorpayPaymentId: z.string().trim().min(1),
  razorpayOrderId: z.string().trim().min(1),
  razorpaySignature: z.string().trim().min(1),
});

export type VerifyCheckoutPaymentInput = z.infer<typeof verifyCheckoutPaymentBodySchema>;

/**
 * The trusted server-side verification path for a completed Razorpay
 * Checkout payment (see root CLAUDE.md's "Never trust the frontend for
 * security" and this checkpoint's security model). Called by `POST
 * /orders/{orderId}/payment/verify` after Razorpay Checkout succeeds in the
 * browser and hands it `razorpay_payment_id`/`razorpay_order_id`/
 * `razorpay_signature` — this is the ONLY way (besides a future trusted
 * webhook) those values can ever lead to `markPaymentSucceeded` being
 * called. Nothing in `input` is trusted at face value:
 *
 * 1. `orderId`/`userId` resolve the CALLER'S OWN order and its payment,
 *    exactly like `preparePayment` — an order that doesn't exist, or exists
 *    but belongs to a different user, is indistinguishable (`not-found`),
 *    never leaking another customer's payment.
 * 2. The payment must already have `provider: "razorpay"` and a
 *    `providerOrderId` (i.e. `ensureProviderOrder` already ran for it) —
 *    otherwise there is nothing to verify against.
 * 3. `input.razorpayOrderId` must equal the STORED `payment.providerOrderId`
 *    — never the other way around. A client cannot substitute a different
 *    provider order by sending a different value here; a mismatch is
 *    rejected outright, before any signature work.
 * 4. If the payment is already `succeeded`: a replay carrying the SAME
 *    `providerPaymentId` returns the current state safely, with no further
 *    writes (idempotent retry); a DIFFERENT `providerPaymentId` is a
 *    conflict (`already-exists`) — an already-successful payment is never
 *    silently overwritten by a second, different provider payment
 *    reference.
 * 5. Otherwise (payment is `pending` or `failed`), the Checkout signature is
 *    verified (`providers/razorpay.ts`'s `verifyCheckoutSignature`) using
 *    the SAME trusted `payment.providerOrderId` from step 3 — never a
 *    client-supplied order ID — plus the submitted `razorpayPaymentId`/
 *    `razorpaySignature`. An invalid signature is rejected outright; the
 *    payment is left exactly as it was.
 * 6. Only once the signature verifies does this call the existing trusted
 *    `markPaymentSucceeded` transition — never a second, duplicate success
 *    implementation. That function itself re-validates `amountInPaise`/
 *    `currency` against the STORED payment (never from this request, which
 *    carries no such fields at all) before atomically moving
 *    `payment.status` to `succeeded` and `order.status`/`paymentStatus` to
 *    `confirmed`/`paid`. `providerPaymentId` is persisted as
 *    `input.razorpayPaymentId` — Razorpay's own reference for this
 *    completed payment. A payment that previously `failed` is allowed to
 *    succeed here (see `markPaymentSucceeded`'s own state-machine rules). A
 *    payment for an already-cancelled order is recorded as a late capture and
 *    its refund reserved there; the order is never reopened.
 *
 * Deliberately does NOT call the Razorpay API to re-fetch the order/payment
 * (`PaymentProviderGateway.fetchOrder`) as an extra check: the signature
 * verified in step 5, computed over the TRUSTED `providerOrderId`
 * established in step 3, is exactly Razorpay's own documented Checkout
 * verification algorithm and is already sufficient proof that Razorpay
 * itself produced this `razorpay_payment_id` for THIS provider order — an
 * extra network round-trip would add latency and a new failure mode without
 * closing any gap steps 3-5 leave open.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @param {unknown} orderId The order's document ID, from the request path.
 * @param {VerifyCheckoutPaymentInput} input The validated request body.
 * @return {Promise<PaymentTransitionResult>} The payment and order as they
 *   stand after verification.
 * @throws {HttpsError} `invalid-argument` (400) if `orderId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such order exists, or it
 *   exists but has no payment yet, or belongs to a different user.
 * @throws {HttpsError} `failed-precondition` (400) if the payment has no
 *   provider order to verify against, the submitted `razorpayOrderId` does
 *   not match the stored `providerOrderId`, or the signature is invalid.
 * @throws {HttpsError} `already-exists` (409) if the payment already
 *   succeeded with a DIFFERENT `providerPaymentId` than the one submitted.
 */
export async function verifyCheckoutPayment(
  db: Firestore,
  userId: string,
  orderId: unknown,
  input: VerifyCheckoutPaymentInput,
): Promise<PaymentTransitionResult> {
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }

  const {order, payment} = await db.runTransaction(async (tx) => {
    const resolved = await resolveOrderAndPayment(db, tx, orderId, orderId);
    if (resolved.order.userId !== userId) {
      throw new HttpsError("not-found", "Order not found.");
    }
    return resolved;
  });

  if (payment.provider !== "razorpay" || payment.providerOrderId === undefined) {
    throw new HttpsError(
      "failed-precondition",
      "This payment has no provider order to verify against.",
    );
  }

  if (payment.providerOrderId !== input.razorpayOrderId) {
    throw new HttpsError(
      "failed-precondition",
      "The submitted payment does not match this order's payment.",
    );
  }

  if (payment.status === "succeeded") {
    if (payment.providerPaymentId === input.razorpayPaymentId) {
      return {payment, order};
    }
    throw new HttpsError(
      "already-exists",
      "This payment has already succeeded with a different payment reference.",
    );
  }

  const signatureValid = verifyCheckoutSignature({
    providerOrderId: payment.providerOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });
  if (!signatureValid) {
    throw new HttpsError(
      "failed-precondition",
      "The payment signature could not be verified.",
    );
  }

  return markPaymentSucceeded(db, {
    orderId: order.id,
    paymentId: payment.id,
    amountInPaise: payment.amountInPaise,
    currency: payment.currency,
    providerPaymentId: input.razorpayPaymentId,
  });
}

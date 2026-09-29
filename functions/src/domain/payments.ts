import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {
  PaymentProviderError,
  type PaymentProviderGateway,
} from "../providers/razorpay";
import {resolveOrderById, type Order} from "./orders";

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
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * The customer-safe API response shape for a `Payment` — deliberately just
 * enough for the NEXT checkpoint's frontend Checkout integration to act on
 * (see this checkpoint's "API response security" notes): never `userId`/
 * `organizationId`/`outletId`/`menuId` (internal Firestore path context),
 * and never `providerPaymentId` (not set by anything in this checkpoint,
 * and not needed by the client even once it is). `providerKeyId` is
 * Razorpay's PUBLIC `key_id` — safe to expose, unlike `key_secret`, which
 * this type has no field for at all.
 */
export interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amountInPaise: number;
  currency: PaymentCurrency;
  status: PaymentStatus;
  provider: PaymentProviderName;
  providerOrderId?: string;
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
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
  updatedAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "updatedAt must be a Firestore Timestamp",
  ),
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
 * - Any other status when `order.status` is not `pending_payment` (already
 *   `confirmed`, or `cancelled`): rejected. This is what makes "a cancelled
 *   order cannot later be newly confirmed by a payment-success operation"
 *   true. It's checked only after the `succeeded` -> `succeeded` idempotent
 *   short-circuit above, since an already-succeeded payment's order is, by
 *   construction, already `confirmed` — that combination must return
 *   successfully, not fall into this rejection.
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

  return db.runTransaction(async (tx): Promise<PaymentTransitionResult> => {
    const {order, orderRef, payment, paymentRef} =
      await resolveOrderAndPayment(db, tx, input.orderId, input.paymentId);

    if (payment.status === "succeeded") {
      return {payment, order};
    }

    if (order.status !== "pending_payment") {
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
    const paymentUpdate: Partial<Payment> = {status: "succeeded", updatedAt: now};
    if (input.providerPaymentId !== undefined) {
      paymentUpdate.providerPaymentId = input.providerPaymentId;
    }
    tx.update(paymentRef, paymentUpdate);
    tx.update(orderRef, {status: "confirmed", paymentStatus: "paid", updatedAt: now});

    return {
      payment: {...payment, ...paymentUpdate},
      order: {...order, status: "confirmed", paymentStatus: "paid", updatedAt: now},
    };
  });
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
    const update: Partial<Payment> = {
      provider: "razorpay",
      providerOrderId: candidateProviderOrderId,
      updatedAt: now,
    };
    tx.update(paymentRef, update);

    return {payment: {...payment, ...update}, providerOrderId: candidateProviderOrderId, created: true};
  });
}

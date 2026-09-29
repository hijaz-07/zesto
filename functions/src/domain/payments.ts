import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {resolveOrderById, type Order} from "./orders";

/**
 * `organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/orders/{orderId}/payments/{paymentId}`
 * — the v1 payment record for a single order (see root CLAUDE.md's "Never
 * trust the frontend for security" and this checkpoint's payment-foundation
 * notes). Nested one level under the order it belongs to, the same
 * relationship `items` has to its parent `Menu`.
 *
 * v1 is provider-independent by design: no external payment provider is
 * called from this module, and `provider` only ever has one value, `"none"`
 * — a placeholder a future provider adapter will extend, matching this
 * checkpoint's explicit "do not connect a real provider yet" scope.
 * `providerPaymentId` therefore stays unset for every payment this module
 * creates or transitions; it exists only so a future webhook adapter has
 * somewhere to record the provider's own reference once one exists. Never
 * fabricated.
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

/** v1 supports exactly one provider value: no real provider is connected yet. */
export type PaymentProvider = "none";
const PAYMENT_PROVIDER_VALUES = ["none"] as const;

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
  provider: PaymentProvider;
  /** The provider's own reference for this payment, once one exists. Never
   * fabricated — absent for every payment v1 creates or transitions. */
  providerPaymentId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * The customer-safe API response shape for a `Payment` — deliberately just
 * enough for a future provider integration to act on (see this checkpoint's
 * "Payment creation" notes): never `userId`/`organizationId`/`outletId`/
 * `menuId` (internal Firestore path context, not needed by the client), and
 * never `provider`/`providerPaymentId` (provider internals the client has no
 * business seeing, and which don't exist yet for v1 anyway).
 */
export interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amountInPaise: number;
  currency: PaymentCurrency;
  status: PaymentStatus;
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
 * @return {PaymentResponse} The customer-safe API response shape for it.
 */
export function toPaymentResponse(payment: Payment): PaymentResponse {
  return {
    paymentId: payment.id,
    orderId: payment.orderId,
    amountInPaise: payment.amountInPaise,
    currency: payment.currency,
    status: payment.status,
  };
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

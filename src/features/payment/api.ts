import { ApiError, apiFetch } from '../../lib/api/client';
import type { OrderId } from '../order/types';
import { preparePaymentResponseSchema, verifyPaymentResponseSchema } from './schemas';
import type { PreparedPayment, RazorpayCheckoutCallback, VerifiedPayment } from './types';

/**
 * The customer payment API (functions/src/routes/orders.ts's
 * `POST /orders/:orderId/payment` and `.../payment/verify`). Uses the same
 * `apiFetch` every other feature uses — no separate client. The backend is
 * the sole source of the payment's amount, currency, provider order ID, and
 * success state, so neither request carries any of them.
 */

function invalidResponse(): ApiError {
  return new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
}

/**
 * Prepares (or reuses) the Razorpay payment for a `pending_payment` order
 * the caller owns. Idempotent on the backend: repeated calls return the same
 * payment and provider order. Sends NO request body — the amount and
 * currency come from the order itself, so there is nothing for the client
 * to supply (or override).
 */
export async function preparePayment(orderId: OrderId): Promise<{ payment: PreparedPayment }> {
  const data = await apiFetch<unknown>(`/orders/${encodeURIComponent(orderId)}/payment`, { method: 'POST' });
  const parsed = preparePaymentResponseSchema.safeParse(data);
  if (!parsed.success || parsed.data.payment.orderId !== orderId) {
    throw invalidResponse();
  }
  return parsed.data;
}

/**
 * Submits Razorpay Checkout's callback values for server-side signature
 * verification. Sends ONLY the three values Checkout returned — never an
 * amount, currency, user, organization, provider order, or status; the
 * server already knows those and ignores any it's given. The fields are
 * picked explicitly (rather than spreading `callback`) so nothing else a
 * caller's object happens to carry can ever reach the request.
 *
 * Resolving means the server accepted the request, NOT that the payment
 * succeeded — callers must still check the returned order/payment (see
 * `isPaymentConfirmed`).
 */
export async function verifyPayment(orderId: OrderId, callback: RazorpayCheckoutCallback): Promise<VerifiedPayment> {
  const data = await apiFetch<unknown>(`/orders/${encodeURIComponent(orderId)}/payment/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      razorpayPaymentId: callback.razorpayPaymentId,
      razorpayOrderId: callback.razorpayOrderId,
      razorpaySignature: callback.razorpaySignature,
    }),
  });
  const parsed = verifyPaymentResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw invalidResponse();
  }
  return parsed.data;
}

/**
 * Whether a verification response actually proves a successful payment for
 * this order: the payment succeeded AND the order is confirmed and paid.
 * This — never Checkout's browser callback — is the only thing the UI may
 * treat as "payment successful".
 */
export function isPaymentConfirmed(result: VerifiedPayment, orderId: OrderId): boolean {
  return (
    result.order.id === orderId &&
    result.payment.status === 'succeeded' &&
    result.order.status === 'confirmed' &&
    result.order.paymentStatus === 'paid'
  );
}

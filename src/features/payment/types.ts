import type { Order, OrderId } from '../order/types';

/**
 * Customer payment types, mirroring the backend's authoritative response
 * shape (functions/src/domain/payments.ts's `PaymentResponse`). As with
 * `../order/types`, these are always the backend's own computed values —
 * the amount, currency, and provider order ID Razorpay Checkout is opened
 * with are never calculated or substituted on the frontend.
 */

export type PaymentStatus = 'pending' | 'succeeded' | 'failed';

export type PaymentCurrency = 'INR';

/** The backend payment record as returned by `POST /orders/:orderId/payment/verify`. */
export interface PaymentResponse {
  paymentId: string;
  orderId: OrderId;
  amountInPaise: number;
  currency: PaymentCurrency;
  status: PaymentStatus;
  provider: 'none' | 'razorpay';
  providerOrderId?: string;
  providerPaymentId?: string;
}

/**
 * The result of `POST /orders/:orderId/payment`: a payment that is ready to
 * be collected through Razorpay Checkout. Every field Checkout needs is
 * required here (unlike the backend's own optional fields) because
 * `preparePayment` rejects a response missing any of them rather than
 * opening Checkout with partial data.
 */
export interface PreparedPayment {
  paymentId: string;
  orderId: OrderId;
  amountInPaise: number;
  currency: PaymentCurrency;
  status: Exclude<PaymentStatus, 'succeeded'>;
  provider: 'razorpay';
  providerOrderId: string;
  /** Razorpay's PUBLIC Checkout key ID — never the key secret, which never leaves the server. */
  providerKeyId: string;
}

/**
 * The three values Razorpay Checkout hands the browser on success, and the
 * ONLY three values ever sent to `POST /orders/:orderId/payment/verify`.
 * Receiving these does not mean the payment succeeded — only the server's
 * signature verification can establish that.
 */
export interface RazorpayCheckoutCallback {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

/** The server's response to a successful verification call. */
export interface VerifiedPayment {
  order: Order;
  payment: PaymentResponse;
}

/**
 * Why a payment attempt isn't (yet) successful, for the confirmation page to
 * explain. None of these changes anything on the backend — the order stays
 * `pending_payment` and the payment stays `pending` until the SERVER verifies
 * a payment.
 *
 * - `prepare_failed`: the payment couldn't be prepared; nothing was opened.
 * - `checkout_unavailable`: Checkout's script couldn't load or open.
 * - `dismissed`: the customer closed Checkout without paying.
 * - `payment_failed`: Checkout reported a failed attempt, then was closed.
 * - `checkout_response_invalid`: Checkout reported success without the values verification needs.
 * - `verify_failed`: Checkout reported success but the server couldn't verify
 *   it (yet). The Checkout values are kept so verification — never a second
 *   payment — can be retried.
 */
export type PaymentNotice =
  | { kind: 'prepare_failed'; error: unknown }
  | { kind: 'checkout_unavailable'; error: unknown }
  | { kind: 'dismissed' }
  | { kind: 'payment_failed'; description?: string }
  | { kind: 'checkout_response_invalid' }
  | { kind: 'verify_failed'; error: unknown };

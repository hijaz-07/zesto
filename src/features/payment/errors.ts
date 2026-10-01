import { ApiError } from '../../lib/api/client';
import type { PaymentNotice } from './types';

export interface PaymentNoticeText {
  title: string;
  detail: string;
}

const STILL_PENDING = 'Your order is still waiting for payment — you can try again.';

function isUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

/**
 * Maps a failure from the payment-preparation API to customer-facing text.
 * Like `../order/errors.ts`, it surfaces the backend's own `error.message`
 * (already a short, customer-safe sentence — see functions/src/routes/
 * orders.ts and domain/payments.ts) rather than duplicating it here.
 */
function prepareFailureDetail(error: unknown): string {
  if (isUnavailable(error)) {
    return 'Payments are temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'Order not found.';
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Please check your connection and try again.';
}

/**
 * Maps a failure from the payment-verification API to customer-facing text.
 * Always phrased as "not verified yet" — never as a payment failure — since
 * Checkout itself may well have taken the payment.
 */
function verifyFailureDetail(error: unknown): string {
  const reason =
    error instanceof ApiError && !isUnavailable(error) ? error.message : "Your order isn't confirmed yet.";
  return `${reason} Retrying checks the same payment again; it won't start a new one.`;
}

/** The customer-facing title and detail for a payment attempt that didn't succeed. */
export function paymentNoticeText(notice: PaymentNotice): PaymentNoticeText {
  switch (notice.kind) {
    case 'prepare_failed':
      return { title: "Couldn't start your payment", detail: prepareFailureDetail(notice.error) };
    case 'checkout_unavailable':
      return {
        title: "Couldn't open the payment window",
        detail: `Please check your connection and try again. ${STILL_PENDING}`,
      };
    case 'dismissed':
      return { title: 'Payment not completed', detail: STILL_PENDING };
    case 'payment_failed':
      return {
        title: "Payment didn't go through",
        detail: [notice.description, STILL_PENDING].filter(Boolean).join(' '),
      };
    case 'checkout_response_invalid':
      return {
        title: "We couldn't read the payment result",
        detail: `${STILL_PENDING} If you were charged, please contact support.`,
      };
    case 'verify_failed':
      return {
        title: "Payment received by checkout. We couldn't verify it yet.",
        detail: verifyFailureDetail(notice.error),
      };
  }
}

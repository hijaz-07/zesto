import type { Order } from '../order/types';
import type {
  RazorpayCheckoutOptions,
  RazorpayConstructor,
  RazorpayPrefill,
  RazorpaySuccessResponse,
} from './razorpayTypes';
import type { PreparedPayment, RazorpayCheckoutCallback } from './types';

/** The merchant name Checkout displays. */
export const CHECKOUT_MERCHANT_NAME = 'Zesto';

/** Longest Checkout-reported failure text surfaced to the customer. */
const MAX_FAILURE_DESCRIPTION_LENGTH = 200;

/** Optional, customer-safe details Checkout may prefill. Payment never depends on any of them. */
export interface CheckoutCustomer {
  name?: string;
  email?: string;
  contact?: string;
}

export interface OpenCheckoutInput {
  /** The backend's own prepared payment — its amount, currency, provider order, and key are used exactly as given. */
  payment: PreparedPayment;
  description: string;
  customer?: CheckoutCustomer;
}

/**
 * What came of one Checkout session.
 *
 * - `success`: Checkout reported a completed payment attempt. This is NOT
 *   proof of payment — the callback must still be verified server-side.
 * - `dismissed`: the customer closed Checkout without completing payment.
 *   `paymentFailed` is set when Checkout had reported a failed attempt
 *   before it was closed (with Checkout's customer-facing
 *   `failureDescription`, if it gave one). Never a reason to mark anything
 *   failed — the backend stays authoritative.
 * - `invalid_response`: Checkout claimed success without the three values
 *   verification needs.
 */
export type CheckoutResult =
  | { kind: 'success'; callback: RazorpayCheckoutCallback }
  | { kind: 'dismissed'; paymentFailed: boolean; failureDescription?: string }
  | { kind: 'invalid_response' };

export interface CheckoutHandle {
  result: Promise<CheckoutResult>;
  /** Closes Checkout if it's still open (e.g. the customer navigated away); settles `result` as dismissed. */
  close: () => void;
}

function cleaned(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toPrefill(customer: CheckoutCustomer | undefined): RazorpayPrefill | undefined {
  if (!customer) {
    return undefined;
  }
  const prefill: RazorpayPrefill = {};
  const name = cleaned(customer.name);
  const email = cleaned(customer.email);
  const contact = cleaned(customer.contact);
  if (name) {
    prefill.name = name;
  }
  if (email) {
    prefill.email = email;
  }
  if (contact) {
    prefill.contact = contact;
  }
  return Object.keys(prefill).length > 0 ? prefill : undefined;
}

/**
 * A concise, order-specific Checkout description that carries no internal
 * IDs (Razorpay shows this text to the customer), e.g. "Pre-order · 3 items".
 */
export function checkoutDescription(order: Pick<Order, 'items'>): string {
  const quantity = order.items.reduce((total, item) => total + item.quantity, 0);
  return `Pre-order · ${quantity} ${quantity === 1 ? 'item' : 'items'}`;
}

/**
 * Builds Checkout's options straight from the backend-prepared payment:
 * `key` = `providerKeyId`, `amount` = `amountInPaise`, `currency` =
 * `currency`, `order_id` = `providerOrderId`. Nothing is derived from the
 * cart or any other client-held amount, and nothing secret is included —
 * the key secret never reaches the browser, and neither does the Descope
 * session token or any Firebase/Firestore detail.
 */
export function buildCheckoutOptions(
  input: OpenCheckoutInput,
  handlers: { onSuccess: (response: RazorpaySuccessResponse) => void; onDismiss: () => void },
): RazorpayCheckoutOptions {
  const { payment, description, customer } = input;
  const options: RazorpayCheckoutOptions = {
    key: payment.providerKeyId,
    amount: payment.amountInPaise,
    currency: payment.currency,
    name: CHECKOUT_MERCHANT_NAME,
    description,
    order_id: payment.providerOrderId,
    handler: handlers.onSuccess,
    modal: { ondismiss: handlers.onDismiss, confirm_close: true },
  };
  const prefill = toPrefill(customer);
  if (prefill) {
    options.prefill = prefill;
  }
  return options;
}

function toCallback(response: RazorpaySuccessResponse | undefined): RazorpayCheckoutCallback | null {
  const razorpayPaymentId = response?.razorpay_payment_id;
  const razorpayOrderId = response?.razorpay_order_id;
  const razorpaySignature = response?.razorpay_signature;
  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return null;
  }
  return { razorpayPaymentId, razorpayOrderId, razorpaySignature };
}

/**
 * Opens Razorpay Checkout for a prepared payment and reports how that
 * session ends. Checkout's `payment.failed` event doesn't end the session —
 * the customer can retry inside the same modal — so a failure is only
 * remembered and reported if the modal is then closed unpaid; if the
 * customer succeeds on a retry, `handler` still fires normally.
 *
 * Throws synchronously if Checkout itself can't be constructed or opened.
 */
export function openCheckout(Razorpay: RazorpayConstructor, input: OpenCheckoutInput): CheckoutHandle {
  let settle: (result: CheckoutResult) => void = () => {};
  const result = new Promise<CheckoutResult>((resolve) => {
    let settled = false;
    settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
  });

  let paymentFailed = false;
  let failureDescription: string | undefined;
  const dismissed = (): CheckoutResult => ({ kind: 'dismissed', paymentFailed, failureDescription });

  const instance = new Razorpay(
    buildCheckoutOptions(input, {
      onSuccess: (response) => {
        const callback = toCallback(response);
        settle(callback ? { kind: 'success', callback } : { kind: 'invalid_response' });
      },
      onDismiss: () => settle(dismissed()),
    }),
  );

  instance.on('payment.failed', (response) => {
    paymentFailed = true;
    failureDescription = cleaned(response?.error?.description)?.slice(0, MAX_FAILURE_DESCRIPTION_LENGTH);
  });

  instance.open();

  return {
    result,
    close: () => {
      settle(dismissed());
      instance.close();
    },
  };
}

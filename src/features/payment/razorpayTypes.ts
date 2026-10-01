/**
 * The small slice of Razorpay's Web Checkout API (checkout.razorpay.com/v1/
 * checkout.js) Zesto uses. Hand-written rather than pulling in a types
 * package: the hosted script is the only integration, and everything here
 * is intentionally limited to what `razorpayCheckout.ts` actually calls.
 */

/** The values Checkout invokes `handler` with once a payment attempt completes. Not proof of payment — see `RazorpayCheckoutCallback`. */
export interface RazorpaySuccessResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

/** The payload of Checkout's `payment.failed` event. The modal stays open afterwards, so the customer may still retry inside it. */
export interface RazorpayFailureResponse {
  error?: {
    code?: string;
    description?: string;
    reason?: string;
  };
}

export interface RazorpayPrefill {
  name?: string;
  email?: string;
  contact?: string;
}

export interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpaySuccessResponse) => void;
  prefill?: RazorpayPrefill;
  modal?: {
    ondismiss?: () => void;
    confirm_close?: boolean;
  };
}

export interface RazorpayInstance {
  open: () => void;
  close: () => void;
  on: (event: 'payment.failed', callback: (response: RazorpayFailureResponse) => void) => void;
}

export type RazorpayConstructor = new (options: RazorpayCheckoutOptions) => RazorpayInstance;

declare global {
  interface Window {
    /** Defined only after the Checkout script has loaded (see `razorpayScript.ts`). */
    Razorpay?: RazorpayConstructor;
  }
}

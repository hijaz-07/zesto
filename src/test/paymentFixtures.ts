import { vi } from 'vitest';
import type { Order } from '../features/order/types';
import type {
  RazorpayCheckoutOptions,
  RazorpayFailureResponse,
  RazorpaySuccessResponse,
} from '../features/payment/razorpayTypes';
import type { PaymentResponse, PreparedPayment, RazorpayCheckoutCallback } from '../features/payment/types';

/** A pending_payment order as the backend returns it. */
export const pendingOrder: Order = {
  id: 'order-1',
  organizationId: 'org-1',
  outletId: 'outlet-1',
  menuId: 'menu-1',
  status: 'pending_payment',
  paymentStatus: 'pending',
  currency: 'INR',
  subtotalInPaise: 30000,
  totalInPaise: 30000,
  items: [
    { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000 },
    { itemId: 'item-2', name: 'Veg Meals', priceInPaise: 6000, quantity: 1, lineTotalInPaise: 6000 },
  ],
  createdAt: '2026-09-30T08:00:00+05:30',
  updatedAt: '2026-09-30T08:00:00+05:30',
};

/** The same order after server-side payment verification. */
export const confirmedOrder: Order = {
  ...pendingOrder,
  status: 'confirmed',
  paymentStatus: 'paid',
  updatedAt: '2026-09-30T08:05:00+05:30',
};

/** Distinct, obviously-fake values, so a test can tell exactly which one reached Checkout. */
export const preparedPayment: PreparedPayment = {
  paymentId: 'order-1',
  orderId: 'order-1',
  amountInPaise: 30000,
  currency: 'INR',
  status: 'pending',
  provider: 'razorpay',
  providerOrderId: 'order_FakeProviderOrder1',
  providerKeyId: 'rzp_test_FakePublicKeyId',
};

/** What Checkout's `handler` receives. */
export const checkoutSuccessResponse: RazorpaySuccessResponse = {
  razorpay_payment_id: 'pay_FakePaymentId1',
  razorpay_order_id: 'order_FakeProviderOrder1',
  razorpay_signature: 'fake_signature_value',
};

/** The same values, as sent to the verification endpoint. */
export const checkoutCallback: RazorpayCheckoutCallback = {
  razorpayPaymentId: 'pay_FakePaymentId1',
  razorpayOrderId: 'order_FakeProviderOrder1',
  razorpaySignature: 'fake_signature_value',
};

export const succeededPayment: PaymentResponse = {
  paymentId: 'order-1',
  orderId: 'order-1',
  amountInPaise: 30000,
  currency: 'INR',
  status: 'succeeded',
  provider: 'razorpay',
  providerOrderId: 'order_FakeProviderOrder1',
  providerPaymentId: 'pay_FakePaymentId1',
};

/**
 * A stand-in for Razorpay's global `Razorpay` constructor. Records the
 * options it was constructed with and lets a test play the parts Razorpay
 * Checkout plays: the success handler, the dismiss callback, and the
 * `payment.failed` event.
 */
export class FakeRazorpay {
  static instances: FakeRazorpay[] = [];

  static reset(): void {
    FakeRazorpay.instances = [];
  }

  static get last(): FakeRazorpay {
    const instance = FakeRazorpay.instances[FakeRazorpay.instances.length - 1];
    if (!instance) {
      throw new Error('No FakeRazorpay instance was constructed.');
    }
    return instance;
  }

  readonly options: RazorpayCheckoutOptions;
  readonly open = vi.fn();
  readonly close = vi.fn();
  private failureListeners: Array<(response: RazorpayFailureResponse) => void> = [];

  constructor(options: RazorpayCheckoutOptions) {
    this.options = options;
    FakeRazorpay.instances.push(this);
  }

  on(_event: 'payment.failed', callback: (response: RazorpayFailureResponse) => void): void {
    this.failureListeners.push(callback);
  }

  succeed(response: RazorpaySuccessResponse = checkoutSuccessResponse): void {
    this.options.handler(response);
  }

  dismiss(): void {
    this.options.modal?.ondismiss?.();
  }

  fail(description?: string): void {
    for (const listener of this.failureListeners) {
      listener({ error: { code: 'BAD_REQUEST_ERROR', description } });
    }
  }
}

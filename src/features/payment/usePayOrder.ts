import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api/client';
import type { Order, OrderId } from '../order/types';
import { isPaymentConfirmed, preparePayment, verifyPayment } from './api';
import { openCheckout, type CheckoutCustomer, type CheckoutHandle } from './razorpayCheckout';
import { loadRazorpayCheckout } from './razorpayScript';
import type { PaymentNotice, PreparedPayment, RazorpayCheckoutCallback } from './types';

export type PayOrderPhase = 'idle' | 'preparing' | 'checkout' | 'verifying' | 'verified';

interface PayOrderState {
  phase: PayOrderPhase;
  notice: PaymentNotice | null;
  confirmedOrder: Order | null;
}

const INITIAL_STATE: PayOrderState = { phase: 'idle', notice: null, confirmedOrder: null };

export interface UsePayOrderOptions {
  orderId: OrderId | undefined;
  /** Shown by Checkout — see `checkoutDescription`. */
  description: string;
  /** Optional prefill; payment never depends on it. */
  customer?: CheckoutCustomer;
}

export interface UsePayOrderResult {
  phase: PayOrderPhase;
  /** Why the last attempt didn't succeed, if it didn't. Cleared when a new attempt starts. */
  notice: PaymentNotice | null;
  /** The backend's confirmed order, set ONLY once server verification succeeded. */
  confirmedOrder: Order | null;
  /** An attempt is in progress; starting another is not possible. */
  busy: boolean;
  /** Prepares (or reuses) the payment, opens Checkout, and — if Checkout reports success — verifies it server-side. */
  pay: () => Promise<void>;
  /** Re-sends the Checkout values for server verification after a `verify_failed` notice. Never prepares a new payment. */
  retryVerification: () => Promise<void>;
}

/**
 * Drives one order's payment: prepare → Checkout → server verification.
 *
 * The browser never decides a payment succeeded. Checkout's success callback
 * only produces three values, which are sent to the server; `confirmedOrder`
 * is set solely from a server response proving `payment: succeeded`,
 * `order: confirmed`, `paymentStatus: paid`. Closing Checkout, a
 * Checkout-reported failure, or any error leaves the order exactly as it
 * was (`pending_payment`) and the customer free to try again — nothing here
 * writes a payment failure anywhere.
 *
 * Repeated calls are safe: a ref-based lock (state updates lag a rapid
 * double-click) ensures only one attempt runs at a time, and preparing is
 * idempotent on the backend, so a retry reuses the same payment and
 * provider order rather than creating another. After Checkout succeeds but
 * verification fails (e.g. no network), the Checkout values are held in
 * memory so only `retryVerification` runs next — `pay` is refused until
 * verification succeeds, so a second payment is never started for an order
 * whose first payment may already have been taken.
 */
export function usePayOrder({ orderId, description, customer }: UsePayOrderOptions): UsePayOrderResult {
  const [state, setState] = useState<PayOrderState>(INITIAL_STATE);
  const inFlight = useRef(false);
  const pendingVerification = useRef<RazorpayCheckoutCallback | null>(null);
  const checkout = useRef<CheckoutHandle | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the page must not leave a payment modal open with nothing
      // listening for its outcome.
      checkout.current?.close();
      checkout.current = null;
    };
  }, []);

  function update(next: Partial<PayOrderState>) {
    if (mounted.current) {
      setState((current) => ({ ...current, ...next }));
    }
  }

  async function verify(forOrderId: OrderId, callback: RazorpayCheckoutCallback) {
    update({ phase: 'verifying', notice: null });
    try {
      const result = await verifyPayment(forOrderId, callback);
      if (!isPaymentConfirmed(result, forOrderId)) {
        throw new ApiError(200, 'payment_not_confirmed', 'The server did not confirm this payment.');
      }
      pendingVerification.current = null;
      update({ phase: 'verified', notice: null, confirmedOrder: result.order });
    } catch (error) {
      update({ phase: 'idle', notice: { kind: 'verify_failed', error } });
    }
  }

  async function prepareAndCollect(forOrderId: OrderId) {
    // Start loading Checkout alongside the server call; a failure of either
    // is reported on its own below.
    const scriptLoad = loadRazorpayCheckout();
    scriptLoad.catch(() => {});

    let payment: PreparedPayment;
    try {
      payment = (await preparePayment(forOrderId)).payment;
    } catch (error) {
      update({ phase: 'idle', notice: { kind: 'prepare_failed', error } });
      return;
    }

    let handle: CheckoutHandle;
    try {
      const Razorpay = await scriptLoad;
      if (!mounted.current) {
        return;
      }
      handle = openCheckout(Razorpay, { payment, description, customer });
    } catch (error) {
      update({ phase: 'idle', notice: { kind: 'checkout_unavailable', error } });
      return;
    }

    checkout.current = handle;
    update({ phase: 'checkout' });
    const result = await handle.result;
    checkout.current = null;

    if (result.kind === 'dismissed') {
      update({
        phase: 'idle',
        notice: result.paymentFailed
          ? { kind: 'payment_failed', description: result.failureDescription }
          : { kind: 'dismissed' },
      });
    } else if (result.kind === 'invalid_response') {
      update({ phase: 'idle', notice: { kind: 'checkout_response_invalid' } });
    } else {
      pendingVerification.current = result.callback;
      await verify(forOrderId, result.callback);
    }
  }

  async function pay() {
    if (!orderId || inFlight.current || pendingVerification.current) {
      return;
    }
    inFlight.current = true;
    update({ phase: 'preparing', notice: null });
    try {
      await prepareAndCollect(orderId);
    } finally {
      inFlight.current = false;
    }
  }

  async function retryVerification() {
    const callback = pendingVerification.current;
    if (!orderId || !callback || inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      await verify(orderId, callback);
    } finally {
      inFlight.current = false;
    }
  }

  return {
    phase: state.phase,
    notice: state.notice,
    confirmedOrder: state.confirmedOrder,
    busy: state.phase === 'preparing' || state.phase === 'checkout' || state.phase === 'verifying',
    pay,
    retryVerification,
  };
}

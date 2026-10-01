import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import {
  checkoutCallback,
  confirmedOrder,
  FakeRazorpay,
  pendingOrder,
  preparedPayment,
  succeededPayment,
} from '../../test/paymentFixtures';
import { RazorpayScriptError } from './razorpayScript';
import { usePayOrder } from './usePayOrder';

const preparePaymentMock = vi.hoisted(() => vi.fn());
const verifyPaymentMock = vi.hoisted(() => vi.fn());
const loadRazorpayCheckoutMock = vi.hoisted(() => vi.fn());

vi.mock('./api', async (importOriginal) => ({
  // Keep the real `isPaymentConfirmed`: it's the check under test.
  ...(await importOriginal<typeof import('./api')>()),
  preparePayment: preparePaymentMock,
  verifyPayment: verifyPaymentMock,
}));
vi.mock('./razorpayScript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./razorpayScript')>()),
  loadRazorpayCheckout: loadRazorpayCheckoutMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** `null` renders the hook with no order ID (a default parameter would swallow `undefined`). */
function renderPayHook(orderId: string | null = 'order-1') {
  return renderHook(() =>
    usePayOrder({ orderId: orderId ?? undefined, description: 'Pre-order · 3 items', customer: { name: 'Asha' } }),
  );
}

/** Starts a payment and waits until Checkout is open. */
async function startAndOpenCheckout(result: { current: ReturnType<typeof usePayOrder> }) {
  act(() => {
    void result.current.pay();
  });
  await waitFor(() => expect(result.current.phase).toBe('checkout'));
}

describe('usePayOrder', () => {
  beforeEach(() => {
    FakeRazorpay.reset();
    preparePaymentMock.mockReset();
    verifyPaymentMock.mockReset();
    loadRazorpayCheckoutMock.mockReset();
    preparePaymentMock.mockResolvedValue({ payment: preparedPayment });
    loadRazorpayCheckoutMock.mockResolvedValue(FakeRazorpay);
    verifyPaymentMock.mockResolvedValue({ order: confirmedOrder, payment: succeededPayment });
  });

  it('starts idle, with nothing confirmed', () => {
    const { result } = renderPayHook();

    expect(result.current).toMatchObject({ phase: 'idle', notice: null, confirmedOrder: null, busy: false });
  });

  describe('preparation', () => {
    it('prepares the payment for the order, then opens Checkout with the backend-authoritative values', async () => {
      const { result } = renderPayHook();

      await startAndOpenCheckout(result);

      expect(preparePaymentMock).toHaveBeenCalledTimes(1);
      expect(preparePaymentMock).toHaveBeenCalledWith('order-1');
      expect(FakeRazorpay.last.options).toMatchObject({
        key: 'rzp_test_FakePublicKeyId',
        amount: 30000,
        currency: 'INR',
        order_id: 'order_FakeProviderOrder1',
        name: 'Zesto',
        description: 'Pre-order · 3 items',
        prefill: { name: 'Asha' },
      });
      expect(FakeRazorpay.last.open).toHaveBeenCalledTimes(1);
    });

    it('is busy while preparing, so the action is disabled', async () => {
      const preparing = deferred<{ payment: typeof preparedPayment }>();
      preparePaymentMock.mockReturnValue(preparing.promise);
      const { result } = renderPayHook();

      act(() => {
        void result.current.pay();
      });

      await waitFor(() => expect(result.current.phase).toBe('preparing'));
      expect(result.current.busy).toBe(true);

      preparing.resolve({ payment: preparedPayment });
      await waitFor(() => expect(result.current.phase).toBe('checkout'));
    });

    it('ignores repeated pay() calls while one attempt is in flight — one preparation, one Checkout', async () => {
      const preparing = deferred<{ payment: typeof preparedPayment }>();
      preparePaymentMock.mockReturnValue(preparing.promise);
      const { result } = renderPayHook();

      act(() => {
        void result.current.pay();
        void result.current.pay();
        void result.current.pay();
      });
      preparing.resolve({ payment: preparedPayment });
      await waitFor(() => expect(result.current.phase).toBe('checkout'));
      act(() => {
        void result.current.pay();
      });

      expect(preparePaymentMock).toHaveBeenCalledTimes(1);
      expect(FakeRazorpay.instances).toHaveLength(1);
    });

    it('does nothing without an order ID', async () => {
      const { result } = renderPayHook(null);

      await act(async () => {
        await result.current.pay();
      });

      expect(preparePaymentMock).not.toHaveBeenCalled();
      expect(result.current.phase).toBe('idle');
    });

    it('reports a preparation failure, opens no Checkout, and allows a retry', async () => {
      preparePaymentMock.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'unavailable'));
      const { result } = renderPayHook();

      await act(async () => {
        await result.current.pay();
      });

      expect(result.current.phase).toBe('idle');
      expect(result.current.busy).toBe(false);
      expect(result.current.notice).toMatchObject({ kind: 'prepare_failed' });
      expect(FakeRazorpay.instances).toHaveLength(0);

      await startAndOpenCheckout(result);
      expect(result.current.notice).toBeNull();
      expect(preparePaymentMock).toHaveBeenCalledTimes(2);
    });

    it('reports a script load failure, opens no Checkout, and allows a retry', async () => {
      loadRazorpayCheckoutMock.mockRejectedValueOnce(new RazorpayScriptError('load_failed', 'nope'));
      const { result } = renderPayHook();

      await act(async () => {
        await result.current.pay();
      });

      expect(result.current.phase).toBe('idle');
      expect(result.current.notice).toMatchObject({ kind: 'checkout_unavailable' });
      expect(FakeRazorpay.instances).toHaveLength(0);

      await startAndOpenCheckout(result);
      expect(result.current.notice).toBeNull();
    });

    it('reports a Checkout that cannot be opened as unavailable', async () => {
      loadRazorpayCheckoutMock.mockResolvedValue(
        class {
          constructor() {
            throw new Error('bad options');
          }
        },
      );
      const { result } = renderPayHook();

      await act(async () => {
        await result.current.pay();
      });

      expect(result.current.notice).toMatchObject({ kind: 'checkout_unavailable' });
      expect(result.current.confirmedOrder).toBeNull();
    });
  });

  describe('Checkout outcomes', () => {
    it('closing Checkout leaves the order unpaid, verifies nothing, and allows a retry', async () => {
      const { result } = renderPayHook();
      await startAndOpenCheckout(result);

      act(() => FakeRazorpay.last.dismiss());

      await waitFor(() => expect(result.current.notice).toEqual({ kind: 'dismissed' }));
      expect(result.current).toMatchObject({ phase: 'idle', confirmedOrder: null, busy: false });
      expect(verifyPaymentMock).not.toHaveBeenCalled();

      await startAndOpenCheckout(result);
      expect(preparePaymentMock).toHaveBeenCalledTimes(2);
    });

    it('a Checkout-reported failure is only a notice: nothing is verified, confirmed, or written, and retry stays possible', async () => {
      const { result } = renderPayHook();
      await startAndOpenCheckout(result);

      act(() => {
        FakeRazorpay.last.fail('Declined by the bank.');
        FakeRazorpay.last.dismiss();
      });

      await waitFor(() =>
        expect(result.current.notice).toEqual({ kind: 'payment_failed', description: 'Declined by the bank.' }),
      );
      expect(result.current.confirmedOrder).toBeNull();
      expect(verifyPaymentMock).not.toHaveBeenCalled();

      await startAndOpenCheckout(result);
    });

    it('treats a Checkout success without the verification values as an unreadable result, never as success', async () => {
      const { result } = renderPayHook();
      await startAndOpenCheckout(result);

      act(() => FakeRazorpay.last.succeed({ ...checkoutCallbackSnake(), razorpay_signature: '' }));

      await waitFor(() => expect(result.current.notice).toEqual({ kind: 'checkout_response_invalid' }));
      expect(verifyPaymentMock).not.toHaveBeenCalled();
      expect(result.current.confirmedOrder).toBeNull();
    });

    it('closes an open Checkout if the page is left', async () => {
      const { result, unmount } = renderPayHook();
      await startAndOpenCheckout(result);

      unmount();

      expect(FakeRazorpay.last.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('server verification', () => {
    it("sends only Checkout's three values for verification — and is NOT successful until the server answers", async () => {
      const verifying = deferred<{ order: typeof confirmedOrder; payment: typeof succeededPayment }>();
      verifyPaymentMock.mockReturnValue(verifying.promise);
      const { result } = renderPayHook();
      await startAndOpenCheckout(result);

      act(() => FakeRazorpay.last.succeed());

      await waitFor(() => expect(result.current.phase).toBe('verifying'));
      expect(verifyPaymentMock).toHaveBeenCalledWith('order-1', checkoutCallback);
      // Checkout's callback has fired, but the server hasn't spoken yet.
      expect(result.current.confirmedOrder).toBeNull();
      expect(result.current.busy).toBe(true);

      verifying.resolve({ order: confirmedOrder, payment: succeededPayment });
      await waitFor(() => expect(result.current.phase).toBe('verified'));
    });

    it("becomes verified, with the server's order, only when the server confirms", async () => {
      const { result } = renderPayHook();
      await startAndOpenCheckout(result);

      act(() => FakeRazorpay.last.succeed());

      await waitFor(() => expect(result.current.phase).toBe('verified'));
      expect(result.current.confirmedOrder).toEqual(confirmedOrder);
      expect(result.current.notice).toBeNull();
      expect(result.current.busy).toBe(false);
    });

    it.each([
      ['the payment is still pending', { order: confirmedOrder, payment: { ...succeededPayment, status: 'pending' as const } }],
      ['the order is still pending_payment', { order: pendingOrder, payment: succeededPayment }],
      ['the order is not marked paid', { order: { ...confirmedOrder, paymentStatus: 'pending' as const }, payment: succeededPayment }],
    ])('is NOT successful when the server responds but %s', async (_label, response) => {
      verifyPaymentMock.mockResolvedValue(response);
      const { result } = renderPayHook();
      await startAndOpenCheckout(result);

      act(() => FakeRazorpay.last.succeed());

      await waitFor(() => expect(result.current.notice).toMatchObject({ kind: 'verify_failed' }));
      expect(result.current.phase).toBe('idle');
      expect(result.current.confirmedOrder).toBeNull();
    });

    it('is NOT successful when verification is rejected (e.g. an invalid signature)', async () => {
      verifyPaymentMock.mockRejectedValue(
        new ApiError(400, 'invalid_argument', 'The payment signature could not be verified.'),
      );
      const { result } = renderPayHook();
      await startAndOpenCheckout(result);

      act(() => FakeRazorpay.last.succeed());

      await waitFor(() => expect(result.current.notice).toMatchObject({ kind: 'verify_failed' }));
      expect(result.current.confirmedOrder).toBeNull();
    });

    describe('after a network failure following a successful Checkout', () => {
      async function checkoutSucceededButVerifyFailed() {
        verifyPaymentMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const rendered = renderPayHook();
        await startAndOpenCheckout(rendered.result);
        act(() => FakeRazorpay.last.succeed());
        await waitFor(() => expect(rendered.result.current.notice).toMatchObject({ kind: 'verify_failed' }));
        return rendered;
      }

      it('does not show success', async () => {
        const { result } = await checkoutSucceededButVerifyFailed();

        expect(result.current.phase).toBe('idle');
        expect(result.current.confirmedOrder).toBeNull();
      });

      it('refuses to start a second payment: no new preparation, no new Checkout', async () => {
        const { result } = await checkoutSucceededButVerifyFailed();

        await act(async () => {
          await result.current.pay();
        });

        expect(preparePaymentMock).toHaveBeenCalledTimes(1);
        expect(FakeRazorpay.instances).toHaveLength(1);
        expect(result.current.notice).toMatchObject({ kind: 'verify_failed' });
      });

      it("retryVerification re-sends the same Checkout values for the same order, without preparing again", async () => {
        const { result } = await checkoutSucceededButVerifyFailed();

        await act(async () => {
          await result.current.retryVerification();
        });

        expect(verifyPaymentMock).toHaveBeenCalledTimes(2);
        expect(verifyPaymentMock).toHaveBeenLastCalledWith('order-1', checkoutCallback);
        expect(preparePaymentMock).toHaveBeenCalledTimes(1);
        expect(result.current.phase).toBe('verified');
        expect(result.current.confirmedOrder).toEqual(confirmedOrder);
      });

      it('can retry verification repeatedly until the server answers', async () => {
        const { result } = await checkoutSucceededButVerifyFailed();
        verifyPaymentMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await act(async () => {
          await result.current.retryVerification();
        });
        expect(result.current.notice).toMatchObject({ kind: 'verify_failed' });

        await act(async () => {
          await result.current.retryVerification();
        });
        expect(result.current.phase).toBe('verified');
        expect(verifyPaymentMock).toHaveBeenCalledTimes(3);
      });

      it('ignores a retryVerification call while one is already in flight', async () => {
        const { result } = await checkoutSucceededButVerifyFailed();
        const retrying = deferred<{ order: typeof confirmedOrder; payment: typeof succeededPayment }>();
        verifyPaymentMock.mockReturnValue(retrying.promise);

        act(() => {
          void result.current.retryVerification();
          void result.current.retryVerification();
        });
        retrying.resolve({ order: confirmedOrder, payment: succeededPayment });
        await waitFor(() => expect(result.current.phase).toBe('verified'));

        expect(verifyPaymentMock).toHaveBeenCalledTimes(2);
      });
    });

    it('retryVerification does nothing when there is nothing to verify', async () => {
      const { result } = renderPayHook();

      await act(async () => {
        await result.current.retryVerification();
      });

      expect(verifyPaymentMock).not.toHaveBeenCalled();
    });
  });
});

/** Checkout's raw (snake_case) success response, as `FakeRazorpay.succeed` takes it. */
function checkoutCallbackSnake() {
  return {
    razorpay_payment_id: checkoutCallback.razorpayPaymentId,
    razorpay_order_id: checkoutCallback.razorpayOrderId,
    razorpay_signature: checkoutCallback.razorpaySignature,
  };
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import {
  checkoutCallback,
  confirmedOrder,
  pendingOrder,
  preparedPayment,
  succeededPayment,
} from '../../test/paymentFixtures';
import { isPaymentConfirmed, preparePayment, verifyPayment } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: apiFetchMock,
}));

describe('preparePayment', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('POSTs /orders/{orderId}/payment with no request body and no headers', async () => {
    apiFetchMock.mockResolvedValue({ payment: preparedPayment });

    await preparePayment('order-1');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders/order-1/payment', { method: 'POST' });
    const [, init] = apiFetchMock.mock.calls[0];
    expect(init).not.toHaveProperty('body');
  });

  it("encodes the order ID so it can't alter the request path", async () => {
    apiFetchMock.mockResolvedValue({ payment: { ...preparedPayment, orderId: '../x' } });

    await preparePayment('../x');

    expect(apiFetchMock.mock.calls[0][0]).toBe('/orders/..%2Fx/payment');
  });

  it("parses the backend's response into the exact values Checkout needs", async () => {
    apiFetchMock.mockResolvedValue({ payment: preparedPayment });

    const result = await preparePayment('order-1');

    expect(result.payment).toEqual({
      paymentId: 'order-1',
      orderId: 'order-1',
      amountInPaise: 30000,
      currency: 'INR',
      status: 'pending',
      provider: 'razorpay',
      providerOrderId: 'order_FakeProviderOrder1',
      providerKeyId: 'rzp_test_FakePublicKeyId',
    });
  });

  it.each([
    ['providerOrderId', { providerOrderId: undefined }],
    ['providerKeyId', { providerKeyId: undefined }],
    ['an empty providerKeyId', { providerKeyId: '' }],
    ['a zero amount', { amountInPaise: 0 }],
    ['a fractional amount', { amountInPaise: 100.5 }],
    ['a non-INR currency', { currency: 'USD' }],
    ['a non-Razorpay provider', { provider: 'none' }],
    ['an already-succeeded payment', { status: 'succeeded' }],
  ])('rejects a response with %s, rather than opening Checkout with partial data', async (_label, override) => {
    apiFetchMock.mockResolvedValue({ payment: { ...preparedPayment, ...override } });

    await expect(preparePayment('order-1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a response for a different order than the one requested', async () => {
    apiFetchMock.mockResolvedValue({ payment: { ...preparedPayment, orderId: 'someone-elses-order' } });

    await expect(preparePayment('order-1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a response with no payment at all', async () => {
    apiFetchMock.mockResolvedValue({});

    await expect(preparePayment('order-1')).rejects.toBeInstanceOf(ApiError);
  });

  it('propagates an API error as-is', async () => {
    const error = new ApiError(400, 'invalid_argument', 'This order is not awaiting payment.', 'req-1');
    apiFetchMock.mockRejectedValue(error);

    await expect(preparePayment('order-1')).rejects.toBe(error);
  });
});

describe('verifyPayment', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('POSTs /orders/{orderId}/payment/verify with only the three Razorpay callback fields', async () => {
    apiFetchMock.mockResolvedValue({ order: confirmedOrder, payment: succeededPayment });

    await verifyPayment('order-1', checkoutCallback);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/orders/order-1/payment/verify');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      razorpayPaymentId: 'pay_FakePaymentId1',
      razorpayOrderId: 'order_FakeProviderOrder1',
      razorpaySignature: 'fake_signature_value',
    });
    expect(Object.keys(body).sort()).toEqual(['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature']);
  });

  it('never sends amount, currency, user, organization, provider order, or status — even if the caller object carries them', async () => {
    apiFetchMock.mockResolvedValue({ order: confirmedOrder, payment: succeededPayment });
    const tampered = {
      ...checkoutCallback,
      amountInPaise: 1,
      currency: 'USD',
      userId: 'attacker',
      organizationId: 'org-attacker',
      providerOrderId: 'order_Attacker',
      status: 'succeeded',
      paymentStatus: 'paid',
    };

    await verifyPayment('order-1', tampered);

    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(body).sort()).toEqual(['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature']);
  });

  it("parses the server's confirmed order and succeeded payment", async () => {
    apiFetchMock.mockResolvedValue({ order: confirmedOrder, payment: succeededPayment });

    const result = await verifyPayment('order-1', checkoutCallback);

    expect(result.order).toEqual(confirmedOrder);
    expect(result.payment).toEqual(succeededPayment);
  });

  it('rejects a response whose order or payment is missing or malformed', async () => {
    apiFetchMock.mockResolvedValueOnce({ order: confirmedOrder });
    await expect(verifyPayment('order-1', checkoutCallback)).rejects.toMatchObject({ code: 'invalid_response' });

    apiFetchMock.mockResolvedValueOnce({ order: { ...confirmedOrder, status: 'bogus' }, payment: succeededPayment });
    await expect(verifyPayment('order-1', checkoutCallback)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('propagates an API error (e.g. an invalid signature) as-is', async () => {
    const error = new ApiError(400, 'invalid_argument', 'The payment signature could not be verified.');
    apiFetchMock.mockRejectedValue(error);

    await expect(verifyPayment('order-1', checkoutCallback)).rejects.toBe(error);
  });

  it('propagates a network failure as-is', async () => {
    const error = new TypeError('Failed to fetch');
    apiFetchMock.mockRejectedValue(error);

    await expect(verifyPayment('order-1', checkoutCallback)).rejects.toBe(error);
  });
});

describe('isPaymentConfirmed', () => {
  it('is true only when the payment succeeded and the order is confirmed and paid', () => {
    expect(isPaymentConfirmed({ order: confirmedOrder, payment: succeededPayment }, 'order-1')).toBe(true);
  });

  it.each([
    ['the payment is still pending', { order: confirmedOrder, payment: { ...succeededPayment, status: 'pending' as const } }],
    ['the payment failed', { order: confirmedOrder, payment: { ...succeededPayment, status: 'failed' as const } }],
    ['the order is still pending_payment', { order: pendingOrder, payment: succeededPayment }],
    ['the order is paid but not confirmed', { order: { ...confirmedOrder, status: 'cancelled' as const }, payment: succeededPayment }],
    ['the order is confirmed but not paid', { order: { ...confirmedOrder, paymentStatus: 'pending' as const }, payment: succeededPayment }],
    ['the order is a different order', { order: { ...confirmedOrder, id: 'order-2' }, payment: succeededPayment }],
  ])('is false when %s', (_label, result) => {
    expect(isPaymentConfirmed(result, 'order-1')).toBe(false);
  });
});

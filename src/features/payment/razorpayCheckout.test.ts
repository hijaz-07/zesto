import { beforeEach, describe, expect, it } from 'vitest';
import { checkoutSuccessResponse, FakeRazorpay, pendingOrder, preparedPayment } from '../../test/paymentFixtures';
import { buildCheckoutOptions, checkoutDescription, openCheckout } from './razorpayCheckout';

const noopHandlers = { onSuccess: () => {}, onDismiss: () => {} };

describe('buildCheckoutOptions', () => {
  it("uses the backend's key, amount, currency, and provider order ID exactly as given", () => {
    const options = buildCheckoutOptions({ payment: preparedPayment, description: 'Pre-order · 3 items' }, noopHandlers);

    expect(options.key).toBe('rzp_test_FakePublicKeyId');
    expect(options.amount).toBe(30000);
    expect(options.currency).toBe('INR');
    expect(options.order_id).toBe('order_FakeProviderOrder1');
  });

  it('shows Zesto and the given description', () => {
    const options = buildCheckoutOptions({ payment: preparedPayment, description: 'Pre-order · 3 items' }, noopHandlers);

    expect(options.name).toBe('Zesto');
    expect(options.description).toBe('Pre-order · 3 items');
  });

  it('is a different amount/order for a different prepared payment — nothing is hard-coded or cached', () => {
    const options = buildCheckoutOptions(
      {
        payment: { ...preparedPayment, amountInPaise: 4500, providerOrderId: 'order_Other', providerKeyId: 'rzp_test_Other' },
        description: 'x',
      },
      noopHandlers,
    );

    expect(options).toMatchObject({ key: 'rzp_test_Other', amount: 4500, order_id: 'order_Other' });
  });

  it('contains exactly the expected Checkout options — nothing else (no secret, token, Firestore path, or total) can ride along', () => {
    const options = buildCheckoutOptions({ payment: preparedPayment, description: 'Pre-order · 3 items' }, noopHandlers);

    expect(Object.keys(options).sort()).toEqual([
      'amount',
      'currency',
      'description',
      'handler',
      'key',
      'modal',
      'name',
      'order_id',
    ]);
    // Everything that isn't a callback, serialized: no secret-shaped content.
    const serialized = JSON.stringify(options).toLowerCase();
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('firestore');
    expect(serialized).not.toContain('authorization');
  });

  it('wires the success handler and the dismiss callback', () => {
    const calls: string[] = [];
    const options = buildCheckoutOptions(
      { payment: preparedPayment, description: 'x' },
      { onSuccess: () => calls.push('success'), onDismiss: () => calls.push('dismiss') },
    );

    options.handler(checkoutSuccessResponse);
    options.modal?.ondismiss?.();

    expect(calls).toEqual(['success', 'dismiss']);
  });

  describe('customer prefill', () => {
    it('includes the customer-safe fields that exist', () => {
      const options = buildCheckoutOptions(
        {
          payment: preparedPayment,
          description: 'x',
          customer: { name: 'Asha', email: 'asha@example.com', contact: '+911234567890' },
        },
        noopHandlers,
      );

      expect(options.prefill).toEqual({ name: 'Asha', email: 'asha@example.com', contact: '+911234567890' });
    });

    it('includes only the fields that are present and non-blank', () => {
      const options = buildCheckoutOptions(
        { payment: preparedPayment, description: 'x', customer: { name: '   ', email: undefined, contact: ' +911234567890 ' } },
        noopHandlers,
      );

      expect(options.prefill).toEqual({ contact: '+911234567890' });
    });

    it('omits prefill entirely when there is no profile data — payment never depends on it', () => {
      expect(buildCheckoutOptions({ payment: preparedPayment, description: 'x' }, noopHandlers)).not.toHaveProperty('prefill');
      expect(
        buildCheckoutOptions({ payment: preparedPayment, description: 'x', customer: {} }, noopHandlers),
      ).not.toHaveProperty('prefill');
    });
  });
});

describe('checkoutDescription', () => {
  it('summarizes the order by item quantity, without exposing any internal ID', () => {
    const description = checkoutDescription(pendingOrder);

    expect(description).toBe('Pre-order · 3 items');
    expect(description).not.toContain(pendingOrder.id);
    expect(description).not.toContain(pendingOrder.outletId);
  });

  it('uses the singular for a single item', () => {
    expect(checkoutDescription({ items: [pendingOrder.items[1]] })).toBe('Pre-order · 1 item');
  });
});

describe('openCheckout', () => {
  beforeEach(() => {
    FakeRazorpay.reset();
  });

  it('constructs Checkout with the backend options and opens it exactly once', () => {
    openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    expect(FakeRazorpay.instances).toHaveLength(1);
    expect(FakeRazorpay.last.options).toMatchObject({
      key: 'rzp_test_FakePublicKeyId',
      amount: 30000,
      currency: 'INR',
      order_id: 'order_FakeProviderOrder1',
    });
    expect(FakeRazorpay.last.open).toHaveBeenCalledTimes(1);
  });

  it("reports success with the three callback values, renamed to Zesto's verification field names", async () => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    FakeRazorpay.last.succeed();

    await expect(handle.result).resolves.toEqual({
      kind: 'success',
      callback: {
        razorpayPaymentId: 'pay_FakePaymentId1',
        razorpayOrderId: 'order_FakeProviderOrder1',
        razorpaySignature: 'fake_signature_value',
      },
    });
  });

  it.each([
    ['payment id', { razorpay_payment_id: '' }],
    ['order id', { razorpay_order_id: '' }],
    ['signature', { razorpay_signature: '' }],
  ])('reports an invalid response when Checkout claims success without a %s', async (_label, override) => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    FakeRazorpay.last.succeed({ ...checkoutSuccessResponse, ...override });

    await expect(handle.result).resolves.toEqual({ kind: 'invalid_response' });
  });

  it('reports dismissed, with no failure, when the customer simply closes Checkout', async () => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    FakeRazorpay.last.dismiss();

    await expect(handle.result).resolves.toEqual({ kind: 'dismissed', paymentFailed: false, failureDescription: undefined });
  });

  it('remembers a Checkout-reported failure and reports it only once Checkout is closed unpaid', async () => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });

    FakeRazorpay.last.fail('Your payment was declined by the bank.');
    await Promise.resolve();
    expect(settled).toBe(false);

    FakeRazorpay.last.dismiss();

    await expect(handle.result).resolves.toEqual({
      kind: 'dismissed',
      paymentFailed: true,
      failureDescription: 'Your payment was declined by the bank.',
    });
  });

  it('truncates an overlong failure description', async () => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    FakeRazorpay.last.fail('x'.repeat(500));
    FakeRazorpay.last.dismiss();

    const result = await handle.result;
    expect(result.kind === 'dismissed' && result.failureDescription).toHaveLength(200);
  });

  it('still succeeds when the customer retries inside Checkout after a reported failure', async () => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    FakeRazorpay.last.fail('Declined.');
    FakeRazorpay.last.succeed();

    await expect(handle.result).resolves.toMatchObject({ kind: 'success' });
  });

  it('settles only once: a dismiss after success cannot undo it', async () => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    FakeRazorpay.last.succeed();
    FakeRazorpay.last.dismiss();

    await expect(handle.result).resolves.toMatchObject({ kind: 'success' });
  });

  it('close() closes Checkout and settles the session as dismissed', async () => {
    const handle = openCheckout(FakeRazorpay, { payment: preparedPayment, description: 'x' });

    handle.close();

    expect(FakeRazorpay.last.close).toHaveBeenCalledTimes(1);
    await expect(handle.result).resolves.toMatchObject({ kind: 'dismissed' });
  });
});

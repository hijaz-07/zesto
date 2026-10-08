import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../lib/api/client';
import { cancelOrder, createOrder, getOrder, getPickupCredential, listOrders } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: apiFetchMock,
}));

const order = {
  id: 'order-1',
  organizationId: 'org-1',
  outletId: 'outlet-1',
  menuId: 'menu-1',
  status: 'pending_payment' as const,
  paymentStatus: 'pending' as const,
  currency: 'INR' as const,
  subtotalInPaise: 24000,
  totalInPaise: 24000,
  items: [
    { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000 },
  ],
  createdAt: '2026-09-29T10:00:00+05:30',
  updatedAt: '2026-09-29T10:00:00+05:30',
};

describe('order api', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('createOrder POSTs /orders with only outletId, menuId, items, and idempotencyKey', async () => {
    apiFetchMock.mockResolvedValue({ order });

    await createOrder({
      outletId: 'outlet-1',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', quantity: 2 }],
      idempotencyKey: 'idem-key-1',
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/orders');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      outletId: 'outlet-1',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', quantity: 2 }],
      idempotencyKey: 'idem-key-1',
    });
    // Exact key set, not just toMatchObject's "at least these fields" — proves
    // nothing extra (price, userId, organizationId, status, ...) rides along.
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'items', 'menuId', 'outletId']);
  });

  it("CreateOrderInput's type has no field for userId/organizationId/price/subtotal/total/status/paymentStatus/currency", () => {
    // A compile-time check, not a runtime one: `createOrder` itself does no
    // stripping (like `../organization/api.ts`'s `createOrganization`, it
    // just serializes whatever it's given) — what actually keeps these
    // fields out of a real request is that no legitimate call site in this
    // codebase can construct an object with them without a type error. The
    // backend (functions/src/domain/orders.ts) is the real security
    // boundary regardless; see `cartToOrderRequest.test.ts` for proof the
    // one real call site never includes them.
    const _neverCompiles: Parameters<typeof createOrder>[0] = {
      outletId: 'outlet-1',
      menuId: 'menu-1',
      items: [],
      idempotencyKey: 'k',
      // @ts-expect-error -- organizationId is not a field of CreateOrderInput.
      organizationId: 'org-attacker',
    };
    void _neverCompiles;
  });

  it('resolves with the exact response returned by apiFetch (pass-through, no transformation)', async () => {
    apiFetchMock.mockResolvedValue({ order });

    const result = await createOrder({
      outletId: 'outlet-1',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', quantity: 2 }],
      idempotencyKey: 'idem-key-1',
    });

    expect(result).toEqual({ order });
  });

  it('propagates a rejection from apiFetch as-is', async () => {
    const error = new Error('boom');
    apiFetchMock.mockRejectedValue(error);

    await expect(
      createOrder({ outletId: 'outlet-1', menuId: 'menu-1', items: [], idempotencyKey: 'k' }),
    ).rejects.toBe(error);
  });

  it('getOrder GETs /orders/{orderId} with no body', async () => {
    apiFetchMock.mockResolvedValue({ order });

    await getOrder('order-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/orders/order-1');
  });

  it('getOrder resolves with the exact response returned by apiFetch', async () => {
    apiFetchMock.mockResolvedValue({ order });

    const result = await getOrder('order-1');

    expect(result).toEqual({ order });
  });

  it('getOrder propagates a rejection from apiFetch as-is', async () => {
    const error = new Error('boom');
    apiFetchMock.mockRejectedValue(error);

    await expect(getOrder('order-1')).rejects.toBe(error);
  });
});

describe('listOrders', () => {
  const page = { orders: [], nextCursor: null };

  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('GETs /orders with no query string and no body when given no params', async () => {
    apiFetchMock.mockResolvedValue(page);

    await listOrders();

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders');
  });

  it('sends only the page-size hint and cursor it is given, as query parameters', async () => {
    apiFetchMock.mockResolvedValue(page);

    await listOrders({ limit: 20, cursor: 'abc_DEF-123' });

    expect(apiFetchMock).toHaveBeenCalledWith('/orders?limit=20&cursor=abc_DEF-123');
  });

  it('omits an absent cursor', async () => {
    apiFetchMock.mockResolvedValue(page);

    await listOrders({ limit: 20 });

    expect(apiFetchMock).toHaveBeenCalledWith('/orders?limit=20');
  });

  it('never sends a user identifier: ListOrdersParams has no such field', async () => {
    apiFetchMock.mockResolvedValue(page);

    await listOrders({
      limit: 5,
      // @ts-expect-error -- userId is not a field of ListOrdersParams; ownership is decided by the server.
      userId: 'U-attacker',
    });

    // Only `limit` is ever read, so even a smuggled-in field cannot reach the URL.
    expect(apiFetchMock).toHaveBeenCalledWith('/orders?limit=5');
  });

  it('percent-encodes a cursor rather than splicing it into the URL', async () => {
    apiFetchMock.mockResolvedValue(page);

    await listOrders({ cursor: 'a&b=c' });

    expect(apiFetchMock).toHaveBeenCalledWith('/orders?cursor=a%26b%3Dc');
  });

  it('resolves with the exact page returned by apiFetch', async () => {
    const withOrders = { orders: [], nextCursor: 'next-cursor' };
    apiFetchMock.mockResolvedValue(withOrders);

    await expect(listOrders()).resolves.toBe(withOrders);
  });

  it('propagates a rejection from apiFetch as-is', async () => {
    const error = new Error('boom');
    apiFetchMock.mockRejectedValue(error);

    await expect(listOrders()).rejects.toBe(error);
  });
});

describe('getPickupCredential', () => {
  const credential = { qrPayload: 'ZP1.order1.AAAAAAAAAAAAAAAAAAAAAA', code: 'K7QX-4M2P' };

  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('GETs the credential of exactly the named order, with no body and no options', async () => {
    apiFetchMock.mockResolvedValue({ pickup: credential });

    await getPickupCredential('order-1');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders/order-1/pickup-credential');
  });

  it('percent-encodes the order id rather than splicing it into the path', async () => {
    apiFetchMock.mockResolvedValue({ pickup: credential });

    await getPickupCredential('a/b?c=d');

    expect(apiFetchMock).toHaveBeenCalledWith('/orders/a%2Fb%3Fc%3Dd/pickup-credential');
  });

  it('resolves with the QR payload and the backup code', async () => {
    apiFetchMock.mockResolvedValue({ pickup: credential });

    await expect(getPickupCredential('order-1')).resolves.toEqual(credential);
  });

  it('returns exactly those two fields: anything else a server sends is dropped, never carried along', async () => {
    apiFetchMock.mockResolvedValue({
      pickup: { ...credential, userId: 'U-secret', provider: 'razorpay', readyBy: 'U-staff' },
      order: { id: 'order-1' },
    });

    const result = await getPickupCredential('order-1');

    expect(Object.keys(result).sort()).toEqual(['code', 'qrPayload']);
    expect(JSON.stringify(result)).not.toContain('U-secret');
  });

  it('keeps no copy: every call asks the backend again', async () => {
    apiFetchMock.mockResolvedValue({ pickup: credential });

    await getPickupCredential('order-1');
    await getPickupCredential('order-1');

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no body', undefined],
    ['no pickup', {}],
    ['a null pickup', { pickup: null }],
    ['a missing code', { pickup: { qrPayload: credential.qrPayload } }],
    ['a missing payload', { pickup: { code: credential.code } }],
    ['an empty payload', { pickup: { ...credential, qrPayload: '' } }],
    ['an empty code', { pickup: { ...credential, code: '' } }],
    ['a non-string code', { pickup: { ...credential, code: 12345678 } }],
    ['a non-string payload', { pickup: { ...credential, qrPayload: ['ZP1.x.y'] } }],
    ['an over-long payload', { pickup: { ...credential, qrPayload: 'Z'.repeat(201) } }],
  ])('rejects a response with %s as an invalid response, never showing a half-credential', async (_label, body) => {
    apiFetchMock.mockResolvedValue(body);

    await expect(getPickupCredential('order-1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('propagates the backend refusal as-is (404 for an order that is not theirs, 409 when not ready)', async () => {
    const refusal = new ApiError(404, 'not_found', 'Order not found.');
    apiFetchMock.mockRejectedValue(refusal);

    await expect(getPickupCredential('order-1')).rejects.toBe(refusal);
  });
});

describe('getOrder — the cancellation hint and refund summary', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  const refund = {
    status: 'pending',
    amountInPaise: 24000,
    currency: 'INR',
    initiatedAt: '2026-09-29T10:00:00.000Z',
  };

  it("folds the server's cancellation hint into the order", async () => {
    apiFetchMock.mockResolvedValue({ order, cancellation: { state: 'cancellable', canCancel: true } });

    const result = await getOrder('order-1');

    expect(result.order).toEqual({ ...order, cancellation: { state: 'cancellable', canCancel: true } });
  });

  it('folds in a refund summary, keeping exactly the approved fields', async () => {
    apiFetchMock.mockResolvedValue({
      order,
      cancellation: { state: 'cancelled', canCancel: false },
      refund: { ...refund, completedAt: '2026-09-30T10:00:00.000Z', providerRefundId: 'rfnd_secret', refundId: 'order-1-r1' },
    });

    const result = await getOrder('order-1');

    expect(result.order.refund).toEqual({ ...refund, completedAt: '2026-09-30T10:00:00.000Z' });
    expect(JSON.stringify(result)).not.toContain('rfnd_secret');
    expect(JSON.stringify(result)).not.toContain('order-1-r1');
  });

  it('still reads an order from a backend that sends neither block (no hint, no refund)', async () => {
    apiFetchMock.mockResolvedValue({ order });

    const result = await getOrder('order-1');

    expect(result.order).toEqual(order);
    expect(result.order).not.toHaveProperty('cancellation');
    expect(result.order).not.toHaveProperty('refund');
  });

  it.each([
    ['an unknown state', { state: 'maybe', canCancel: true }],
    ['a non-boolean canCancel', { state: 'cancellable', canCancel: 'yes' }],
    ['a hint that contradicts itself (cancellable but canCancel false)', { state: 'cancellable', canCancel: false }],
    ['a hint that contradicts itself (not cancellable but canCancel true)', { state: 'not_cancellable', canCancel: true }],
    ['null', null],
    ['a string', 'cancellable'],
  ])('ignores a malformed cancellation hint: %s', async (_name, cancellation) => {
    apiFetchMock.mockResolvedValue({ order, cancellation });

    const result = await getOrder('order-1');

    expect(result.order).not.toHaveProperty('cancellation');
  });

  it.each([
    ['an unknown status', { ...refund, status: 'reversed' }],
    ['a zero amount', { ...refund, amountInPaise: 0 }],
    ['a fractional amount', { ...refund, amountInPaise: 10.5 }],
    ['a string amount', { ...refund, amountInPaise: '24000' }],
    ['a different currency', { ...refund, currency: 'USD' }],
    ['a missing initiatedAt', { ...refund, initiatedAt: undefined }],
    ['a non-string completedAt', { ...refund, completedAt: 5 }],
    ['null', null],
    ['an array', []],
  ])('ignores a malformed refund summary: %s', async (_name, malformed) => {
    apiFetchMock.mockResolvedValue({ order, refund: malformed });

    const result = await getOrder('order-1');

    expect(result.order).not.toHaveProperty('refund');
  });

  it('fails clearly if the response has no order at all', async () => {
    apiFetchMock.mockResolvedValue({});

    await expect(getOrder('order-1')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('cancelOrder', () => {
  const cancelled = { ...order, status: 'cancelled' as const, updatedAt: '2026-09-29T10:05:00+05:30' };

  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('POSTs /orders/{id}/cancel with only the reason', async () => {
    apiFetchMock.mockResolvedValue({ order: cancelled, cancellation: { state: 'cancelled', canCancel: false } });

    await cancelOrder('order-1', 'changed_my_mind');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/orders/order-1/cancel');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ reason: 'changed_my_mind' });
    expect(Object.keys(body)).toEqual(['reason']);
  });

  it('sends an empty object when the customer gave no reason — never an amount, status, user or deadline', async () => {
    apiFetchMock.mockResolvedValue({ order: cancelled, cancellation: { state: 'cancelled', canCancel: false } });

    await cancelOrder('order-1');

    const [, init] = apiFetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('does not send a reason that is not one of the approved five', async () => {
    apiFetchMock.mockResolvedValue({ order: cancelled, cancellation: { state: 'cancelled', canCancel: false } });

    await cancelOrder('order-1', 'because I said so' as never);

    const [, init] = apiFetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('percent-encodes the order ID in the path', async () => {
    apiFetchMock.mockResolvedValue({
      order: { ...cancelled, id: 'a/b' },
      cancellation: { state: 'cancelled', canCancel: false },
    });

    await cancelOrder('a/b');

    expect(apiFetchMock.mock.calls[0][0]).toBe('/orders/a%2Fb/cancel');
  });

  it('returns the cancelled order with its refund summary folded in', async () => {
    apiFetchMock.mockResolvedValue({
      order: { ...cancelled, paymentStatus: 'paid' },
      cancellation: { state: 'cancelled', canCancel: false },
      refund: { status: 'requested', amountInPaise: 24000, currency: 'INR', initiatedAt: '2026-09-29T10:05:00.000Z' },
    });

    const result = await cancelOrder('order-1');

    expect(result.order).toMatchObject({
      status: 'cancelled',
      cancellation: { state: 'cancelled', canCancel: false },
      refund: { status: 'requested', amountInPaise: 24000 },
    });
  });

  it('knows the order is cancelled even if the response left out the hint', async () => {
    apiFetchMock.mockResolvedValue({ order: cancelled });

    const result = await cancelOrder('order-1');

    expect(result.order.cancellation).toEqual({ state: 'cancelled', canCancel: false });
    expect(result.order).not.toHaveProperty('refund');
  });

  it('rejects a 200 that is not a cancelled order, so the screen never shows one that was not cancelled', async () => {
    apiFetchMock.mockResolvedValue({ order: { ...order, status: 'confirmed' } });

    await expect(cancelOrder('order-1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects an answer about a different order', async () => {
    apiFetchMock.mockResolvedValue({ order: { ...cancelled, id: 'someone-elses' } });

    await expect(cancelOrder('order-1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it("passes the backend's refusal through unchanged", async () => {
    apiFetchMock.mockRejectedValue(new ApiError(409, 'conflict', 'This order is already being prepared.'));

    await expect(cancelOrder('order-1')).rejects.toMatchObject({ status: 409 });
  });
});

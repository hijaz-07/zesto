import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../lib/api/client';
import { createOrder, getOrder, getPickupCredential, listOrders } from './api';

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

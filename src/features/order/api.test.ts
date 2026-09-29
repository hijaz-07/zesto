import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api/client';
import { createOrder, getOrder } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', () => ({
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

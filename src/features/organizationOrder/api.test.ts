import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { confirmedOrgOrder, preparingOrgOrder } from '../../test/organizationOrderFixtures';
import { listOrganizationOrders, runFulfillmentAction } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: apiFetchMock,
}));

describe('listOrganizationOrders', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ orders: [], nextCursor: null });
  });

  it('GETs the organization-scoped orders path with no query string when nothing is requested', async () => {
    await listOrganizationOrders('org-1');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/organizations/org-1/orders');
  });

  it('sends only a page-size hint, the outlet filter and the cursor when they are given', async () => {
    await listOrganizationOrders('org-1', { outletId: 'outlet-2', limit: 20, cursor: 'abc_-123' });

    const [path] = apiFetchMock.mock.calls[0];
    const url = new URL(path as string, 'https://zesto.test');
    expect(url.pathname).toBe('/organizations/org-1/orders');
    expect([...url.searchParams.keys()].sort()).toEqual(['cursor', 'limit', 'outletId']);
    expect(url.searchParams.get('outletId')).toBe('outlet-2');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('cursor')).toBe('abc_-123');
  });

  it('omits an absent outlet filter and cursor rather than sending them blank', async () => {
    await listOrganizationOrders('org-1', { limit: 20 });

    expect(apiFetchMock).toHaveBeenCalledWith('/organizations/org-1/orders?limit=20');
  });

  it('never puts a user or organization identifier in the query string', async () => {
    await listOrganizationOrders('org-1', { outletId: 'outlet-1', limit: 20, cursor: 'c' });

    const [path] = apiFetchMock.mock.calls[0];
    const params = new URL(path as string, 'https://zesto.test').searchParams;
    expect(params.has('userId')).toBe(false);
    expect(params.has('organizationId')).toBe(false);
  });

  it('is a plain GET: no method override and no body', async () => {
    await listOrganizationOrders('org-1', { limit: 20 });

    expect(apiFetchMock.mock.calls[0]).toHaveLength(1);
  });

  it('resolves with the backend page unchanged', async () => {
    const page = { orders: [], nextCursor: 'next-cursor' };
    apiFetchMock.mockResolvedValue(page);

    await expect(listOrganizationOrders('org-1')).resolves.toBe(page);
  });
});

describe('runFulfillmentAction', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ order: preparingOrgOrder });
  });

  it.each([
    ['start-preparing', '/organizations/org-1/orders/order-preparing-5/start-preparing'],
    ['mark-ready', '/organizations/org-1/orders/order-preparing-5/mark-ready'],
  ] as const)('POSTs the explicit %s route, with no body, no headers and no query', async (action, path) => {
    await runFulfillmentAction('org-1', 'order-preparing-5', action);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(path, { method: 'POST' });
    const [, init] = apiFetchMock.mock.calls[0];
    expect(init).not.toHaveProperty('body');
    expect(init).not.toHaveProperty('headers');
  });

  it("encodes both ids so they can't alter the request path", async () => {
    apiFetchMock.mockResolvedValue({ order: { ...preparingOrgOrder, id: 'a/../b' } });

    await runFulfillmentAction('org/1', 'a/../b', 'mark-ready');

    expect(apiFetchMock.mock.calls[0][0]).toBe('/organizations/org%2F1/orders/a%2F..%2Fb/mark-ready');
  });

  it("resolves with the order's row exactly as the backend returned it", async () => {
    await expect(runFulfillmentAction('org-1', 'order-preparing-5', 'start-preparing')).resolves.toBe(preparingOrgOrder);
  });

  it('rejects a response that is not an order row, or is another order, rather than swapping it into the list', async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);
    await expect(runFulfillmentAction('org-1', 'order-preparing-5', 'start-preparing')).rejects.toMatchObject({
      code: 'invalid_response',
    });

    apiFetchMock.mockResolvedValueOnce({});
    await expect(runFulfillmentAction('org-1', 'order-preparing-5', 'start-preparing')).rejects.toMatchObject({
      code: 'invalid_response',
    });

    apiFetchMock.mockResolvedValueOnce({ order: confirmedOrgOrder });
    await expect(runFulfillmentAction('org-1', 'order-preparing-5', 'start-preparing')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it.each([
    new ApiError(403, 'permission_denied', 'No access.'),
    new ApiError(404, 'not_found', 'Order not found.'),
    new ApiError(409, 'conflict', 'This order is ready, so it can\'t be moved to preparing.'),
    new TypeError('Failed to fetch'),
  ])('propagates the failure %s as-is', async (error) => {
    apiFetchMock.mockRejectedValue(error);

    await expect(runFulfillmentAction('org-1', 'order-preparing-5', 'start-preparing')).rejects.toBe(error);
  });
});

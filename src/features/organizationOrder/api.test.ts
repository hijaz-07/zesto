import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listOrganizationOrders } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', () => ({
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

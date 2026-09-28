import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api/client';
import { archiveMenu, createMenu, getMenu, getMenus, publishMenu, updateMenu } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', () => ({
  apiFetch: apiFetchMock,
}));

describe('menu api', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('getMenus requests the outlet\'s menus with no body', async () => {
    apiFetchMock.mockResolvedValue({ menus: [] });

    await getMenus('org-1', 'outlet-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus');
  });

  it('getMenu requests a single menu by ID with no body', async () => {
    apiFetchMock.mockResolvedValue({ menu: {} });

    await getMenu('org-1', 'outlet-1', 'menu-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus/menu-1');
  });

  it('createMenu POSTs the exact input as a JSON body', async () => {
    apiFetchMock.mockResolvedValue({ menu: {} });
    const input = {
      menuDate: '2026-09-29',
      title: 'Tuesday Special Menu',
      description: 'Chef\'s picks',
      orderingOpensAt: '2026-09-28T04:00:00+05:30',
      orderingClosesAt: '2026-09-29T10:00:00+05:30',
      pickupStartsAt: '2026-09-29T12:00:00+05:30',
      pickupEndsAt: '2026-09-29T14:00:00+05:30',
    };

    await createMenu('org-1', 'outlet-1', input);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  });

  it('createMenu sends only the fields provided, no extra keys', async () => {
    apiFetchMock.mockResolvedValue({ menu: {} });
    const input = {
      menuDate: '2026-09-29',
      title: 'Tuesday Special Menu',
      orderingOpensAt: '2026-09-28T04:00:00+05:30',
      orderingClosesAt: '2026-09-29T10:00:00+05:30',
      pickupStartsAt: '2026-09-29T12:00:00+05:30',
      pickupEndsAt: '2026-09-29T14:00:00+05:30',
    };

    await createMenu('org-1', 'outlet-1', input);

    const [, init] = apiFetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(input);
  });

  it('updateMenu PATCHes the target menu with the exact input as a JSON body', async () => {
    apiFetchMock.mockResolvedValue({ menu: {} });
    const input = { title: 'Updated title' };

    await updateMenu('org-1', 'outlet-1', 'menu-1', input);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus/menu-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  });

  it('publishMenu POSTs with no body', async () => {
    apiFetchMock.mockResolvedValue({ menu: {} });

    await publishMenu('org-1', 'outlet-1', 'menu-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus/menu-1/publish', {
      method: 'POST',
    });
  });

  it('archiveMenu POSTs with no body', async () => {
    apiFetchMock.mockResolvedValue({ menu: {} });

    await archiveMenu('org-1', 'outlet-1', 'menu-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus/menu-1/archive', {
      method: 'POST',
    });
  });

  it('resolves with the response returned by apiFetch', async () => {
    const menu = { id: 'menu-1', organizationId: 'org-1', outletId: 'outlet-1', title: 'Menu' };
    apiFetchMock.mockResolvedValue({ menu });

    const result = await getMenu('org-1', 'outlet-1', 'menu-1');

    expect(result).toEqual({ menu });
  });

  it('propagates a rejection from apiFetch as-is', async () => {
    const error = new Error('boom');
    apiFetchMock.mockRejectedValue(error);

    await expect(getMenus('org-1', 'outlet-1')).rejects.toBe(error);
  });
});

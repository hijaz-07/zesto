import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api/client';
import { createMenuItem, deleteMenuItem, getMenuItem, getMenuItems, updateMenuItem } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', () => ({
  apiFetch: apiFetchMock,
}));

describe('menu item api', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('getMenuItems requests the menu\'s items with no body', async () => {
    apiFetchMock.mockResolvedValue({ items: [] });

    await getMenuItems('org-1', 'outlet-1', 'menu-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus/menu-1/items');
  });

  it('getMenuItem requests a single item by ID with no body', async () => {
    apiFetchMock.mockResolvedValue({ item: {} });

    await getMenuItem('org-1', 'outlet-1', 'menu-1', 'item-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/organizations/org-1/outlets/outlet-1/menus/menu-1/items/item-1',
    );
  });

  it('createMenuItem POSTs the exact input as a JSON body', async () => {
    apiFetchMock.mockResolvedValue({ item: {} });
    const input = {
      name: 'Chicken Biriyani',
      description: 'Aromatic chicken biriyani',
      priceInPaise: 12000,
      displayOrder: 0,
    };

    await createMenuItem('org-1', 'outlet-1', 'menu-1', input);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1/menus/menu-1/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  });

  it('createMenuItem sends only the fields provided, no extra keys', async () => {
    apiFetchMock.mockResolvedValue({ item: {} });
    const input = { name: 'Chicken Biriyani', priceInPaise: 12000, displayOrder: 0 };

    await createMenuItem('org-1', 'outlet-1', 'menu-1', input);

    const [, init] = apiFetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(input);
  });

  it('updateMenuItem PATCHes the target item with the exact input as a JSON body', async () => {
    apiFetchMock.mockResolvedValue({ item: {} });
    const input = { enabled: false };

    await updateMenuItem('org-1', 'outlet-1', 'menu-1', 'item-1', input);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/organizations/org-1/outlets/outlet-1/menus/menu-1/items/item-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  });

  it('deleteMenuItem DELETEs the target item with no body', async () => {
    apiFetchMock.mockResolvedValue({});

    await deleteMenuItem('org-1', 'outlet-1', 'menu-1', 'item-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/organizations/org-1/outlets/outlet-1/menus/menu-1/items/item-1',
      { method: 'DELETE' },
    );
  });

  it('resolves with the response returned by apiFetch', async () => {
    const item = { id: 'item-1', menuId: 'menu-1', name: 'Chicken Biriyani' };
    apiFetchMock.mockResolvedValue({ item });

    const result = await getMenuItem('org-1', 'outlet-1', 'menu-1', 'item-1');

    expect(result).toEqual({ item });
  });

  it('propagates a rejection from apiFetch as-is', async () => {
    const error = new Error('boom');
    apiFetchMock.mockRejectedValue(error);

    await expect(getMenuItems('org-1', 'outlet-1', 'menu-1')).rejects.toBe(error);
  });
});

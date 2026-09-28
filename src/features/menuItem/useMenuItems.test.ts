import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useMenuItems } from './useMenuItems';

const getMenuItemsMock = vi.hoisted(() => vi.fn());
const createMenuItemMock = vi.hoisted(() => vi.fn());
const updateMenuItemMock = vi.hoisted(() => vi.fn());
const deleteMenuItemMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getMenuItems: getMenuItemsMock,
  createMenuItem: createMenuItemMock,
  updateMenuItem: updateMenuItemMock,
  deleteMenuItem: deleteMenuItemMock,
}));

const item = {
  id: 'item-1',
  menuId: 'menu-1',
  name: 'Chicken Biriyani',
  priceInPaise: 12000,
  enabled: true,
  displayOrder: 0,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: 'U-1',
};

describe('useMenuItems', () => {
  beforeEach(() => {
    getMenuItemsMock.mockReset();
    createMenuItemMock.mockReset();
    updateMenuItemMock.mockReset();
    deleteMenuItemMock.mockReset();
  });

  it('starts loading, then becomes ready with the fetched items', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [item] });

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));
    expect(result.current.status).toBe('loading');
    expect(result.current.items).toEqual([]);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toEqual([item]);
    expect(getMenuItemsMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1');
  });

  it('moves to an error state when the fetch fails, and retry() re-fetches', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getMenuItemsMock.mockRejectedValueOnce(error);
    getMenuItemsMock.mockResolvedValueOnce({ items: [] });

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toEqual([]);
    expect(getMenuItemsMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when any of organizationId/outletId/menuId changes', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [item] });

    const { result, rerender } = renderHook(
      ({ organizationId, outletId, menuId }) => useMenuItems(organizationId, outletId, menuId),
      { initialProps: { organizationId: 'org-1', outletId: 'outlet-1', menuId: 'menu-1' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ organizationId: 'org-1', outletId: 'outlet-1', menuId: 'menu-2' });

    await waitFor(() => expect(getMenuItemsMock).toHaveBeenCalledTimes(2));
    expect(getMenuItemsMock).toHaveBeenNthCalledWith(2, 'org-1', 'outlet-1', 'menu-2');
  });

  it('appends the created item from the POST response without refetching', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [] });
    createMenuItemMock.mockResolvedValue({ item });

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const input = { name: 'Chicken Biriyani', priceInPaise: 12000, displayOrder: 0 };
    await act(async () => {
      await result.current.createMenuItem(input);
    });

    expect(result.current.items).toEqual([item]);
    expect(createMenuItemMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1', input);
    expect(getMenuItemsMock).toHaveBeenCalledTimes(1);
  });

  it('rejects and leaves the list unchanged when create fails', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [item] });
    const error = new ApiError(
      400,
      'invalid_argument',
      "Ordering has closed; this menu's items can no longer be changed.",
    );
    createMenuItemMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.createMenuItem({ name: 'New item', priceInPaise: 5000, displayOrder: 1 });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.items).toEqual([item]);
  });

  it('replaces the updated item in place from the PATCH response', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [item] });
    const updated = { ...item, enabled: false };
    updateMenuItemMock.mockResolvedValue({ item: updated });

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.updateMenuItem('item-1', { enabled: false });
    });

    expect(result.current.items).toEqual([updated]);
    expect(updateMenuItemMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1', 'item-1', {
      enabled: false,
    });
  });

  it('rejects and leaves the list unchanged when update targets a missing item', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [item] });
    const error = new ApiError(404, 'not_found', 'Menu item not found.');
    updateMenuItemMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.updateMenuItem('missing-item', { enabled: false });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.items).toEqual([item]);
  });

  it('removes the deleted item from the list without refetching', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [item] });
    deleteMenuItemMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.deleteMenuItem('item-1');
    });

    expect(result.current.items).toEqual([]);
    expect(deleteMenuItemMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1', 'item-1');
    expect(getMenuItemsMock).toHaveBeenCalledTimes(1);
  });

  it('rejects and leaves the list unchanged when delete is rejected on a published menu', async () => {
    getMenuItemsMock.mockResolvedValue({ items: [item] });
    const error = new ApiError(
      400,
      'invalid_argument',
      'Only items on a draft menu can be deleted; disable the item instead.',
    );
    deleteMenuItemMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenuItems('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.deleteMenuItem('item-1');
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.items).toEqual([item]);
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useExploreMenu } from './useExploreMenu';

const getExploreMenuMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getExploreMenu: getExploreMenuMock,
}));

const outlet = { id: 'outlet-1', name: 'Main Canteen' };
const menu = {
  id: 'menu-1',
  menuDate: '2026-09-29',
  title: 'Tuesday Special Menu',
  orderingOpensAt: '2026-09-28T04:00:00+05:30',
  orderingClosesAt: '2026-09-28T10:00:00+05:30',
  pickupStartsAt: '2026-09-29T12:00:00+05:30',
  pickupEndsAt: '2026-09-29T14:00:00+05:30',
  orderingState: 'open' as const,
  items: [
    { id: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, displayOrder: 1 },
  ],
};

describe('useExploreMenu', () => {
  beforeEach(() => {
    getExploreMenuMock.mockReset();
  });

  it('never calls the API when outletId is missing, and reports idle', () => {
    const { result } = renderHook(() => useExploreMenu(undefined, 'menu-1'));

    expect(result.current.status).toBe('idle');
    expect(getExploreMenuMock).not.toHaveBeenCalled();
  });

  it('never calls the API when menuId is missing, and reports idle', () => {
    const { result } = renderHook(() => useExploreMenu('outlet-1', undefined));

    expect(result.current.status).toBe('idle');
    expect(getExploreMenuMock).not.toHaveBeenCalled();
  });

  it('never calls the API when both IDs are missing', () => {
    const { result } = renderHook(() => useExploreMenu(undefined, undefined));

    expect(result.current.status).toBe('idle');
    expect(getExploreMenuMock).not.toHaveBeenCalled();
  });

  it('starts loading once both IDs are present', async () => {
    getExploreMenuMock.mockResolvedValue({ outlet, menu });

    const { result } = renderHook(() => useExploreMenu('outlet-1', 'menu-1'));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('becomes ready with the fetched outlet and menu', async () => {
    getExploreMenuMock.mockResolvedValue({ outlet, menu });

    const { result } = renderHook(() => useExploreMenu('outlet-1', 'menu-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlet).toEqual(outlet);
    expect(result.current.menu).toEqual(menu);
    expect(getExploreMenuMock).toHaveBeenCalledWith('outlet-1', 'menu-1');
  });

  it('moves to an error state on a 404 not_found', async () => {
    const error = new ApiError(404, 'not_found', 'Menu not found.');
    getExploreMenuMock.mockRejectedValue(error);

    const { result } = renderHook(() => useExploreMenu('outlet-1', 'no-such-menu'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);
    expect(result.current.menu).toBeNull();
  });

  it('retry() re-fetches after an error', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getExploreMenuMock.mockRejectedValueOnce(error);
    getExploreMenuMock.mockResolvedValueOnce({ outlet, menu });

    const { result } = renderHook(() => useExploreMenu('outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menu).toEqual(menu);
    expect(getExploreMenuMock).toHaveBeenCalledTimes(2);
  });

  it('loads new data when either ID changes', async () => {
    const otherMenu = { ...menu, id: 'menu-2', title: 'Wednesday Special' };
    getExploreMenuMock.mockImplementation((_outletId: string, menuId: string) =>
      Promise.resolve({ outlet, menu: menuId === 'menu-1' ? menu : otherMenu }),
    );

    const { result, rerender } = renderHook(
      ({ outletId, menuId }: { outletId: string | undefined; menuId: string | undefined }) =>
        useExploreMenu(outletId, menuId),
      { initialProps: { outletId: 'outlet-1', menuId: 'menu-1' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menu).toEqual(menu);

    rerender({ outletId: 'outlet-1', menuId: 'menu-2' });

    await waitFor(() => expect(getExploreMenuMock).toHaveBeenCalledTimes(2));
    expect(getExploreMenuMock).toHaveBeenNthCalledWith(2, 'outlet-1', 'menu-2');
    await waitFor(() => expect(result.current.menu).toEqual(otherMenu));
  });

  it.each(['not_open', 'open', 'closed'] as const)(
    'preserves the backend orderingState "%s" exactly, without recomputing it',
    async (orderingState) => {
      getExploreMenuMock.mockResolvedValue({ outlet, menu: { ...menu, orderingState } });

      const { result } = renderHook(() => useExploreMenu('outlet-1', 'menu-1'));

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.menu?.orderingState).toBe(orderingState);
    },
  );

  it('preserves priceInPaise exactly, as a number, never converted to a rupee float', async () => {
    const withOddPrice = {
      ...menu,
      items: [{ id: 'item-1', name: 'Egg Curry', priceInPaise: 9950, displayOrder: 1 }],
    };
    getExploreMenuMock.mockResolvedValue({ outlet, menu: withOddPrice });

    const { result } = renderHook(() => useExploreMenu('outlet-1', 'menu-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menu?.items[0].priceInPaise).toBe(9950);
    expect(Number.isInteger(result.current.menu?.items[0].priceInPaise)).toBe(true);
  });

  it('preserves menuDate exactly as the backend\'s calendar-date string, not reparsed into a Date', async () => {
    getExploreMenuMock.mockResolvedValue({ outlet, menu: { ...menu, menuDate: '2026-01-05' } });

    const { result } = renderHook(() => useExploreMenu('outlet-1', 'menu-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menu?.menuDate).toBe('2026-01-05');
    expect(typeof result.current.menu?.menuDate).toBe('string');
  });

  it('goes back to idle if either ID is cleared after having loaded', async () => {
    getExploreMenuMock.mockResolvedValue({ outlet, menu });

    const { result, rerender } = renderHook(
      ({ outletId, menuId }: { outletId: string | undefined; menuId: string | undefined }) =>
        useExploreMenu(outletId, menuId),
      { initialProps: { outletId: 'outlet-1', menuId: 'menu-1' as string | undefined } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ outletId: 'outlet-1', menuId: undefined });

    expect(result.current.status).toBe('idle');
    expect(result.current.menu).toBeNull();
  });
});

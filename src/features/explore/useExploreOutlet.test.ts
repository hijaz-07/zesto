import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useExploreOutlet } from './useExploreOutlet';

const getExploreOutletMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getExploreOutlet: getExploreOutletMock,
}));

const outlet = { id: 'outlet-1', name: 'Main Canteen' };
const menus = [
  {
    id: 'menu-1',
    menuDate: '2026-09-29',
    title: 'Tuesday Special Menu',
    orderingOpensAt: '2026-09-28T04:00:00+05:30',
    orderingClosesAt: '2026-09-28T10:00:00+05:30',
    pickupStartsAt: '2026-09-29T12:00:00+05:30',
    pickupEndsAt: '2026-09-29T14:00:00+05:30',
    orderingState: 'not_open' as const,
  },
];

describe('useExploreOutlet', () => {
  beforeEach(() => {
    getExploreOutletMock.mockReset();
  });

  it('never calls the API when outletId is undefined, and reports idle', () => {
    const { result } = renderHook(() => useExploreOutlet(undefined));

    expect(result.current.status).toBe('idle');
    expect(result.current.outlet).toBeNull();
    expect(getExploreOutletMock).not.toHaveBeenCalled();
  });

  it('never calls the API when outletId is an empty string, and reports idle', () => {
    const { result } = renderHook(() => useExploreOutlet(''));

    expect(result.current.status).toBe('idle');
    expect(getExploreOutletMock).not.toHaveBeenCalled();
  });

  it('starts loading once outletId is present', async () => {
    getExploreOutletMock.mockResolvedValue({ outlet, menus });

    const { result } = renderHook(() => useExploreOutlet('outlet-1'));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('becomes ready with the fetched outlet and its menus', async () => {
    getExploreOutletMock.mockResolvedValue({ outlet, menus });

    const { result } = renderHook(() => useExploreOutlet('outlet-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlet).toEqual(outlet);
    expect(result.current.menus).toEqual(menus);
    expect(getExploreOutletMock).toHaveBeenCalledWith('outlet-1');
  });

  it('moves to an error state on a 404 not_found, distinguishable from other statuses', async () => {
    const error = new ApiError(404, 'not_found', 'Outlet not found.');
    getExploreOutletMock.mockRejectedValue(error);

    const { result } = renderHook(() => useExploreOutlet('no-such-outlet'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);
    expect(result.current.outlet).toBeNull();
  });

  it('retry() re-fetches after an error', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getExploreOutletMock.mockRejectedValueOnce(error);
    getExploreOutletMock.mockResolvedValueOnce({ outlet, menus });

    const { result } = renderHook(() => useExploreOutlet('outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlet).toEqual(outlet);
    expect(getExploreOutletMock).toHaveBeenCalledTimes(2);
  });

  it('loads the new outlet when outletId changes', async () => {
    const otherOutlet = { id: 'outlet-2', name: 'Second Canteen' };
    getExploreOutletMock.mockImplementation((outletId: string) =>
      Promise.resolve(
        outletId === 'outlet-1' ? { outlet, menus } : { outlet: otherOutlet, menus: [] },
      ),
    );

    const { result, rerender } = renderHook(({ outletId }) => useExploreOutlet(outletId), {
      initialProps: { outletId: 'outlet-1' as string | undefined },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlet).toEqual(outlet);

    rerender({ outletId: 'outlet-2' });

    await waitFor(() => expect(getExploreOutletMock).toHaveBeenCalledTimes(2));
    expect(getExploreOutletMock).toHaveBeenNthCalledWith(2, 'outlet-2');
    await waitFor(() => expect(result.current.outlet).toEqual(otherOutlet));
  });

  it('goes back to idle if outletId is cleared after having loaded', async () => {
    getExploreOutletMock.mockResolvedValue({ outlet, menus });

    const { result, rerender } = renderHook(({ outletId }) => useExploreOutlet(outletId), {
      initialProps: { outletId: 'outlet-1' as string | undefined },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ outletId: undefined });

    expect(result.current.status).toBe('idle');
    expect(result.current.outlet).toBeNull();
  });
});

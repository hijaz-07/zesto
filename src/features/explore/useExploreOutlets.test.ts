import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useExploreOutlets } from './useExploreOutlets';

const getExploreOutletsMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getExploreOutlets: getExploreOutletsMock,
}));

const outletSummary = {
  id: 'outlet-1',
  name: 'Main Canteen',
  nextMenu: {
    id: 'menu-1',
    menuDate: '2026-09-29',
    title: 'Tuesday Special Menu',
    orderingOpensAt: '2026-09-28T04:00:00+05:30',
    orderingClosesAt: '2026-09-28T10:00:00+05:30',
    pickupStartsAt: '2026-09-29T12:00:00+05:30',
    pickupEndsAt: '2026-09-29T14:00:00+05:30',
    orderingState: 'not_open' as const,
  },
};

describe('useExploreOutlets', () => {
  beforeEach(() => {
    getExploreOutletsMock.mockReset();
  });

  it('starts loading on mount, with no arguments required', async () => {
    getExploreOutletsMock.mockResolvedValue({ outlets: [outletSummary] });

    const { result } = renderHook(() => useExploreOutlets());

    expect(result.current.status).toBe('loading');
    expect(result.current.outlets).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('becomes ready with the fetched outlets', async () => {
    getExploreOutletsMock.mockResolvedValue({ outlets: [outletSummary] });

    const { result } = renderHook(() => useExploreOutlets());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlets).toEqual([outletSummary]);
    expect(result.current.error).toBeNull();
    expect(getExploreOutletsMock).toHaveBeenCalledWith();
  });

  it('becomes ready with an empty list when nothing qualifies', async () => {
    getExploreOutletsMock.mockResolvedValue({ outlets: [] });

    const { result } = renderHook(() => useExploreOutlets());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlets).toEqual([]);
  });

  it('moves to an error state when the fetch fails, and retry() re-fetches', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getExploreOutletsMock.mockRejectedValueOnce(error);
    getExploreOutletsMock.mockResolvedValueOnce({ outlets: [outletSummary] });

    const { result } = renderHook(() => useExploreOutlets());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);
    expect(result.current.outlets).toEqual([]);

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlets).toEqual([outletSummary]);
    expect(getExploreOutletsMock).toHaveBeenCalledTimes(2);
  });

  it('a failed load leaves the outlets list empty, not stale/partial data', async () => {
    getExploreOutletsMock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useExploreOutlets());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.outlets).toEqual([]);
  });
});

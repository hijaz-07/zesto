import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { confirmedSummary, manySummaries, pendingSummary } from '../../test/orderHistoryFixtures';
import type { OrderHistoryPage } from './types';
import { useOrderHistory } from './useOrderHistory';

const listOrdersMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  listOrders: listOrdersMock,
}));

function page(orders: OrderHistoryPage['orders'], nextCursor: string | null = null): OrderHistoryPage {
  return { orders, nextCursor };
}

/** A promise the test settles by hand, to control response ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useOrderHistory', () => {
  beforeEach(() => {
    listOrdersMock.mockReset();
  });

  it('starts loading and requests the first page, with no cursor', async () => {
    listOrdersMock.mockResolvedValue(page([confirmedSummary]));

    const { result } = renderHook(() => useOrderHistory());

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(listOrdersMock).toHaveBeenCalledTimes(1);
    expect(listOrdersMock.mock.calls[0][0]).not.toHaveProperty('cursor');
  });

  it('becomes ready with the orders in the order the backend returned them', async () => {
    listOrdersMock.mockResolvedValue(page([pendingSummary, confirmedSummary]));

    const { result } = renderHook(() => useOrderHistory());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.orders.map((order) => order.id)).toEqual(['order-2', 'order-1']);
    expect(result.current.hasMore).toBe(false);
  });

  it('is ready with no orders and no more pages for a customer with an empty history', async () => {
    listOrdersMock.mockResolvedValue(page([]));

    const { result } = renderHook(() => useOrderHistory());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.orders).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it('moves to an error state when the first page fails, and retry() loads it again', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    listOrdersMock.mockRejectedValueOnce(error);
    listOrdersMock.mockResolvedValueOnce(page([confirmedSummary]));

    const { result } = renderHook(() => useOrderHistory());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);
    expect(result.current.orders).toEqual([]);

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.orders).toHaveLength(1);
    expect(listOrdersMock).toHaveBeenCalledTimes(2);
  });

  describe('pagination', () => {
    it('reports hasMore when the backend returns a cursor', async () => {
      listOrdersMock.mockResolvedValue(page(manySummaries(2), 'cursor-1'));

      const { result } = renderHook(() => useOrderHistory());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.hasMore).toBe(true);
    });

    it('loadMore() requests the next page with the cursor the backend gave, and appends it', async () => {
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(2, 'a'), 'cursor-1'));
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(2, 'b'), null));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.loadMore();
      });

      expect(result.current.loadingMore).toBe(true);
      await waitFor(() => expect(result.current.loadingMore).toBe(false));
      expect(listOrdersMock.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-1' });
      expect(result.current.orders.map((order) => order.id)).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);
      expect(result.current.hasMore).toBe(false);
    });

    it('loadMore() is a no-op when there is no next page', async () => {
      listOrdersMock.mockResolvedValue(page(manySummaries(2), null));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.loadMore();
      });

      expect(listOrdersMock).toHaveBeenCalledTimes(1);
    });

    it('loadMore() does not start a second request while one is in flight', async () => {
      const second = deferred<OrderHistoryPage>();
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(1, 'a'), 'cursor-1'));
      listOrdersMock.mockReturnValueOnce(second.promise);

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.loadMore();
        result.current.loadMore();
      });

      expect(listOrdersMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        second.resolve(page(manySummaries(1, 'b')));
      });
      expect(result.current.orders).toHaveLength(2);
    });

    it('keeps the pages already loaded, and the same cursor, when loading more fails', async () => {
      const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(2, 'a'), 'cursor-1'));
      listOrdersMock.mockRejectedValueOnce(error);
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(1, 'b')));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.loadMore();
      });
      await waitFor(() => expect(result.current.loadMoreError).toBe(error));
      expect(result.current.status).toBe('ready');
      expect(result.current.orders).toHaveLength(2);
      expect(result.current.hasMore).toBe(true);

      act(() => {
        result.current.loadMore();
      });
      await waitFor(() => expect(result.current.orders).toHaveLength(3));
      expect(listOrdersMock.mock.calls[2][0]).toMatchObject({ cursor: 'cursor-1' });
      expect(result.current.loadMoreError).toBeNull();
    });

    it('never renders the same order twice if a later page repeats one', async () => {
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(2, 'a'), 'cursor-1'));
      listOrdersMock.mockResolvedValueOnce(page([...manySummaries(1, 'a'), ...manySummaries(1, 'b')]));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        result.current.loadMore();
      });

      await waitFor(() => expect(result.current.orders).toHaveLength(3));
      expect(result.current.orders.map((order) => order.id)).toEqual(['a-1', 'a-2', 'b-1']);
    });

    it('ignores a late "load more" response that arrives after a refresh replaced the list', async () => {
      const lateMore = deferred<OrderHistoryPage>();
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(1, 'old'), 'cursor-1'));
      listOrdersMock.mockReturnValueOnce(lateMore.promise);
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(1, 'fresh')));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        result.current.loadMore();
      });
      act(() => {
        result.current.refresh();
      });
      await waitFor(() => expect(result.current.orders[0]?.id).toBe('fresh-1'));

      await act(async () => {
        lateMore.resolve(page(manySummaries(1, 'stale')));
      });

      expect(result.current.orders.map((order) => order.id)).toEqual(['fresh-1']);
    });
  });

  describe('a refresh racing with "load more"', () => {
    it('drops a "load more" started while a refresh was in flight once the refresh has replaced the list', async () => {
      // A new order arrived: the refreshed first page ends at a different cursor,
      // so the page fetched with the OLD cursor would skip an order if appended.
      const refresh = deferred<OrderHistoryPage>();
      const lateMore = deferred<OrderHistoryPage>();
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(2, 'old'), 'cursor-old'));
      listOrdersMock.mockReturnValueOnce(refresh.promise);
      listOrdersMock.mockReturnValueOnce(lateMore.promise);

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        result.current.refresh();
      });
      act(() => {
        result.current.loadMore();
      });
      expect(listOrdersMock.mock.calls[2][0]).toMatchObject({ cursor: 'cursor-old' });

      await act(async () => {
        refresh.resolve(page(manySummaries(2, 'fresh'), 'cursor-fresh'));
      });
      await act(async () => {
        lateMore.resolve(page(manySummaries(2, 'stale'), 'cursor-stale'));
      });

      expect(result.current.orders.map((order) => order.id)).toEqual(['fresh-1', 'fresh-2']);
      expect(result.current.hasMore).toBe(true);
      expect(result.current.loadingMore).toBe(false);
    });

    it('still appends a "load more" when the refresh left the list at the same cursor', async () => {
      const refresh = deferred<OrderHistoryPage>();
      const more = deferred<OrderHistoryPage>();
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(2, 'a'), 'cursor-1'));
      listOrdersMock.mockReturnValueOnce(refresh.promise);
      listOrdersMock.mockReturnValueOnce(more.promise);

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        result.current.refresh();
      });
      act(() => {
        result.current.loadMore();
      });
      await act(async () => {
        refresh.resolve(page(manySummaries(2, 'a'), 'cursor-1'));
      });
      await act(async () => {
        more.resolve(page(manySummaries(1, 'b')));
      });

      expect(result.current.orders.map((order) => order.id)).toEqual(['a-1', 'a-2', 'b-1']);
      expect(result.current.hasMore).toBe(false);
    });

    it('does not leave "load more" stuck loading when a refresh fails while one was in flight', async () => {
      const more = deferred<OrderHistoryPage>();
      listOrdersMock.mockResolvedValueOnce(page(manySummaries(2, 'a'), 'cursor-1'));
      listOrdersMock.mockReturnValueOnce(more.promise);
      listOrdersMock.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Backend unavailable.'));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        result.current.loadMore();
      });
      expect(result.current.loadingMore).toBe(true);
      act(() => {
        result.current.refresh();
      });

      await waitFor(() => expect(listOrdersMock).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(result.current.loadingMore).toBe(false));
      expect(result.current.orders).toHaveLength(2);
      expect(result.current.hasMore).toBe(true);
    });
  });

  describe('refresh()', () => {
    it('replaces the list with the fresh first page, without showing the loading state', async () => {
      const fresh = deferred<OrderHistoryPage>();
      listOrdersMock.mockResolvedValueOnce(page([confirmedSummary]));
      listOrdersMock.mockReturnValueOnce(fresh.promise);

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.refresh();
      });

      // The list on screen stays put while the refresh is in flight.
      expect(result.current.status).toBe('ready');
      expect(result.current.orders.map((order) => order.id)).toEqual(['order-1']);

      await act(async () => {
        fresh.resolve(page([pendingSummary, confirmedSummary]));
      });
      expect(result.current.orders.map((order) => order.id)).toEqual(['order-2', 'order-1']);
    });

    it('keeps the list on screen when the refresh fails', async () => {
      listOrdersMock.mockResolvedValueOnce(page([confirmedSummary]));
      listOrdersMock.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Backend unavailable.'));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.refresh();
      });
      await waitFor(() => expect(listOrdersMock).toHaveBeenCalledTimes(2));

      expect(result.current.status).toBe('ready');
      expect(result.current.orders).toHaveLength(1);
    });

    it('is a no-op while the first load is still in flight', () => {
      listOrdersMock.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useOrderHistory());
      act(() => {
        result.current.refresh();
      });

      expect(listOrdersMock).toHaveBeenCalledTimes(1);
    });

    it('reloads from scratch, with the loading state, if the previous load had failed', async () => {
      listOrdersMock.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Backend unavailable.'));
      listOrdersMock.mockResolvedValueOnce(page([confirmedSummary]));

      const { result } = renderHook(() => useOrderHistory());
      await waitFor(() => expect(result.current.status).toBe('error'));

      act(() => {
        result.current.refresh();
      });

      expect(result.current.status).toBe('loading');
      await waitFor(() => expect(result.current.status).toBe('ready'));
    });
  });

  it("re-fetches on a fresh mount, never reusing a previous mount's list", async () => {
    listOrdersMock.mockResolvedValue(page([confirmedSummary]));

    const first = renderHook(() => useOrderHistory());
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    first.unmount();

    const second = renderHook(() => useOrderHistory());
    expect(second.result.current.status).toBe('loading');
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(listOrdersMock).toHaveBeenCalledTimes(2);
  });

  it('does not update state after unmount', async () => {
    const pending = deferred<OrderHistoryPage>();
    listOrdersMock.mockReturnValue(pending.promise);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderHook(() => useOrderHistory());
    unmount();
    await act(async () => {
      pending.resolve(page([confirmedSummary]));
    });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listOrders } from './api';
import type { OrderSummary } from './types';

/** A page-size hint; the backend applies its own default and hard maximum. */
const PAGE_SIZE = 20;

type LoadMoreState = 'idle' | 'loading' | 'error';

export type OrderHistoryState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | {
      status: 'ready';
      orders: OrderSummary[];
      nextCursor: string | null;
      loadMore: LoadMoreState;
      loadMoreError: unknown;
    };

export interface UseOrderHistoryResult {
  status: OrderHistoryState['status'];
  orders: OrderSummary[];
  error: unknown;
  /** Whether the backend reported another page after the ones loaded so far. */
  hasMore: boolean;
  loadingMore: boolean;
  /** The failure of the last "load more", if any; the pages already loaded stay. */
  loadMoreError: unknown;
  /** Re-fetches from the first page, showing the loading state (used after a failed load). */
  retry: () => void;
  /** Fetches the next page and appends it; a no-op if there isn't one or one is in flight. */
  loadMore: () => void;
  /**
   * Re-fetches the first page without blanking the list, e.g. when the customer
   * returns to this tab after placing an order. The list on screen is replaced
   * only when the fresh page arrives, and kept if the refresh fails. A no-op
   * while the first load is still in flight.
   */
  refresh: () => void;
}

/**
 * Loads the signed-in customer's own order history from the backend, newest
 * first, one page at a time. The list is never persisted on the client (no
 * localStorage, no module-level cache): every mount fetches its own copy, and
 * which orders come back is decided by the server from the session alone.
 *
 * Responses are guarded by a generation counter, so a slow page can never
 * overwrite a newer one (e.g. a "load more" that was in flight when the list
 * was refreshed, or a request that outlives the component).
 */
export function useOrderHistory(): UseOrderHistoryResult {
  const [state, setState] = useState<OrderHistoryState>({ status: 'loading' });
  const generation = useRef(0);
  // Always the latest committed state, for callbacks that must stay referentially stable.
  // A layout effect, not a passive one: it runs inside the commit itself, so a tap
  // on a button that has just rendered can never see the state from before it.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const fetchFirstPage = useCallback((keepListOnError: boolean) => {
    const mine = ++generation.current;
    listOrders({ limit: PAGE_SIZE }).then(
      (page) => {
        if (generation.current === mine) {
          setState({
            status: 'ready',
            orders: page.orders,
            nextCursor: page.nextCursor,
            loadMore: 'idle',
            loadMoreError: null,
          });
        }
      },
      (error: unknown) => {
        if (generation.current === mine) {
          setState((previous) => {
            if (!keepListOnError || previous.status !== 'ready') {
              return { status: 'error', error };
            }
            // This refresh invalidated any "load more" still in flight, so its
            // spinner must not be left behind: nothing will ever clear it.
            return previous.loadMore === 'loading' ? { ...previous, loadMore: 'idle' } : previous;
          });
        }
      },
    );
  }, []);

  useEffect(() => {
    fetchFirstPage(false);
    const counter = generation;
    return () => {
      // Invalidate anything still in flight when the component goes away.
      counter.current++;
    };
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    fetchFirstPage(false);
  }, [fetchFirstPage]);

  const refresh = useCallback(() => {
    const current = stateRef.current;
    if (current.status === 'loading') {
      return;
    }
    if (current.status === 'error') {
      setState({ status: 'loading' });
      fetchFirstPage(false);
      return;
    }
    fetchFirstPage(true);
  }, [fetchFirstPage]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== 'ready' || current.nextCursor === null || current.loadMore === 'loading') {
      return;
    }

    const mine = generation.current;
    const cursor = current.nextCursor;
    const loading: OrderHistoryState = { ...current, loadMore: 'loading', loadMoreError: null };
    // Recorded now, not on the next render, so a second tap before React re-renders is still a no-op.
    stateRef.current = loading;
    setState(loading);

    listOrders({ limit: PAGE_SIZE, cursor }).then(
      (page) => {
        if (generation.current !== mine) {
          return;
        }
        setState((previous) => {
          // A page is only a continuation of the list it was requested from. If a
          // refresh has since replaced the list (so it now ends at a different
          // cursor), appending this page would leave a gap.
          if (previous.status !== 'ready' || previous.nextCursor !== cursor) {
            return previous;
          }
          // Cursor paging shouldn't repeat an order, but never render one twice if it does.
          const known = new Set(previous.orders.map((order) => order.id));
          return {
            status: 'ready',
            orders: [...previous.orders, ...page.orders.filter((order) => !known.has(order.id))],
            nextCursor: page.nextCursor,
            loadMore: 'idle',
            loadMoreError: null,
          };
        });
      },
      (error: unknown) => {
        if (generation.current !== mine) {
          return;
        }
        setState((previous) =>
          previous.status === 'ready' && previous.nextCursor === cursor
            ? { ...previous, loadMore: 'error', loadMoreError: error }
            : previous,
        );
      },
    );
  }, []);

  return {
    status: state.status,
    orders: state.status === 'ready' ? state.orders : [],
    error: state.status === 'error' ? state.error : null,
    hasMore: state.status === 'ready' && state.nextCursor !== null,
    loadingMore: state.status === 'ready' && state.loadMore === 'loading',
    loadMoreError: state.status === 'ready' ? state.loadMoreError : null,
    retry,
    loadMore,
    refresh,
  };
}

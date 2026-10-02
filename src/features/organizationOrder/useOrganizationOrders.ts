import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OrganizationId, OutletId } from '../../domain/types';
import { listOrganizationOrders } from './api';
import { isOrganizationOrdersForbidden } from './errors';
import type { OrganizationOrderSummary } from './types';

/** A page-size hint; the backend applies its own default and hard maximum. */
const PAGE_SIZE = 20;

type LoadMoreState = 'idle' | 'loading' | 'error';

/**
 * What was loaded, and for WHICH scope (organization + outlet filter). A state
 * whose scope isn't the current one is never shown: changing the outlet filter
 * must not keep displaying the previous outlet's orders while the new ones load.
 */
type OrganizationOrdersState =
  | { scope: string; status: 'loading' }
  | { scope: string; status: 'error'; error: unknown }
  | {
      scope: string;
      status: 'ready';
      orders: OrganizationOrderSummary[];
      nextCursor: string | null;
      loadMore: LoadMoreState;
      loadMoreError: unknown;
      refreshing: boolean;
      refreshError: unknown;
    };

export interface UseOrganizationOrdersResult {
  status: OrganizationOrdersState['status'];
  orders: OrganizationOrderSummary[];
  error: unknown;
  /** Whether the backend reported another page after the ones loaded so far. */
  hasMore: boolean;
  loadingMore: boolean;
  /** The failure of the last "load more", if any; the pages already loaded stay (a 403 aside: access lost clears them, see `loadMore`). */
  loadMoreError: unknown;
  /** Whether a `refresh` is in flight (the list on screen stays until it lands). */
  refreshing: boolean;
  /** The failure of the last `refresh`, if any; the list on screen is kept, as it was (a 403 aside: see `refresh`). */
  refreshError: unknown;
  /** Re-fetches from the first page, showing the loading state (used after a failed load). */
  retry: () => void;
  /**
   * Fetches the next page and appends it; a no-op if there isn't one or one is in
   * flight. If it is refused with a 403 (access lost while the page was open), the
   * loaded list and the cursor are cleared and the access error is shown instead,
   * exactly as for a refused `refresh`. Any other failure keeps the pages already
   * loaded and leaves the page to be tried again.
   */
  loadMore: () => void;
  /**
   * Re-fetches the first page without blanking the list — for the Refresh
   * button, and for coming back to this page (Ionic keeps pages mounted while
   * hidden). The list on screen is replaced only when the fresh page arrives,
   * and kept if the refresh fails — except for a 403 (access lost), which clears
   * the list and shows the access error instead. A no-op while the first load or
   * another refresh is in flight.
   */
  refresh: () => void;
}

/**
 * Loads `organizationId`'s orders from the backend, newest first, one page at a
 * time, optionally narrowed to `outletId`. Nothing is persisted on the client
 * (no localStorage, no module-level cache): every mount fetches its own copy,
 * and which orders come back is decided by the server from the session's
 * membership alone — `organizationId` and `outletId` are only requests.
 *
 * Changing `organizationId` or `outletId` starts over from the first page.
 * Responses are guarded by a generation counter, so a slow page can never
 * overwrite a newer one (a "load more" in flight when the list was refreshed or
 * the filter changed, or a request that outlives the component).
 */
export function useOrganizationOrders(
  organizationId: OrganizationId,
  outletId: OutletId | null,
): UseOrganizationOrdersResult {
  const scope = `${organizationId}/${outletId ?? ''}`;
  const [state, setState] = useState<OrganizationOrdersState>({ scope, status: 'loading' });
  const generation = useRef(0);
  // Always the latest committed state, for callbacks that must stay referentially stable.
  // A layout effect, not a passive one: it runs inside the commit itself, so a tap
  // on a button that has just rendered can never see the state from before it.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const fetchFirstPage = useCallback(
    (keepListOnError: boolean) => {
      const mine = ++generation.current;
      listOrganizationOrders(organizationId, { outletId: outletId ?? undefined, limit: PAGE_SIZE }).then(
        (page) => {
          if (generation.current === mine) {
            setState({
              scope,
              status: 'ready',
              orders: page.orders,
              nextCursor: page.nextCursor,
              loadMore: 'idle',
              loadMoreError: null,
              refreshing: false,
              refreshError: null,
            });
          }
        },
        (error: unknown) => {
          if (generation.current === mine) {
            setState((previous) => {
              // A 403 means access to this organization's orders has been lost (e.g. the
              // membership was revoked while the page was open). Nothing already loaded may
              // stay on screen then: the whole state — rows, cursor, in-flight flags — is
              // replaced by the same error state an initial 403 produces. Every other
              // failure (network, 5xx, ...) keeps the list, as a refresh always has.
              if (
                !keepListOnError ||
                previous.scope !== scope ||
                previous.status !== 'ready' ||
                isOrganizationOrdersForbidden(error)
              ) {
                return { scope, status: 'error', error };
              }
              // This refresh invalidated any "load more" still in flight, so its
              // spinner must not be left behind: nothing will ever clear it.
              return {
                ...previous,
                loadMore: previous.loadMore === 'loading' ? 'idle' : previous.loadMore,
                refreshing: false,
                refreshError: error,
              };
            });
          }
        },
      );
    },
    [organizationId, outletId, scope],
  );

  useEffect(() => {
    fetchFirstPage(false);
    const counter = generation;
    return () => {
      // Invalidate anything still in flight when the scope changes or the component goes away.
      counter.current++;
    };
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setState({ scope, status: 'loading' });
    fetchFirstPage(false);
  }, [fetchFirstPage, scope]);

  const refresh = useCallback(() => {
    const current = stateRef.current;
    if (current.scope !== scope || current.status === 'loading') {
      return;
    }
    if (current.status === 'error') {
      setState({ scope, status: 'loading' });
      fetchFirstPage(false);
      return;
    }
    if (current.refreshing) {
      return;
    }
    const refreshing: OrganizationOrdersState = { ...current, refreshing: true, refreshError: null };
    // Recorded now, not on the next render, so a second tap before React re-renders is still a no-op.
    stateRef.current = refreshing;
    setState(refreshing);
    fetchFirstPage(true);
  }, [fetchFirstPage, scope]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (
      current.scope !== scope ||
      current.status !== 'ready' ||
      current.nextCursor === null ||
      current.loadMore === 'loading'
    ) {
      return;
    }

    const mine = generation.current;
    const cursor = current.nextCursor;
    const loading: OrganizationOrdersState = { ...current, loadMore: 'loading', loadMoreError: null };
    // Recorded now, not on the next render, so a second tap before React re-renders is still a no-op.
    stateRef.current = loading;
    setState(loading);

    listOrganizationOrders(organizationId, { outletId: outletId ?? undefined, limit: PAGE_SIZE, cursor }).then(
      (page) => {
        if (generation.current !== mine) {
          return;
        }
        setState((previous) => {
          // A page is only a continuation of the list it was requested from. If a
          // refresh has since replaced the list (so it now ends at a different
          // cursor), appending this page would leave a gap.
          if (previous.scope !== scope || previous.status !== 'ready' || previous.nextCursor !== cursor) {
            return previous;
          }
          // Cursor paging shouldn't repeat an order, but never render one twice if it does.
          const known = new Set(previous.orders.map((order) => order.id));
          return {
            ...previous,
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
        setState((previous) => {
          // Only a failure of the page the list on screen is waiting for counts.
          if (previous.scope !== scope || previous.status !== 'ready' || previous.nextCursor !== cursor) {
            return previous;
          }
          // A 403 means access to this organization's orders has been lost, exactly as
          // for a refresh: nothing already loaded may stay on screen, so the whole state —
          // rows, cursor, the in-flight "load more" — is replaced by the same error state an
          // initial 403 produces. Every other failure keeps the pages already loaded and
          // offers to try that page again.
          if (isOrganizationOrdersForbidden(error)) {
            return { scope, status: 'error', error };
          }
          return { ...previous, loadMore: 'error', loadMoreError: error };
        });
      },
    );
  }, [organizationId, outletId, scope]);

  // A state loaded for another scope is not this scope's data: show loading until the new fetch lands.
  const view: OrganizationOrdersState = state.scope === scope ? state : { scope, status: 'loading' };

  return {
    status: view.status,
    orders: view.status === 'ready' ? view.orders : [],
    error: view.status === 'error' ? view.error : null,
    hasMore: view.status === 'ready' && view.nextCursor !== null,
    loadingMore: view.status === 'ready' && view.loadMore === 'loading',
    loadMoreError: view.status === 'ready' ? view.loadMoreError : null,
    refreshing: view.status === 'ready' && view.refreshing,
    refreshError: view.status === 'ready' ? view.refreshError : null,
    retry,
    loadMore,
    refresh,
  };
}

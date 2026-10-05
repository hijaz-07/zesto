import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from './api';
import { useOptionalNotifications } from './context';
import { isPermanentNotificationFailure, markReadErrorMessage, markReadNeedsRefresh } from './errors';
import type { AppNotification, NotificationFilter, NotificationId, NotificationScope } from './types';

/** A page-size hint; the backend applies its own default (20) and hard maximum (50). */
const PAGE_SIZE = 20;

/** How many times "mark all" repeats while the backend says more may remain, per press. */
const MARK_ALL_MAX_CALLS = 5;

type LoadMoreState = 'idle' | 'loading' | 'error';

/**
 * What was loaded, and for WHICH inbox and filter. A state for another one is
 * never shown: switching All/Unread must not keep displaying the other list
 * while the new one loads.
 */
type ListState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error'; error: unknown }
  | {
      key: string;
      status: 'ready';
      notifications: AppNotification[];
      nextCursor: string | null;
      loadMore: LoadMoreState;
      loadMoreError: unknown;
    };

export interface UseNotificationsResult {
  status: ListState['status'];
  notifications: AppNotification[];
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  /** The failure of the last "load more", if any; the pages already loaded stay. */
  loadMoreError: unknown;
  /** Re-fetches from the first page, showing the loading state (after a failed load). */
  retry: () => void;
  /** Fetches the next page and appends it; a no-op if there isn't one or one is in flight. */
  loadMore: () => void;
  /**
   * Re-fetches the first page WITHOUT blanking the list (no flicker): the list on
   * screen is replaced when the fresh page arrives and kept if the refresh fails —
   * except for a 401/403, which means access is gone and shows that instead.
   */
  refresh: () => void;
  /** IDs with a mark-read in flight. */
  pendingIds: ReadonlySet<NotificationId>;
  /** The message for each notification whose last mark-read failed. */
  markReadErrors: Readonly<Record<NotificationId, string>>;
  /**
   * Marks one notification read. Resolves `true` only if the BACKEND said so —
   * the row changes (or leaves the Unread list) then and not before. A failure
   * leaves it exactly as it was, records its message, and resolves `false`.
   */
  markRead: (id: NotificationId) => Promise<boolean>;
  markingAll: boolean;
  markAllError: string | null;
  /** After "mark all": whether the backend says unread notifications may still remain. */
  markAllHasMore: boolean;
  /** Marks everything read, repeating while the backend says more remains (bounded). */
  markAllRead: () => Promise<void>;
}

function keyOf(scope: NotificationScope, filter: NotificationFilter): string {
  return `${scope.kind === 'customer' ? 'customer' : `organization:${scope.organizationId}`}/${filter}`;
}

/**
 * Loads the signed-in user's notifications for one inbox, newest first, one
 * page at a time, and marks them read. Nothing is persisted on the client; every
 * mount fetches its own copy, and what comes back is decided by the server from
 * the session (and, for an organization, the caller's membership).
 *
 * It is independent of the shell's unread-count poll (`NotificationProvider`):
 * the list is fetched when the page opens, when the page becomes visible again,
 * and on request — never on a timer. After something is marked read it asks the
 * provider for the SERVER's new count; it never computes one.
 *
 * Responses are guarded by a generation counter, so a slow page can never
 * overwrite a newer one.
 */
export function useNotifications(scope: NotificationScope, filter: NotificationFilter): UseNotificationsResult {
  const key = keyOf(scope, filter);
  const organizationId = scope.kind === 'organization' ? scope.organizationId : null;
  // Rebuilt from primitives so callbacks stay stable however the caller built `scope`.
  const stableScope = useRef<NotificationScope>(scope);
  useLayoutEffect(() => {
    stableScope.current = organizationId === null ? { kind: 'customer' } : { kind: 'organization', organizationId };
  }, [organizationId]);
  const unreadOnly = filter === 'unread';
  const provider = useOptionalNotifications();
  const refreshUnreadCount = provider?.refreshUnreadCount;

  const [state, setState] = useState<ListState>({ key, status: 'loading' });
  const [pendingIds, setPendingIds] = useState<ReadonlySet<NotificationId>>(new Set());
  const [markReadErrors, setMarkReadErrors] = useState<Readonly<Record<NotificationId, string>>>({});
  const [markingAll, setMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const [markAllHasMore, setMarkAllHasMore] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  // A layout effect, not a passive one: it runs inside the commit itself, so a tap
  // on a button that has just rendered can never see the state from before it.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const fetchFirstPage = useCallback(
    (keepListOnError: boolean) => {
      const mine = ++generation.current;
      listNotifications(stableScope.current, { limit: PAGE_SIZE, unread: unreadOnly }).then(
        (page) => {
          if (generation.current === mine) {
            setState({
              key,
              status: 'ready',
              notifications: page.notifications,
              nextCursor: page.nextCursor,
              loadMore: 'idle',
              loadMoreError: null,
            });
          }
        },
        (error: unknown) => {
          if (generation.current !== mine) {
            return;
          }
          setState((previous) => {
            // Access lost while the page was open: nothing already loaded may stay on screen.
            if (
              !keepListOnError ||
              previous.key !== key ||
              previous.status !== 'ready' ||
              isPermanentNotificationFailure(error)
            ) {
              return { key, status: 'error', error };
            }
            // A refresh that fails keeps the list. It invalidated any "load more" in
            // flight, so that spinner must not be left behind.
            return previous.loadMore === 'loading' ? { ...previous, loadMore: 'idle' } : previous;
          });
        },
      );
    },
    [key, unreadOnly],
  );

  useEffect(() => {
    mounted.current = true;
    fetchFirstPage(false);
    const counter = generation;
    return () => {
      // Invalidate anything still in flight when the filter changes or the page goes away.
      counter.current++;
      mounted.current = false;
    };
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setState({ key, status: 'loading' });
    fetchFirstPage(false);
  }, [fetchFirstPage, key]);

  const refresh = useCallback(() => {
    const current = stateRef.current;
    if (current.key !== key || current.status === 'loading') {
      return;
    }
    if (current.status === 'error') {
      setState({ key, status: 'loading' });
      fetchFirstPage(false);
      return;
    }
    fetchFirstPage(true);
  }, [fetchFirstPage, key]);

  // Coming back to the tab/window: the list may have moved while the person was away.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'hidden') {
        refresh();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refresh]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.key !== key || current.status !== 'ready' || current.nextCursor === null || current.loadMore === 'loading') {
      return;
    }

    const mine = generation.current;
    const cursor = current.nextCursor;
    const loading: ListState = { ...current, loadMore: 'loading', loadMoreError: null };
    // Recorded now, not on the next render, so a second tap before React re-renders is still a no-op.
    stateRef.current = loading;
    setState(loading);

    listNotifications(stableScope.current, { limit: PAGE_SIZE, cursor, unread: unreadOnly }).then(
      (page) => {
        if (generation.current !== mine) {
          return;
        }
        setState((previous) => {
          // A page only continues the list it was requested from.
          if (previous.key !== key || previous.status !== 'ready' || previous.nextCursor !== cursor) {
            return previous;
          }
          const known = new Set(previous.notifications.map((notification) => notification.id));
          return {
            ...previous,
            notifications: [...previous.notifications, ...page.notifications.filter((n) => !known.has(n.id))],
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
          if (previous.key !== key || previous.status !== 'ready' || previous.nextCursor !== cursor) {
            return previous;
          }
          if (isPermanentNotificationFailure(error)) {
            return { key, status: 'error', error };
          }
          return { ...previous, loadMore: 'error', loadMoreError: error };
        });
      },
    );
  }, [key, unreadOnly]);

  const markRead = useCallback(
    async (id: NotificationId): Promise<boolean> => {
      setPendingIds((previous) => new Set(previous).add(id));
      setMarkReadErrors((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      try {
        const updated = await markNotificationRead(stableScope.current, id);
        if (mounted.current) {
          setState((previous) => {
            if (previous.key !== key || previous.status !== 'ready') {
              return previous;
            }
            // The row is the backend's own answer. In the Unread list a read one leaves.
            return {
              ...previous,
              notifications: unreadOnly
                ? previous.notifications.filter((notification) => notification.id !== id)
                : previous.notifications.map((notification) => (notification.id === id ? updated : notification)),
            };
          });
        }
        // The count is the server's to give: ask for it rather than subtract.
        refreshUnreadCount?.();
        return true;
      } catch (error: unknown) {
        if (mounted.current) {
          setMarkReadErrors((previous) => ({ ...previous, [id]: markReadErrorMessage(error) }));
          if (markReadNeedsRefresh(error)) {
            refresh();
          }
        }
        return false;
      } finally {
        if (mounted.current) {
          setPendingIds((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
        }
      }
    },
    [key, unreadOnly, refresh, refreshUnreadCount],
  );

  const markAllRead = useCallback(async (): Promise<void> => {
    if (markingAll) {
      return;
    }
    setMarkingAll(true);
    setMarkAllError(null);
    setMarkAllHasMore(false);
    let hasMore = false;
    try {
      for (let call = 0; call < MARK_ALL_MAX_CALLS; call++) {
        const result = await markAllNotificationsRead(stableScope.current);
        hasMore = result.hasMore;
        if (!hasMore) {
          break;
        }
      }
      if (mounted.current) {
        setMarkAllHasMore(hasMore);
      }
    } catch (error: unknown) {
      if (mounted.current) {
        setMarkAllError(markReadErrorMessage(error));
      }
    } finally {
      if (mounted.current) {
        setMarkingAll(false);
      }
      // Whatever happened, what is on screen and the badge are the server's to say now.
      refresh();
      refreshUnreadCount?.();
    }
  }, [markingAll, refresh, refreshUnreadCount]);

  // A state loaded for another inbox/filter is not this one's data: show loading until the new fetch lands.
  const view: ListState = state.key === key ? state : { key, status: 'loading' };

  return {
    status: view.status,
    notifications: view.status === 'ready' ? view.notifications : [],
    error: view.status === 'error' ? view.error : null,
    hasMore: view.status === 'ready' && view.nextCursor !== null,
    loadingMore: view.status === 'ready' && view.loadMore === 'loading',
    loadMoreError: view.status === 'ready' ? view.loadMoreError : null,
    retry,
    loadMore,
    refresh,
    pendingIds,
    markReadErrors,
    markRead,
    markingAll,
    markAllError,
    markAllHasMore,
    markAllRead,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getUnreadCount } from './api';
import { NotificationContext, type NotificationContextValue, type NotificationPollStop } from './context';
import { isPermanentNotificationFailure } from './errors';
import type { NotificationScope } from './types';
import { visibilityRefreshAllowed } from './visibilityThrottle';
import { ApiError } from '../../lib/api/client';

/** How often the unread count is re-read while the page is visible. */
export const NOTIFICATION_POLL_MS = 30_000;

export interface NotificationProviderProps {
  scope: NotificationScope;
  /** Overridable for tests only. */
  pollIntervalMs?: number;
  children: ReactNode;
}

interface PollState {
  /** Which scope these values are for; values of another scope are never shown. */
  key: string;
  unreadCount: number | null;
  stopped: NotificationPollStop | null;
}

function scopeKey(scope: NotificationScope): string {
  return scope.kind === 'customer' ? 'customer' : `organization:${scope.organizationId}`;
}

/**
 * The shell's ONE notification poller: it keeps the unread count for one inbox
 * (the customer's, or one organization's) fresh, and nothing else. It does not
 * load notification lists — those are fetched by the notification page itself
 * — and it is not a general polling facility: one timer, one endpoint
 * (`GET .../notifications/unread-count`).
 *
 * It reads the count:
 * - once when it mounts (if the page is visible);
 * - about every `NOTIFICATION_POLL_MS`, only while the page is visible — the
 *   timer is cleared when the tab goes hidden and nothing is requested;
 * - at once when the page becomes visible again (the count may have moved while
 *   the person was away), after which the beat resumes — unless the last read
 *   started less than `VISIBILITY_REFRESH_MIN_INTERVAL_MS` ago (see
 *   `visibilityThrottle.ts`), in which case no read is made and the beat is simply
 *   re-armed for what is left of its interval, so a flickering visibility signal
 *   cannot turn into a request per flicker;
 * - on request (`refreshUnreadCount`), e.g. after a notification was marked read.
 *
 * Reads never overlap: the next one is scheduled only after the previous one
 * finishes, and a request made during one is answered by one more read right
 * after it. A network or server failure changes nothing on screen (the last
 * known count stays, no error is shown) and the beat goes on; a 401 or 403 stops
 * it for good — the session is gone, or access to this organization's inbox is —
 * and the count is dropped rather than shown stale. It also stops on unmount.
 *
 * Mount ONE per shell (`CustomerAppLayout`, `OrganizationAppLayout`); the bell
 * and the notification page read it through `useOptionalNotifications`.
 */
export function NotificationProvider({
  scope,
  pollIntervalMs = NOTIFICATION_POLL_MS,
  children,
}: NotificationProviderProps) {
  const key = scopeKey(scope);
  const organizationId = scope.kind === 'organization' ? scope.organizationId : null;
  const [state, setState] = useState<PollState>({ key, unreadCount: null, stopped: null });
  const readNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Rebuilt from the primitives so the effect only restarts when the scope really changes.
    const effectScope: NotificationScope =
      organizationId === null ? { kind: 'customer' } : { kind: 'organization', organizationId };

    let cancelled = false;
    let stopped = false;
    let inFlight = false;
    let again = false;
    // When the last read started, whatever caused it: the visibility throttle measures from here.
    let lastReadAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isHidden = () => document.visibilityState === 'hidden';
    const stopTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const scheduleNextIfVisible = (delayMs = pollIntervalMs) => {
      stopTimer();
      if (!cancelled && !stopped && !isHidden()) {
        timer = setTimeout(() => void read(), delayMs);
      }
    };

    async function read(): Promise<void> {
      if (cancelled || stopped) {
        return;
      }
      if (inFlight) {
        // Never overlap, but never lose a request either.
        again = true;
        return;
      }
      stopTimer();
      inFlight = true;
      lastReadAt = Date.now();
      try {
        const unreadCount = await getUnreadCount(effectScope);
        if (cancelled) {
          return;
        }
        setState({ key, unreadCount, stopped: null });
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        if (isPermanentNotificationFailure(error)) {
          stopped = true;
          stopTimer();
          setState({
            key,
            unreadCount: null,
            stopped: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unauthorized',
          });
          return;
        }
        // Anything else is transient: keep what is shown and try again on the next beat.
      } finally {
        inFlight = false;
      }
      if (cancelled || stopped) {
        return;
      }
      if (again) {
        again = false;
        void read();
        return;
      }
      scheduleNextIfVisible();
    }

    function onVisibilityChange() {
      if (isHidden()) {
        stopTimer();
        return;
      }
      if (timer !== undefined || inFlight) {
        return;
      }
      const now = Date.now();
      if (visibilityRefreshAllowed(lastReadAt, now)) {
        void read();
      } else {
        // Back so soon after the last read (a flickering pane) that another one would be
        // noise. Do not read, but do not lose the beat either: the "hidden" just before
        // this cleared the timer, so re-arm it for what is left of the interval.
        scheduleNextIfVisible(Math.max(0, pollIntervalMs - (now - lastReadAt)));
      }
    }

    readNowRef.current = () => void read();
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!isHidden()) {
      void read();
    }

    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      readNowRef.current = () => {};
    };
  }, [key, organizationId, pollIntervalMs]);

  const refreshUnreadCount = useCallback(() => readNowRef.current(), []);

  // A state recorded for another scope is not this scope's: show nothing until the new read lands.
  const view: PollState = state.key === key ? state : { key, unreadCount: null, stopped: null };

  const value = useMemo<NotificationContextValue>(
    () => ({
      scope: organizationId === null ? { kind: 'customer' } : { kind: 'organization', organizationId },
      unreadCount: view.unreadCount,
      stopped: view.stopped,
      refreshUnreadCount,
    }),
    [organizationId, view.unreadCount, view.stopped, refreshUnreadCount],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

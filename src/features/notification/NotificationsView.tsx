import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/cn';
import { useOnBecameVisible } from '../../hooks/useOnBecameVisible';
import { useOptionalNotifications } from './context';
import { isNotificationsForbidden, listNotificationsErrorMessage } from './errors';
import { notificationTarget } from './link';
import { NotificationItem } from './NotificationItem';
import type { AppNotification, NotificationFilter, NotificationScope } from './types';
import { useNotifications } from './useNotifications';

/**
 * How long opening a notification waits for its mark-read before going on
 * anyway. Opening never depends on the read succeeding or even finishing: a slow
 * or failed mark-read must not keep someone from the order they tapped.
 */
export const OPEN_READ_GRACE_MS = 1500;

export interface NotificationsViewProps {
  /** Which inbox this page shows: only a choice of endpoint (see `NotificationScope`). */
  scope: NotificationScope;
}

const FILTERS: ReadonlyArray<{ value: NotificationFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
];

/** Resolves with `promise`'s outcome or, after `ms`, without it. `promise` is never rejected here. */
function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * The body of the notification pages (`/app/notifications`,
 * `/org/notifications`): the signed-in user's notifications for one inbox,
 * newest first, a page at a time, with an All/Unread filter, "Mark all as read",
 * and a way to open what each one is about. The page only READS what the
 * backend created and marks it read — it never makes a notification, and which
 * ones come back is the server's decision from the session (and, for an
 * organization, the caller's membership).
 *
 * Notification trouble is contained here: a failed list, a refused organization
 * inbox or a failed mark-read changes only this page.
 *
 * Fetching: the list is read when the page opens, when the page becomes visible
 * again (a tab or window coming back, or Ionic re-showing a kept-mounted page),
 * and when the shell's unread count RISES (something new arrived). Nothing polls
 * here — the shell's single poller keeps the count. After a notification is
 * marked read the page asks that poller for the server's new count.
 */
export function NotificationsView({ scope }: NotificationsViewProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const {
    status,
    notifications,
    error,
    hasMore,
    loadingMore,
    loadMoreError,
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
  } = useNotifications(scope, filter);

  // Ionic keeps a page mounted (but hidden) when the person navigates away: coming
  // back is not a mount, so visibility itself is the signal.
  const pageRef = useRef<HTMLDivElement>(null);
  useOnBecameVisible(pageRef, refresh);

  // The shell's count rising means something arrived since this list was read.
  const providerCount = useOptionalNotifications()?.unreadCount ?? null;
  const previousCount = useRef<number | null>(null);
  useEffect(() => {
    if (previousCount.current !== null && providerCount !== null && providerCount > previousCount.current) {
      refresh();
    }
    previousCount.current = providerCount;
  }, [providerCount, refresh]);

  const open = useCallback(
    async (notification: AppNotification) => {
      const target = notificationTarget(notification, scope);
      if (notification.readAt === null) {
        await waitAtMost(markRead(notification.id), OPEN_READ_GRACE_MS);
      }
      navigate(target);
    },
    [markRead, navigate, scope],
  );

  const hasUnread = notifications.some((notification) => notification.readAt === null) || (providerCount ?? 0) > 0;

  let content: ReactNode;
  if (status === 'loading') {
    content = <LoadingState label="Loading notifications…" />;
  } else if (status === 'error') {
    content = isNotificationsForbidden(error) ? (
      <ErrorState
        title="You don't have access to these notifications"
        description={listNotificationsErrorMessage(error, scope)}
      />
    ) : (
      <ErrorState
        title="Couldn't load notifications"
        description={listNotificationsErrorMessage(error, scope)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (notifications.length === 0) {
    content =
      filter === 'unread' ? (
        <EmptyState
          title="You're all caught up"
          description="There are no unread notifications."
          action={
            <Button variant="secondary" onClick={() => setFilter('all')}>
              Show all notifications
            </Button>
          }
        />
      ) : (
        <EmptyState
          title="No notifications yet"
          description={
            scope.kind === 'customer'
              ? "You'll be notified here as your orders are confirmed, prepared and ready."
              : 'New orders will be announced here.'
          }
        />
      );
  } else {
    content = (
      <>
        <ul aria-label="Notifications" className="flex flex-col gap-3">
          {notifications.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              pending={pendingIds.has(notification.id)}
              error={markReadErrors[notification.id] ?? null}
              onOpen={(item) => void open(item)}
              onMarkRead={(item) => void markRead(item.id)}
            />
          ))}
        </ul>

        {loadMoreError !== null && (
          <p role="alert" className="text-center text-sm text-danger">
            {listNotificationsErrorMessage(loadMoreError, scope)}
          </p>
        )}

        {hasMore && (
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? 'Loading…' : loadMoreError !== null ? 'Try again' : 'Load more'}
          </Button>
        )}
      </>
    );
  }

  return (
    <div ref={pageRef} className="flex flex-col gap-4 p-4">
      <PageHeader
        title="Notifications"
        actions={
          <Button
            variant="secondary"
            onClick={() => void markAllRead()}
            disabled={markingAll || status !== 'ready' || !hasUnread}
            aria-busy={markingAll}
          >
            {markingAll ? 'Marking…' : 'Mark all as read'}
          </Button>
        }
      />

      <div role="group" aria-label="Filter notifications" className="flex gap-2">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              filter === value
                ? 'border-primary bg-primary text-white'
                : 'border-border bg-surface text-text hover:bg-background',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {markAllError !== null && (
        <p role="alert" className="text-sm text-danger">
          {markAllError}
        </p>
      )}
      {markAllHasMore && markAllError === null && (
        <p role="status" className="text-sm text-muted">
          Some notifications are still unread. Press &quot;Mark all as read&quot; again.
        </p>
      )}

      {content}
    </div>
  );
}

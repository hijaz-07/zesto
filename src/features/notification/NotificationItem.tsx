import { Card } from '../../components/ui/Card';
import { cn } from '../../lib/cn';
import { formatBusinessDateTime } from '../../utils/date';
import type { AppNotification } from './types';

export interface NotificationItemProps {
  notification: AppNotification;
  /** A mark-read for this notification is in flight. */
  pending: boolean;
  /** Why the last mark-read failed, if it did. The notification still reads as unread. */
  error: string | null;
  /** Opens what the notification is about (marking it read first, as the page decides). */
  onOpen: (notification: AppNotification) => void;
  onMarkRead: (notification: AppNotification) => void;
}

/**
 * One notification: its title, text and time — and nothing else. Only the
 * fields `AppNotification` has can be shown (no event, scope, organization or
 * user id, no audit data), and the same item serves customers and
 * organizations alike.
 *
 * Unread is shown in three ways at once, so colour is never the only signal: a
 * "New" label, a bold title, and an accent border. The whole body is one button
 * (opening the order), and unread ones carry a separate "Mark as read" button
 * beside it — never nested inside it.
 */
export function NotificationItem({ notification, pending, error, onOpen, onMarkRead }: NotificationItemProps) {
  const unread = notification.readAt === null;

  return (
    <li>
      <Card className={cn('flex flex-col overflow-hidden p-0', unread && 'border-primary/50')}>
        <div className="flex items-stretch">
          <button
            type="button"
            onClick={() => onOpen(notification)}
            disabled={pending}
            className="flex min-w-0 flex-1 flex-col gap-1 p-4 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-60"
          >
            <span className="flex items-center gap-2">
              {unread && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-white">New</span>
              )}
              <span className={cn('truncate text-text', unread ? 'font-semibold' : 'font-medium')}>
                {notification.title}
              </span>
            </span>
            <span className="text-sm text-text">{notification.body}</span>
            <time dateTime={notification.createdAt} className="text-xs text-muted">
              {formatBusinessDateTime(notification.createdAt)}
            </time>
          </button>

          {unread && (
            <button
              type="button"
              onClick={() => onMarkRead(notification)}
              disabled={pending}
              aria-label={`Mark "${notification.title}" as read`}
              className="shrink-0 self-center px-3 py-2 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              Mark as read
            </button>
          )}
        </div>

        {error !== null && (
          <p role="alert" className="border-t border-border px-4 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </Card>
    </li>
  );
}

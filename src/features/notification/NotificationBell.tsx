import { IonIcon } from '@ionic/react';
import { notificationsOutline } from 'ionicons/icons';
import { useNavigate } from 'react-router-dom';
import { bellLabel, formatUnreadBadge } from './badge';
import { useOptionalNotifications } from './context';
import { notificationsPath } from './link';

/**
 * The shell's notification bell: a button with the unread count, which opens the
 * notification page for this shell (`/app/notifications` or
 * `/org/notifications`). It reads the shell's one `NotificationProvider` and has
 * no state or requests of its own.
 *
 * Outside a provider it renders nothing, so a page that carries the bell in its
 * toolbar still works on its own. (The router is only needed once there IS a
 * provider, which is why the button is its own component.)
 */
export function NotificationBell() {
  const notifications = useOptionalNotifications();
  if (!notifications) {
    return null;
  }
  return <NotificationBellButton path={notificationsPath(notifications.scope)} unreadCount={notifications.unreadCount} />;
}

function NotificationBellButton({ path, unreadCount }: { path: string; unreadCount: number | null }) {
  const navigate = useNavigate();
  const badge = formatUnreadBadge(unreadCount);

  return (
    <button
      type="button"
      aria-label={bellLabel(unreadCount)}
      onClick={() => navigate(path)}
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-text transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <IonIcon icon={notificationsOutline} aria-hidden="true" className="text-2xl" />
      {badge !== null && (
        <span
          aria-hidden="true"
          data-testid="notification-badge"
          className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-primary px-1.5 text-center text-xs font-semibold leading-5 text-white"
        >
          {badge}
        </span>
      )}
    </button>
  );
}

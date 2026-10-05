/** The most the backend counts to; anything at or above it is shown as "99+". */
const BADGE_MAX = 99;

/**
 * What the bell's badge says for an unread count: nothing at 0 (or before the
 * first answer), the exact count from 1 to 99, and "99+" above — the backend
 * stops counting at 100, so it can never say how many more.
 */
export function formatUnreadBadge(unreadCount: number | null): string | null {
  if (unreadCount === null || unreadCount <= 0) {
    return null;
  }
  return unreadCount > BADGE_MAX ? `${BADGE_MAX}+` : String(unreadCount);
}

/** The bell's accessible name, which carries the count so a screen reader gets it too. */
export function bellLabel(unreadCount: number | null): string {
  const badge = formatUnreadBadge(unreadCount);
  if (badge === null || unreadCount === null) {
    return 'Notifications';
  }
  return unreadCount > BADGE_MAX ? 'Notifications, more than 99 unread' : `Notifications, ${unreadCount} unread`;
}

import type { AppNotification, NotificationScope } from './types';

/** The existing organization orders page. There is deliberately no per-order organization page. */
export const ORGANIZATION_ORDERS_PATH = '/org/orders';

/** The notification pages themselves. */
export const CUSTOMER_NOTIFICATIONS_PATH = '/app/notifications';
export const ORGANIZATION_NOTIFICATIONS_PATH = '/org/notifications';

/** Where the bell for this scope goes. */
export function notificationsPath(scope: NotificationScope): string {
  return scope.kind === 'customer' ? CUSTOMER_NOTIFICATIONS_PATH : ORGANIZATION_NOTIFICATIONS_PATH;
}

/**
 * The existing page a notification opens, from the notification's type and
 * order id only — nothing the server sends is ever used as a URL.
 *
 * - customer: the order's own page, `/app/orders/{orderId}`;
 * - organization: the orders list, `/org/orders`.
 */
export function notificationTarget(notification: AppNotification, scope: NotificationScope): string {
  return scope.kind === 'customer'
    ? `/app/orders/${encodeURIComponent(notification.orderId)}`
    : ORGANIZATION_ORDERS_PATH;
}

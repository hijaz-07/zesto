import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { bellLabel, formatUnreadBadge } from './badge';
import {
  isNotificationsForbidden,
  isPermanentNotificationFailure,
  listNotificationsErrorMessage,
  markReadErrorMessage,
  markReadNeedsRefresh,
} from './errors';
import { notificationTarget, notificationsPath } from './link';
import {
  CUSTOMER_NOTIFICATION_TYPES,
  ORGANIZATION_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
  type AppNotification,
  type NotificationScope,
} from './types';

const CUSTOMER: NotificationScope = { kind: 'customer' };
const ORG: NotificationScope = { kind: 'organization', organizationId: 'org-1' };

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'order-1_order_ready.customer',
    type: 'order_ready',
    title: 'Ready for pickup',
    body: 'Your order from Main Canteen is ready for pickup.',
    orderId: 'order-1',
    createdAt: '2026-10-05T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('formatUnreadBadge', () => {
  it.each([[null], [0], [-3]])('shows no badge for %j', (count) => {
    expect(formatUnreadBadge(count)).toBeNull();
  });

  it.each([[1, '1'], [9, '9'], [42, '42'], [99, '99']])('shows the exact count %j', (count, text) => {
    expect(formatUnreadBadge(count)).toBe(text);
  });

  it.each([[100], [101], [5000]])('shows 99+ from %j', (count) => {
    expect(formatUnreadBadge(count)).toBe('99+');
  });
});

describe('bellLabel', () => {
  it('names the bell, with the count when there is one', () => {
    expect(bellLabel(null)).toBe('Notifications');
    expect(bellLabel(0)).toBe('Notifications');
    expect(bellLabel(1)).toBe('Notifications, 1 unread');
    expect(bellLabel(99)).toBe('Notifications, 99 unread');
    expect(bellLabel(100)).toBe('Notifications, more than 99 unread');
  });
});

describe('the notification types', () => {
  it('are the order, cancellation and refund ones, each once — and no order_completed or refund_requested', () => {
    expect([...NOTIFICATION_TYPES]).toEqual([
      'order_confirmed', 'order_preparing', 'order_ready', 'order_picked_up',
      'order_cancelled_by_outlet', 'order_cancelled_by_system', 'refund_completed', 'refund_failed',
      'new_order', 'order_cancelled_by_customer',
    ]);
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
    expect([...CUSTOMER_NOTIFICATION_TYPES]).not.toContain('order_completed');
    expect(NOTIFICATION_TYPES as readonly string[]).not.toContain('refund_requested');
  });

  it('the customer sees an outlet or system cancellation and not their own; the organization sees the customer cancellation', () => {
    expect([...CUSTOMER_NOTIFICATION_TYPES]).toContain('order_cancelled_by_outlet');
    expect([...CUSTOMER_NOTIFICATION_TYPES]).not.toContain('order_cancelled_by_customer');
    expect([...ORGANIZATION_NOTIFICATION_TYPES]).toContain('order_cancelled_by_customer');
    expect([...ORGANIZATION_NOTIFICATION_TYPES]).not.toContain('order_cancelled_by_outlet');
  });
});

describe('deep links', () => {
  it.each(CUSTOMER_NOTIFICATION_TYPES)('a customer %s opens the existing order page', (type) => {
    expect(notificationTarget(notification({ type, orderId: 'abc123' }), CUSTOMER)).toBe('/app/orders/abc123');
  });

  it.each(ORGANIZATION_NOTIFICATION_TYPES)(
    'an organization %s notification opens the existing orders page — there is no per-order organization page',
    (type) => {
      expect(notificationTarget(notification({ type, orderId: 'abc123' }), ORG)).toBe('/org/orders');
    },
  );

  it('builds the path from the order id only, encoded, never from anything else', () => {
    expect(notificationTarget(notification({ orderId: 'a/b?c#d' }), CUSTOMER)).toBe('/app/orders/a%2Fb%3Fc%23d');
  });

  it('the bell goes to the notification page of its own shell', () => {
    expect(notificationsPath(CUSTOMER)).toBe('/app/notifications');
    expect(notificationsPath(ORG)).toBe('/org/notifications');
  });
});

describe('error classification', () => {
  const api = (status: number) => new ApiError(status, 'x', 'raw backend text');

  it('401 and 403 are permanent; nothing else is', () => {
    expect(isPermanentNotificationFailure(api(401))).toBe(true);
    expect(isPermanentNotificationFailure(api(403))).toBe(true);
    for (const status of [400, 404, 409, 500, 503]) {
      expect(isPermanentNotificationFailure(api(status))).toBe(false);
    }
    expect(isPermanentNotificationFailure(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('only 403 is a refusal of access', () => {
    expect(isNotificationsForbidden(api(403))).toBe(true);
    expect(isNotificationsForbidden(api(401))).toBe(false);
  });

  it('a 404 on mark-read means the list is out of date', () => {
    expect(markReadNeedsRefresh(api(404))).toBe(true);
    expect(markReadNeedsRefresh(api(500))).toBe(false);
  });
});

describe('error messages', () => {
  const api = (status: number) => new ApiError(status, 'x', 'Firestore 14 UNAVAILABLE internal detail');

  it.each([
    [401, 'Your session has expired. Please sign in again.'],
    [503, 'Zesto is temporarily unavailable. Please try again in a moment.'],
    [500, 'Something went wrong. Please check your connection and try again.'],
  ])('list: %s', (status, message) => {
    expect(listNotificationsErrorMessage(api(status), CUSTOMER)).toBe(message);
  });

  it('list: 403 differs by inbox', () => {
    expect(listNotificationsErrorMessage(api(403), ORG)).toBe("You don't have access to this organization's notifications.");
    expect(listNotificationsErrorMessage(api(403), CUSTOMER)).toBe("You don't have access to these notifications.");
  });

  it('never surfaces the backend\'s own text or a raw network error', () => {
    for (const error of [api(400), api(404), api(500), new TypeError('Failed to fetch'), 'boom']) {
      expect(listNotificationsErrorMessage(error, CUSTOMER)).not.toMatch(/Firestore|UNAVAILABLE|Failed to fetch/);
      expect(markReadErrorMessage(error)).not.toMatch(/Firestore|UNAVAILABLE|Failed to fetch/);
    }
  });

  it.each([
    [401, 'Your session has expired. Please sign in again.'],
    [403, "You don't have access to these notifications."],
    [404, "This notification couldn't be found. The list has been refreshed."],
    [503, 'Zesto is temporarily unavailable. Please try again in a moment.'],
    [500, "Couldn't mark as read. Please check your connection and try again."],
  ])('mark read: %s', (status, message) => {
    expect(markReadErrorMessage(api(status))).toBe(message);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../lib/api/client';
import { getUnreadCount, listNotifications, markAllNotificationsRead, markNotificationRead } from './api';
import type { NotificationScope } from './types';

vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const CUSTOMER: NotificationScope = { kind: 'customer' };
const ORG: NotificationScope = { kind: 'organization', organizationId: 'org-1' };

const wire = {
  id: 'order-1_order_ready.customer',
  type: 'order_ready',
  title: 'Ready for pickup',
  body: 'Your order from Main Canteen is ready for pickup.',
  orderId: 'order-1',
  createdAt: '2026-10-05T10:00:00.000Z',
  readAt: null,
};

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('which routes each scope calls', () => {
  it.each([
    ['customer', CUSTOMER, '/notifications'],
    ['organization', ORG, '/organizations/org-1/notifications'],
  ])('%s: list, count, mark one and mark all use only that scope\'s routes', async (_label, scope, base) => {
    mockedApiFetch
      .mockResolvedValueOnce({ notifications: [], nextCursor: null })
      .mockResolvedValueOnce({ unreadCount: 0 })
      .mockResolvedValueOnce({ notification: wire })
      .mockResolvedValueOnce({ updated: 0, hasMore: false });

    await listNotifications(scope);
    await getUnreadCount(scope);
    await markNotificationRead(scope, 'abc.customer');
    await markAllNotificationsRead(scope);

    expect(mockedApiFetch.mock.calls.map(([path]) => path)).toEqual([
      base,
      `${base}/unread-count`,
      `${base}/abc.customer/read`,
      `${base}/read-all`,
    ]);
    expect(mockedApiFetch.mock.calls[2][1]).toEqual({ method: 'POST' });
    expect(mockedApiFetch.mock.calls[3][1]).toEqual({ method: 'POST' });
  });

  it('never sends a user, recipient, scope or organization as a parameter or body', async () => {
    mockedApiFetch.mockResolvedValue({ notifications: [], nextCursor: null });

    await listNotifications(ORG, { limit: 20, cursor: 'c1', unread: true });

    const [path, init] = mockedApiFetch.mock.calls[0];
    expect(path).toBe('/organizations/org-1/notifications?limit=20&cursor=c1&unread=true');
    expect(path).not.toMatch(/user|recipient|scope/i);
    expect(init).toBeUndefined();
  });

  it('encodes ids placed in the path', async () => {
    mockedApiFetch.mockResolvedValue({ notification: wire });

    await markNotificationRead(CUSTOMER, 'a/b?c');

    expect(mockedApiFetch.mock.calls[0][0]).toBe('/notifications/a%2Fb%3Fc/read');
  });
});

describe('listNotifications', () => {
  it('omits unread unless asked, and sends only the parameters it was given', async () => {
    mockedApiFetch.mockResolvedValue({ notifications: [], nextCursor: null });

    await listNotifications(CUSTOMER);
    await listNotifications(CUSTOMER, { limit: 20 });
    await listNotifications(CUSTOMER, { unread: false });

    expect(mockedApiFetch.mock.calls.map(([path]) => path)).toEqual([
      '/notifications', '/notifications?limit=20', '/notifications',
    ]);
  });

  it('returns only the approved fields — a field the server adds never gets through', async () => {
    mockedApiFetch.mockResolvedValue({
      notifications: [{
        ...wire,
        scope: 'customer',
        eventId: 'order-1_order_ready',
        organizationId: 'org-1',
        outletId: 'outlet-1',
        userId: 'U-1',
        providerPaymentId: 'pay_X',
        expiresAt: '2027-01-01T00:00:00.000Z',
      }],
      nextCursor: 'next',
    });

    const page = await listNotifications(CUSTOMER);

    expect(page.nextCursor).toBe('next');
    expect(Object.keys(page.notifications[0]).sort()).toEqual(
      ['body', 'createdAt', 'id', 'orderId', 'readAt', 'title', 'type'],
    );
  });

  it('skips a type the app does not show — in particular order_completed — without failing the page', async () => {
    mockedApiFetch.mockResolvedValue({
      notifications: [
        { ...wire, id: 'a', type: 'order_completed' },
        { ...wire, id: 'b', type: 'something_new' },
        { ...wire, id: 'c', type: 'new_order' },
      ],
      nextCursor: null,
    });

    const page = await listNotifications(ORG);

    expect(page.notifications.map((notification) => notification.id)).toEqual(['c']);
  });

  it.each([
    'order_cancelled_by_outlet', 'order_cancelled_by_system', 'order_cancelled_by_customer', 'refund_completed', 'refund_failed',
  ])('parses the cancellation/refund type %s, keeping only the approved fields', async (type) => {
    mockedApiFetch.mockResolvedValue({
      notifications: [{ ...wire, id: 'x', type, internal: 'refund-secret', refundId: 'ord-r1' }],
      nextCursor: null,
    });

    const page = await listNotifications(CUSTOMER);

    expect(page.notifications.map((notification) => notification.type)).toEqual([type]);
    expect(Object.keys(page.notifications[0]).sort()).toEqual(
      ['body', 'createdAt', 'id', 'orderId', 'readAt', 'title', 'type'],
    );
  });

  it('still skips refund_requested: it is consumed by the backend and never shown', async () => {
    mockedApiFetch.mockResolvedValue({
      notifications: [{ ...wire, id: 'r', type: 'refund_requested' }],
      nextCursor: null,
    });

    expect((await listNotifications(CUSTOMER)).notifications).toEqual([]);
  });

  it.each([
    ['not an object', 'nope'],
    ['no notifications array', { nextCursor: null }],
    ['a bad cursor', { notifications: [], nextCursor: 5 }],
    ['an entry that is not an object', { notifications: ['x'], nextCursor: null }],
    ['an entry without a title', { notifications: [{ ...wire, title: undefined }], nextCursor: null }],
    ['an entry with a numeric readAt', { notifications: [{ ...wire, readAt: 5 }], nextCursor: null }],
    ['an entry without an order id', { notifications: [{ ...wire, orderId: undefined }], nextCursor: null }],
  ])('rejects %s as an invalid response', async (_label, data) => {
    mockedApiFetch.mockResolvedValue(data);

    const error = await listNotifications(CUSTOMER).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('invalid_response');
  });

  it('passes the backend\'s own failures through', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(403, 'permission_denied', 'no'));

    await expect(listNotifications(ORG)).rejects.toMatchObject({ status: 403 });
  });
});

describe('getUnreadCount', () => {
  it('returns the backend\'s number', async () => {
    mockedApiFetch.mockResolvedValue({ unreadCount: 7 });

    expect(await getUnreadCount(CUSTOMER)).toBe(7);
  });

  it.each([[undefined], [{}], [{ unreadCount: '7' }], [{ unreadCount: -1 }], [{ unreadCount: 1.5 }], [null]])(
    'rejects %j', async (data) => {
      mockedApiFetch.mockResolvedValue(data);

      await expect(getUnreadCount(CUSTOMER)).rejects.toMatchObject({ code: 'invalid_response' });
    });
});

describe('markNotificationRead', () => {
  it('returns the backend\'s own copy of the notification', async () => {
    mockedApiFetch.mockResolvedValue({ notification: { ...wire, readAt: '2026-10-05T11:00:00.000Z' } });

    expect(await markNotificationRead(CUSTOMER, wire.id)).toEqual({ ...wire, readAt: '2026-10-05T11:00:00.000Z' });
  });

  it.each([[undefined], [{}], [{ notification: 'x' }], [{ notification: { ...wire, type: 'order_completed' } }]])(
    'rejects %j', async (data) => {
      mockedApiFetch.mockResolvedValue(data);

      await expect(markNotificationRead(CUSTOMER, wire.id)).rejects.toMatchObject({ code: 'invalid_response' });
    });
});

describe('markAllNotificationsRead', () => {
  it('returns the backend\'s updated count and hasMore', async () => {
    mockedApiFetch.mockResolvedValue({ updated: 4, hasMore: true });

    expect(await markAllNotificationsRead(CUSTOMER)).toEqual({ updated: 4, hasMore: true });
  });

  it.each([[undefined], [{ updated: 1 }], [{ updated: '1', hasMore: false }], [{ updated: -1, hasMore: false }]])(
    'rejects %j', async (data) => {
      mockedApiFetch.mockResolvedValue(data);

      await expect(markAllNotificationsRead(CUSTOMER)).rejects.toMatchObject({ code: 'invalid_response' });
    });
});

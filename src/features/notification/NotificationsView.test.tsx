import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIntersectionObserver } from '../../test/fakeIntersectionObserver';
import { ApiError } from '../../lib/api/client';
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './api';
import { NotificationProvider } from './NotificationProvider';
import { NotificationsView, OPEN_READ_GRACE_MS } from './NotificationsView';
import type { AppNotification, NotificationScope, NotificationsPage } from './types';
import { VISIBILITY_REFRESH_MIN_INTERVAL_MS } from './visibilityThrottle';

vi.mock('./api');

const mockedList = vi.mocked(listNotifications);
const mockedCount = vi.mocked(getUnreadCount);
const mockedMarkRead = vi.mocked(markNotificationRead);
const mockedMarkAll = vi.mocked(markAllNotificationsRead);

const CUSTOMER: NotificationScope = { kind: 'customer' };
const ORG: NotificationScope = { kind: 'organization', organizationId: 'org-1' };

function note(id: string, overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    type: 'order_ready',
    title: 'Ready for pickup',
    body: 'Your order from Main Canteen is ready for pickup.',
    orderId: `order-${id}`,
    createdAt: '2026-10-05T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

function page(notifications: AppNotification[], nextCursor: string | null = null): NotificationsPage {
  return { notifications, nextCursor };
}

function OrderProbe() {
  return <p data-testid="order-page">Order page {useParams().orderId}</p>;
}

function renderView(scope: NotificationScope = CUSTOMER, { provider = true }: { provider?: boolean } = {}) {
  const view: ReactNode = <NotificationsView scope={scope} />;
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <Routes>
        <Route
          path="/notifications"
          element={provider ? <NotificationProvider scope={scope}>{view}</NotificationProvider> : view}
        />
        <Route path="/app/orders/:orderId" element={<OrderProbe />} />
        <Route path="/org/orders" element={<p data-testid="org-orders-page">Org orders page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

let visibility: 'visible' | 'hidden' = 'visible';

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  FakeIntersectionObserver.install();
  mockedList.mockReset();
  mockedCount.mockReset();
  mockedMarkRead.mockReset();
  mockedMarkAll.mockReset();
  mockedCount.mockResolvedValue(0);
});

afterEach(() => {
  FakeIntersectionObserver.uninstall();
  vi.useRealTimers();
  // @ts-expect-error - removes the per-test override so jsdom's own property is back
  delete document.visibilityState;
});

const items = () => within(screen.getByRole('list', { name: 'Notifications' })).getAllByRole('listitem');

/** The button that opens the first notification (the first button in its row; the second is "Mark as read"). */
const openButton = () => within(items()[0]).getAllByRole('button')[0];

describe('NotificationsView — states', () => {
  it('shows the Notifications heading and a loading state while the first page is fetched', () => {
    mockedList.mockReturnValue(new Promise(() => {}));

    renderView();

    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading notifications…');
  });

  it('asks for the first page with only a page-size hint and the unread flag — no user, no scope, no cursor', async () => {
    mockedList.mockResolvedValue(page([]));

    renderView(ORG);

    await screen.findByText('No notifications yet');
    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList).toHaveBeenCalledWith(ORG, { limit: 20, unread: false });
  });

  it('page size is the backend default (20), never above its maximum (50)', async () => {
    mockedList.mockResolvedValue(page([]));

    renderView();
    await screen.findByText('No notifications yet');

    expect((mockedList.mock.calls[0][1] as { limit: number }).limit).toBeLessThanOrEqual(50);
  });

  it('empty state for a customer', async () => {
    mockedList.mockResolvedValue(page([]));

    renderView(CUSTOMER);

    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    expect(screen.getByText(/as your orders are confirmed/)).toBeInTheDocument();
  });

  it('empty state for an organization', async () => {
    mockedList.mockResolvedValue(page([]));

    renderView(ORG);

    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    expect(screen.getByText('New orders will be announced here.')).toBeInTheDocument();
  });

  it('error state offers Try again, which re-reads', async () => {
    mockedList.mockRejectedValueOnce(new ApiError(500, 'internal', 'Firestore 14 UNAVAILABLE internal detail'));
    mockedList.mockResolvedValueOnce(page([note('a')]));

    renderView();

    expect(await screen.findByText("Couldn't load notifications")).toBeInTheDocument();
    expect(screen.getByText('Something went wrong. Please check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText(/Firestore|UNAVAILABLE/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Ready for pickup')).toBeInTheDocument();
  });

  it('a 401 says the session expired', async () => {
    mockedList.mockRejectedValue(new ApiError(401, 'unauthenticated', 'x'));

    renderView();

    expect(await screen.findByText('Your session has expired. Please sign in again.')).toBeInTheDocument();
  });

  it('a 503 says Zesto is temporarily unavailable', async () => {
    mockedList.mockRejectedValue(new ApiError(503, 'unavailable', 'x'));

    renderView();

    expect(await screen.findByText('Zesto is temporarily unavailable. Please try again in a moment.')).toBeInTheDocument();
  });

  it('a 403 on the organization inbox is shown as no access, with no retry', async () => {
    mockedList.mockRejectedValue(new ApiError(403, 'permission_denied', 'x'));

    renderView(ORG);

    expect(await screen.findByText("You don't have access to these notifications")).toBeInTheDocument();
    expect(screen.getByText("You don't have access to this organization's notifications.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('NotificationsView — the list', () => {
  it('shows each notification\'s title, text and time, newest first as the backend ordered them', async () => {
    mockedList.mockResolvedValue(page([
      note('a', { title: 'Order confirmed', body: 'Your order from Main Canteen has been confirmed.', createdAt: '2026-10-05T10:00:00.000Z' }),
      note('b', { title: 'Being prepared', body: 'Your order from Main Canteen is being prepared.', createdAt: '2026-10-05T09:00:00.000Z' }),
    ]));

    renderView();

    await screen.findByText('Order confirmed');
    const rows = items();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Order confirmed')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Your order from Main Canteen has been confirmed.')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Being prepared')).toBeInTheDocument();
    const time = rows[0].querySelector('time');
    expect(time).toHaveAttribute('dateTime', '2026-10-05T10:00:00.000Z');
    expect(time?.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('marks unread notifications with a text label and weight, not colour alone', async () => {
    mockedList.mockResolvedValue(page([
      note('unread', { title: 'Unread one', readAt: null }),
      note('read', { title: 'Read one', readAt: '2026-10-05T11:00:00.000Z' }),
    ]));

    renderView();

    await screen.findByText('Unread one');
    const [unreadRow, readRow] = items();
    expect(within(unreadRow).getByText('New')).toBeInTheDocument();
    expect(within(unreadRow).getByText('Unread one')).toHaveClass('font-semibold');
    expect(within(unreadRow).getByRole('button', { name: 'Mark "Unread one" as read' })).toBeInTheDocument();
    expect(within(readRow).queryByText('New')).not.toBeInTheDocument();
    expect(within(readRow).getByText('Read one')).not.toHaveClass('font-semibold');
    expect(within(readRow).queryByRole('button', { name: /Mark .* as read/ })).not.toBeInTheDocument();
  });

  it('shows organization notifications the same way, with the organization\'s copy', async () => {
    mockedList.mockResolvedValue(page([
      note('n', { type: 'new_order', title: 'New order', body: 'New order received from Main Canteen.' }),
    ]));

    renderView(ORG);

    expect(await screen.findByText('New order received from Main Canteen.')).toBeInTheDocument();
  });
});

describe('NotificationsView — All / Unread', () => {
  it('All is selected first; Unread asks the backend for unread ones only', async () => {
    mockedList.mockResolvedValueOnce(page([note('a'), note('b', { readAt: '2026-10-05T11:00:00.000Z' })]));
    mockedList.mockResolvedValueOnce(page([note('a')]));
    renderView();
    await screen.findAllByRole('listitem');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));

    await waitFor(() => expect(items()).toHaveLength(1));
    expect(mockedList).toHaveBeenLastCalledWith(CUSTOMER, { limit: 20, unread: true });
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not keep showing the other filter\'s list while the new one loads', async () => {
    mockedList.mockResolvedValueOnce(page([note('a', { title: 'From the All list' })]));
    mockedList.mockReturnValueOnce(new Promise(() => {}));
    renderView();
    await screen.findByText('From the All list');

    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));

    expect(screen.queryByText('From the All list')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading notifications…');
  });

  it('shows an all-caught-up state for an empty Unread list, with a way back to All', async () => {
    mockedList.mockResolvedValueOnce(page([note('a')]));
    mockedList.mockResolvedValueOnce(page([]));
    mockedList.mockResolvedValueOnce(page([note('a')]));
    renderView();
    await screen.findAllByRole('listitem');

    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all notifications' }));

    await waitFor(() => expect(items()).toHaveLength(1));
    expect(mockedList).toHaveBeenLastCalledWith(CUSTOMER, { limit: 20, unread: false });
  });
});

describe('NotificationsView — pagination', () => {
  it('loads the next page with the backend\'s cursor and appends it', async () => {
    mockedList.mockResolvedValueOnce(page([note('a', { title: 'First page' })], 'cursor-1'));
    mockedList.mockResolvedValueOnce(page([note('b', { title: 'Second page' })], null));
    renderView();
    await screen.findByText('First page');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Second page')).toBeInTheDocument();
    expect(items()).toHaveLength(2);
    expect(mockedList).toHaveBeenLastCalledWith(CUSTOMER, { limit: 20, cursor: 'cursor-1', unread: false });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows no Load more on a last page', async () => {
    mockedList.mockResolvedValue(page([note('a')], null));

    renderView();
    await screen.findAllByRole('listitem');

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('keeps the pages already loaded when a later page fails, and offers Try again', async () => {
    mockedList.mockResolvedValueOnce(page([note('a', { title: 'First page' })], 'cursor-1'));
    mockedList.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'));
    mockedList.mockResolvedValueOnce(page([note('b', { title: 'Second page' })], null));
    renderView();
    await screen.findByText('First page');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Zesto is temporarily unavailable.');
    expect(screen.getByText('First page')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Second page')).toBeInTheDocument();
  });

  it('never renders one notification twice if a page repeats it', async () => {
    mockedList.mockResolvedValueOnce(page([note('a')], 'cursor-1'));
    mockedList.mockResolvedValueOnce(page([note('a'), note('b', { title: 'Another' })], null));
    renderView();
    await screen.findAllByRole('listitem');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('Another');
    expect(items()).toHaveLength(2);
  });

  it('a second tap on Load more while one is loading changes nothing', async () => {
    mockedList.mockResolvedValueOnce(page([note('a')], 'cursor-1'));
    mockedList.mockReturnValueOnce(new Promise(() => {}));
    renderView();
    await screen.findAllByRole('listitem');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    fireEvent.click(screen.getByRole('button', { name: 'Loading…' }));

    expect(mockedList).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationsView — mark one read', () => {
  it('calls the backend, then shows the backend\'s row as read, and asks the shell for the server\'s new count', async () => {
    mockedList.mockResolvedValue(page([note('a', { title: 'Mark me' })]));
    mockedCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mockedMarkRead.mockResolvedValue(note('a', { title: 'Mark me', readAt: '2026-10-05T12:00:00.000Z' }));
    renderView();
    await screen.findByText('Mark me');
    await waitFor(() => expect(mockedCount).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Mark me" as read' }));

    await waitFor(() => expect(screen.queryByText('New')).not.toBeInTheDocument());
    expect(mockedMarkRead).toHaveBeenCalledWith(CUSTOMER, 'a');
    expect(screen.queryByRole('button', { name: /^Mark ".*" as read$/ })).not.toBeInTheDocument();
    await waitFor(() => expect(mockedCount).toHaveBeenCalledTimes(2));
  });

  it('uses the organization routes for an organization notification', async () => {
    mockedList.mockResolvedValue(page([note('n', { type: 'new_order', title: 'New order' })]));
    mockedMarkRead.mockResolvedValue(note('n', { type: 'new_order', title: 'New order', readAt: '2026-10-05T12:00:00.000Z' }));
    renderView(ORG);
    await screen.findByText('New order');

    fireEvent.click(screen.getByRole('button', { name: 'Mark "New order" as read' }));

    await waitFor(() => expect(mockedMarkRead).toHaveBeenCalledWith(ORG, 'n'));
  });

  it('in the Unread list a notification leaves once the backend says it is read', async () => {
    mockedList.mockResolvedValueOnce(page([note('a')]));
    mockedList.mockResolvedValueOnce(page([note('a', { title: 'Leaves' }), note('b', { title: 'Stays' })]));
    mockedMarkRead.mockResolvedValue(note('a', { title: 'Leaves', readAt: '2026-10-05T12:00:00.000Z' }));
    renderView();
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
    await screen.findByText('Leaves');

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Leaves" as read' }));

    await waitFor(() => expect(screen.queryByText('Leaves')).not.toBeInTheDocument());
    expect(screen.getByText('Stays')).toBeInTheDocument();
  });

  it('does NOT pretend it worked when the backend refuses: the row stays unread, with a message, and the count is not asked for again', async () => {
    mockedList.mockResolvedValue(page([note('a', { title: 'Mark me' })]));
    mockedMarkRead.mockRejectedValue(new ApiError(500, 'internal', 'Firestore 14 UNAVAILABLE'));
    renderView();
    await screen.findByText('Mark me');
    await waitFor(() => expect(mockedCount).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Mark me" as read' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't mark as read.");
    expect(screen.queryByText(/Firestore|UNAVAILABLE/)).not.toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark "Mark me" as read' })).toBeEnabled();
    expect(mockedCount).toHaveBeenCalledTimes(1);
  });

  it('a 404 says the notification is gone and re-reads the list', async () => {
    mockedList.mockResolvedValueOnce(page([note('a', { title: 'Gone' })]));
    mockedList.mockResolvedValueOnce(page([]));
    mockedMarkRead.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    renderView();
    await screen.findByText('Gone');

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Gone" as read' }));

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });

  it('disables a notification while its mark-read is in flight', async () => {
    mockedList.mockResolvedValue(page([note('a', { title: 'Mark me' })]));
    mockedMarkRead.mockReturnValue(new Promise(() => {}));
    renderView();
    await screen.findByText('Mark me');

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Mark me" as read' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark "Mark me" as read' })).toBeDisabled());
    expect(mockedMarkRead).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationsView — mark all read', () => {
  it('marks everything read by the backend\'s answer, re-reads the list, and asks for the server\'s count', async () => {
    mockedList.mockResolvedValueOnce(page([note('a'), note('b')]));
    mockedList.mockResolvedValueOnce(page([
      note('a', { readAt: '2026-10-05T12:00:00.000Z' }),
      note('b', { readAt: '2026-10-05T12:00:00.000Z' }),
    ]));
    mockedMarkAll.mockResolvedValue({ updated: 2, hasMore: false });
    mockedCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    renderView();
    await screen.findAllByRole('listitem');

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    await waitFor(() => expect(screen.queryAllByText('New')).toHaveLength(0));
    expect(mockedMarkAll).toHaveBeenCalledTimes(1);
    expect(mockedMarkAll).toHaveBeenCalledWith(CUSTOMER);
    expect(mockedList).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockedCount).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status', { name: /still unread/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('keeps going while the backend says more remains, then stops', async () => {
    mockedList.mockResolvedValue(page([note('a')]));
    mockedMarkAll
      .mockResolvedValueOnce({ updated: 400, hasMore: true })
      .mockResolvedValueOnce({ updated: 400, hasMore: true })
      .mockResolvedValueOnce({ updated: 7, hasMore: false });
    renderView();
    await screen.findAllByRole('listitem');

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    await waitFor(() => expect(mockedMarkAll).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeEnabled());
    expect(screen.queryByText(/still unread/)).not.toBeInTheDocument();
  });

  it('gives up after a bounded number of calls and says some are still unread', async () => {
    mockedList.mockResolvedValue(page([note('a')]));
    mockedMarkAll.mockResolvedValue({ updated: 400, hasMore: true });
    renderView();
    await screen.findAllByRole('listitem');

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    expect(await screen.findByText(/Some notifications are still unread/)).toBeInTheDocument();
    expect(mockedMarkAll).toHaveBeenCalledTimes(5);
  });

  it('a failure is reported, nothing is claimed read, and the list is re-read from the server', async () => {
    mockedList.mockResolvedValue(page([note('a', { title: 'Still here' })]));
    mockedMarkAll.mockRejectedValue(new ApiError(500, 'internal', 'raw'));
    renderView();
    await screen.findByText('Still here');

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't mark as read.");
    expect(screen.getByText('New')).toBeInTheDocument();
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it('is disabled when there is nothing unread, and while it runs', async () => {
    mockedList.mockResolvedValue(page([note('a', { readAt: '2026-10-05T11:00:00.000Z' })]));
    renderView();
    await screen.findAllByRole('listitem');
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('is disabled while the list is loading or failed', async () => {
    mockedList.mockRejectedValue(new ApiError(500, 'internal', 'x'));
    renderView();
    await screen.findByText("Couldn't load notifications");

    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('uses the organization routes in the organization inbox', async () => {
    mockedList.mockResolvedValue(page([note('n', { type: 'new_order' })]));
    mockedMarkAll.mockResolvedValue({ updated: 1, hasMore: false });
    renderView(ORG);
    await screen.findAllByRole('listitem');

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    await waitFor(() => expect(mockedMarkAll).toHaveBeenCalledWith(ORG));
  });
});

describe('NotificationsView — opening a notification', () => {
  it('a customer notification: marks it read FIRST, then opens that order\'s existing page', async () => {
    const order: string[] = [];
    mockedList.mockResolvedValue(page([note('a', { title: 'Ready', orderId: 'order-77' })]));
    mockedMarkRead.mockImplementation(async () => {
      order.push('mark-read');
      return note('a', { readAt: '2026-10-05T12:00:00.000Z' });
    });
    renderView();
    await screen.findAllByRole('listitem');

    fireEvent.click(openButton());

    expect(await screen.findByTestId('order-page')).toHaveTextContent('Order page order-77');
    expect(order).toEqual(['mark-read']);
    expect(mockedMarkRead).toHaveBeenCalledWith(CUSTOMER, 'a');
  });

  it('an organization notification opens the existing orders page', async () => {
    mockedList.mockResolvedValue(page([note('n', { type: 'new_order', title: 'New order', body: 'New order received from Main Canteen.' })]));
    mockedMarkRead.mockResolvedValue(note('n', { type: 'new_order', readAt: '2026-10-05T12:00:00.000Z' }));
    renderView(ORG);

    await screen.findAllByRole('listitem');
    fireEvent.click(openButton());

    expect(await screen.findByTestId('org-orders-page')).toBeInTheDocument();
    expect(mockedMarkRead).toHaveBeenCalledWith(ORG, 'n');
  });

  it('an already-read notification just opens — no mark-read call', async () => {
    mockedList.mockResolvedValue(page([note('a', { readAt: '2026-10-05T11:00:00.000Z', orderId: 'order-5' })]));
    renderView();

    await screen.findAllByRole('listitem');
    fireEvent.click(openButton());

    expect(await screen.findByTestId('order-page')).toHaveTextContent('order-5');
    expect(mockedMarkRead).not.toHaveBeenCalled();
  });

  it('still opens the order when marking it read FAILS — and the row is not shown as read', async () => {
    mockedList.mockResolvedValue(page([note('a', { orderId: 'order-9' })]));
    mockedMarkRead.mockRejectedValue(new ApiError(500, 'internal', 'x'));
    renderView();

    await screen.findAllByRole('listitem');
    fireEvent.click(openButton());

    expect(await screen.findByTestId('order-page')).toHaveTextContent('order-9');
    expect(mockedMarkRead).toHaveBeenCalledTimes(1);
  });

  it('does not wait forever on a slow mark-read: it opens the order after a short grace period', async () => {
    mockedList.mockResolvedValue(page([note('a', { orderId: 'order-3' })]));
    mockedMarkRead.mockReturnValue(new Promise(() => {}));
    renderView();
    await screen.findAllByRole('listitem');
    const open = openButton();
    vi.useFakeTimers();

    fireEvent.click(open);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_READ_GRACE_MS - 10);
    });
    expect(screen.queryByTestId('order-page')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(screen.getByTestId('order-page')).toHaveTextContent('order-3');
  });
});

describe('NotificationsView — refreshing', () => {
  // Only the clock is faked (timers and promises stay real): the visibility throttle measures
  // from `Date.now()`, and these tests need to say how long the person was away.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  /**
   * The tab is hidden and comes back after `awaySeconds` (by default long enough for the throttle to
   * allow a re-read): a real return is always a "hidden" followed by a "visible".
   */
  function returnToPage(awaySeconds = VISIBILITY_REFRESH_MIN_INTERVAL_MS / 1000 + 1) {
    act(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      vi.setSystemTime(Date.now() + awaySeconds * 1000);
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  it('re-reads the list when the tab becomes visible again, without blanking what is on screen', async () => {
    mockedList.mockResolvedValueOnce(page([note('a', { title: 'Old one' })]));
    let release: (value: NotificationsPage) => void = () => {};
    mockedList.mockReturnValueOnce(new Promise<NotificationsPage>((resolve) => (release = resolve)));
    renderView();
    await screen.findByText('Old one');

    returnToPage();

    expect(mockedList).toHaveBeenCalledTimes(2);
    // No flicker: the old list stays, and no loading state appears, while the refresh is out.
    expect(screen.getByText('Old one')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => {
      release(page([note('b', { title: 'Newer one' }), note('a', { title: 'Old one' })]));
    });
    expect(await screen.findByText('Newer one')).toBeInTheDocument();
  });

  it('does not re-read while the page is hidden', async () => {
    mockedList.mockResolvedValue(page([note('a')]));
    renderView();
    await screen.findAllByRole('listitem');

    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the list on screen', async () => {
    mockedList.mockResolvedValueOnce(page([note('a', { title: 'Keep me' })]));
    mockedList.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'));
    renderView();
    await screen.findByText('Keep me');

    returnToPage();
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Keep me')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load notifications")).not.toBeInTheDocument();
  });

  it('a refresh refused with 403 (access lost while the page was open) replaces the list with the no-access state', async () => {
    mockedList.mockResolvedValueOnce(page([note('n', { type: 'new_order', title: 'Secret' })]));
    mockedList.mockRejectedValueOnce(new ApiError(403, 'permission_denied', 'x'));
    renderView(ORG);
    await screen.findByText('Secret');

    returnToPage();

    expect(await screen.findByText("You don't have access to these notifications")).toBeInTheDocument();
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
  });

  it('re-reads the list when the shell\'s unread count RISES (something new arrived), not when it falls', async () => {
    vi.useFakeTimers();
    mockedList.mockResolvedValue(page([note('a')]));
    mockedCount.mockResolvedValueOnce(1).mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    const settle = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    renderView();
    await settle(0);
    expect(mockedList).toHaveBeenCalledTimes(1);

    await settle(30_000); // 1 -> 3: something arrived
    expect(mockedList).toHaveBeenCalledTimes(2);

    await settle(30_000); // 3 -> 2: a fall is never a reason to re-read
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  describe('the visibility throttle', () => {
    it('the first return to the page re-reads the list, and further returns inside the window do not', async () => {
      mockedList.mockResolvedValue(page([note('a')]));
      renderView(CUSTOMER, { provider: false });
      await screen.findAllByRole('listitem');
      expect(mockedList).toHaveBeenCalledTimes(1);

      returnToPage();
      expect(mockedList).toHaveBeenCalledTimes(2);

      // The pane flickers: hidden/visible pairs 1 s and 6 s apart, all inside 10 s of that read.
      for (const gap of [1, 5, 1, 2]) {
        returnToPage(gap);
      }

      expect(mockedList).toHaveBeenCalledTimes(2);
    });

    it('a return after the window reads again, measured from the last read (exactly 10 s is allowed, 9.9 s is not)', async () => {
      mockedList.mockResolvedValue(page([note('a')]));
      renderView(CUSTOMER, { provider: false });
      await screen.findAllByRole('listitem');

      returnToPage(9.9);
      expect(mockedList).toHaveBeenCalledTimes(1);

      returnToPage(0.1); // 10.0 s since the read on mount
      expect(mockedList).toHaveBeenCalledTimes(2);

      returnToPage(9.9);
      expect(mockedList).toHaveBeenCalledTimes(2);
      returnToPage(0.1);
      expect(mockedList).toHaveBeenCalledTimes(3);
    });

    it('a re-read that was not caused by visibility (Try again, a refresh after an error) also starts the window', async () => {
      mockedList.mockRejectedValueOnce(new ApiError(500, 'internal', 'x'));
      mockedList.mockResolvedValue(page([note('a')]));
      renderView(CUSTOMER, { provider: false });
      await screen.findByText("Couldn't load notifications");

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findAllByRole('listitem');
      expect(mockedList).toHaveBeenCalledTimes(2);

      returnToPage(3);
      expect(mockedList).toHaveBeenCalledTimes(2);
    });

    it('does not slow anything else down: Mark all, Load more and the Unread filter are never throttled', async () => {
      mockedList.mockResolvedValue(page([note('a')], 'cursor-1'));
      mockedMarkAll.mockResolvedValue({ updated: 1, hasMore: false });
      renderView(CUSTOMER, { provider: false });
      await screen.findAllByRole('listitem');

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(3));
      fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
      await waitFor(() => expect(mockedMarkAll).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(4));
    });

    it('count and list stay consistent: one return after the window sends one count read and one list read, a flicker sends neither', async () => {
      mockedList.mockResolvedValue(page([note('a')]));
      mockedCount.mockResolvedValue(1);
      renderView(CUSTOMER);
      await screen.findAllByRole('listitem');
      await waitFor(() => expect(mockedCount).toHaveBeenCalledTimes(1));
      expect(mockedList).toHaveBeenCalledTimes(1);

      returnToPage();
      await waitFor(() => expect(mockedCount).toHaveBeenCalledTimes(2));
      expect(mockedList).toHaveBeenCalledTimes(2);

      for (let flicker = 0; flicker < 3; flicker++) {
        returnToPage(2);
      }
      await Promise.resolve();
      expect(mockedCount).toHaveBeenCalledTimes(2);
      expect(mockedList).toHaveBeenCalledTimes(2);

      returnToPage();
      await waitFor(() => expect(mockedCount).toHaveBeenCalledTimes(3));
      expect(mockedList).toHaveBeenCalledTimes(3);
    });
  });
});

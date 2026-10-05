import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api/client';
import { FakeIntersectionObserver } from '../../test/fakeIntersectionObserver';
import { NotificationBell } from './NotificationBell';
import { NotificationProvider } from './NotificationProvider';
import { NotificationsView } from './NotificationsView';
import type { NotificationScope } from './types';

/**
 * The notification UI together with the REAL API layer (`./api`), with only the
 * HTTP client stubbed: what a screen shows of what the server sent, and which
 * routes each inbox calls.
 */
vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const CUSTOMER: NotificationScope = { kind: 'customer' };
const ORG: NotificationScope = { kind: 'organization', organizationId: 'org-1' };

const SECRETS = {
  eventId: 'order-SECRETEVENT_order_ready',
  scope: 'org:org-SECRETORG',
  organizationId: 'org-SECRETORG',
  outletId: 'outlet-SECRETOUTLET',
  userId: 'U-SECRETUSER',
  recipientId: 'U-SECRETRECIPIENT',
  providerPaymentId: 'pay_SECRETPAYMENT',
  razorpayOrderId: 'order_SECRETRAZORPAY',
  qrPayload: 'ZP1.SECRETQR.SECRETPROOF',
  pickupCode: 'SECRET-CODE',
  readBy: 'U-SECRETAUDIT',
  expiresAt: '2027-01-01T00:00:00.000Z',
};

function wire(id: string, overrides: Record<string, unknown> = {}) {
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

function renderApp(scope: NotificationScope) {
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <NotificationProvider scope={scope}>
        <NotificationBell />
        <Routes>
          <Route path="/notifications" element={<NotificationsView scope={scope} />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </NotificationProvider>
    </MemoryRouter>,
  );
}

/** Answers every notification route the way the backend does, recording what was asked. */
function backend(pages: Record<string, unknown>[][] = [[wire('a')]], unreadCount = 1) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  mockedApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.includes('/unread-count')) {
      return { unreadCount };
    }
    if (path.endsWith('/read-all')) {
      return { updated: 1, hasMore: false };
    }
    if (path.endsWith('/read')) {
      return { notification: wire('a', { readAt: '2026-10-05T12:00:00.000Z' }) };
    }
    const cursor = new URLSearchParams(path.split('?')[1] ?? '').get('cursor');
    const index = cursor === null ? 0 : Number(cursor);
    return { notifications: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
  });
  return calls;
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  FakeIntersectionObserver.install();
});

afterEach(() => {
  FakeIntersectionObserver.uninstall();
});

describe('privacy: what a notification screen renders', () => {
  it('shows only title, text and time — never an id, scope, organization, user, audit, provider or credential field', async () => {
    backend([[
      wire('a', { ...SECRETS, orderId: 'ORDSECRETA' }),
      wire('b', { ...SECRETS, orderId: 'ORDSECRETB', readAt: '2026-10-05T11:00:00.000Z' }),
    ]]);

    const { container } = renderApp(CUSTOMER);
    await screen.findAllByRole('listitem');

    const html = container.innerHTML;
    for (const secret of [...Object.values(SECRETS), 'ORDSECRETA', 'ORDSECRETB']) {
      expect(html).not.toContain(secret);
    }
    // …and the notification's own id (which embeds an event id) is not rendered either.
    expect(html).not.toContain('"a"');
    expect(container).toHaveTextContent('Ready for pickup');
    expect(container).toHaveTextContent('Your order from Main Canteen is ready for pickup.');
  });

  it('shows the same restraint for the organization inbox', async () => {
    backend([[wire('n', { ...SECRETS, orderId: 'ORDSECRETN', type: 'new_order', title: 'New order', body: 'New order received from Main Canteen.' })]]);

    const { container } = renderApp(ORG);
    await screen.findByText('New order received from Main Canteen.');

    for (const secret of [...Object.values(SECRETS), 'ORDSECRETN']) {
      expect(container.innerHTML).not.toContain(secret);
    }
  });

  it('never shows an order_completed notification, even if a backend were to send one', async () => {
    backend([[
      wire('done', { type: 'order_completed', title: 'Order complete', body: 'Your order is complete.' }),
      wire('ok', { title: 'Ready for pickup' }),
    ]]);

    renderApp(CUSTOMER);
    await screen.findByText('Ready for pickup');

    expect(screen.queryByText('Order complete')).not.toBeInTheDocument();
    expect(screen.queryByText('Your order is complete.')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows the backend\'s copy as written — no invented order number', async () => {
    backend([[wire('a')]]);

    const { container } = renderApp(CUSTOMER);
    await screen.findByText('Your order from Main Canteen is ready for pickup.');

    expect(container.textContent).not.toMatch(/#|order-a|Order \d/);
  });
});

describe('customer and organization inboxes never cross', () => {
  async function exerciseEverything(scope: NotificationScope) {
    const calls = backend([[wire('a')], [wire('b', { title: 'Second page' })]], 2);
    renderApp(scope);
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Second page');
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
    await waitFor(() => expect(calls.some((call) => call.path.includes('unread=true'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Mark "Ready for pickup" as read' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/a/read'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/read-all'))).toBe(true));
    return calls;
  }

  it('the customer UI calls only /notifications…, never an organization route', async () => {
    const calls = await exerciseEverything(CUSTOMER);

    expect(calls.length).toBeGreaterThan(5);
    for (const { path } of calls) {
      expect(path).toMatch(/^\/notifications(\/|\?|$)/);
      expect(path).not.toContain('/organizations');
    }
  });

  it('the organization UI calls only /organizations/org-1/notifications…, never a customer route', async () => {
    const calls = await exerciseEverything(ORG);

    expect(calls.length).toBeGreaterThan(5);
    for (const { path } of calls) {
      expect(path).toMatch(/^\/organizations\/org-1\/notifications(\/|\?|$)/);
    }
  });

  it.each([
    ['customer', CUSTOMER],
    ['organization', ORG],
  ])('the %s UI sends no user, recipient or scope — in a path, a query or a body', async (_label, scope) => {
    const calls = await exerciseEverything(scope);

    for (const { path, init } of calls) {
      expect(path).not.toMatch(/user|recipient|scope/i);
      if (init !== undefined) {
        expect(init).toEqual({ method: 'POST' });
        expect(init.body).toBeUndefined();
      }
    }
  });

  it('the customer UI takes no user from the URL, a query string or storage', async () => {
    window.localStorage.setItem('userId', 'U-FROM-STORAGE');
    const calls = backend([[wire('a')]]);
    render(
      <MemoryRouter initialEntries={['/notifications?userId=U-FROM-URL&scope=org:x']}>
        <NotificationProvider scope={CUSTOMER}>
          <Routes>
            <Route path="/notifications" element={<NotificationsView scope={CUSTOMER} />} />
          </Routes>
        </NotificationProvider>
      </MemoryRouter>,
    );
    await screen.findAllByRole('listitem');

    for (const { path } of calls) {
      expect(path).not.toContain('U-FROM');
      expect(path).not.toContain('scope');
    }
    window.localStorage.clear();
  });

  it('the page and the bell together make ONE unread-count poll, not two', async () => {
    const calls = backend([[wire('a')]]);

    renderApp(CUSTOMER);
    await screen.findAllByRole('listitem');

    expect(calls.filter((call) => call.path.includes('/unread-count'))).toHaveLength(1);
  });
});

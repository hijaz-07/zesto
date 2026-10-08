import { IonReactRouter } from '@ionic/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../features/auth/AuthProvider';
import { getOrder } from '../features/order/api';
import { getUnreadCount, listNotifications, markNotificationRead } from '../features/notification/api';
import { notificationTarget } from '../features/notification/link';
import type { AppNotification } from '../features/notification/types';
import { cancelledPaidOrder, refundOf } from '../test/cancellationFixtures';
import { descopeMock } from '../test/mockDescopeSdk';
import { AppRoutes } from './routes';

/**
 * The cancellation and refund notifications a customer can receive keep taking
 * them to that order's existing page — through the real route stack, with the
 * real notification list and the real order page — and the order page then shows
 * the cancellation or refund the notification is about.
 */

vi.mock('@descope/react-sdk', async () => (await import('../test/mockDescopeSdk')).mockDescopeSdkModule);
vi.mock('../features/notification/api');
vi.mock('../features/order/api');

const mockedCount = vi.mocked(getUnreadCount);
const mockedList = vi.mocked(listNotifications);
const mockedMarkRead = vi.mocked(markNotificationRead);
const mockedGetOrder = vi.mocked(getOrder);

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const SHELL_RENDER_WAIT = { timeout: 15_000 };

function note(type: AppNotification['type'], overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: `n-${type}`,
    type,
    title: 'A title',
    body: 'A body for the notification.',
    orderId: 'order-1',
    createdAt: '2026-10-05T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  stubMatchMedia();
  descopeMock.reset();
  descopeMock.setSignedIn();
  vi.stubEnv('VITE_DESCOPE_PROJECT_ID', 'P-test-project');
  mockedCount.mockReset();
  mockedList.mockReset();
  mockedMarkRead.mockReset();
  mockedGetOrder.mockReset();
  mockedCount.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cancellation and refund notifications — deep links', () => {
  it.each([
    'order_cancelled_by_outlet',
    'order_cancelled_by_system',
    'refund_completed',
    'refund_failed',
  ] as const)('a %s notification targets that order\'s own page', (type) => {
    expect(notificationTarget(note(type, { orderId: 'order-1' }), { kind: 'customer' })).toBe('/app/orders/order-1');
  });

  it('encodes the order ID, and never uses anything else the server sent as a URL', () => {
    const target = notificationTarget(
      note('refund_failed', { orderId: 'a/b?x=1', body: 'https://evil.example/steal' }),
      { kind: 'customer' },
    );

    expect(target).toBe('/app/orders/a%2Fb%3Fx%3D1');
  });

  describe.each([
    {
      type: 'order_cancelled_by_outlet',
      order: cancelledPaidOrder(refundOf('requested')),
      expects: [
        { role: 'heading', name: 'Order cancelled' },
        { role: 'heading', name: 'Refund initiated' },
      ],
    },
    {
      type: 'order_cancelled_by_system',
      order: cancelledPaidOrder(refundOf('requested')),
      expects: [{ role: 'heading', name: 'Order cancelled' }],
    },
    {
      type: 'refund_completed',
      order: cancelledPaidOrder(refundOf('processed')),
      expects: [{ role: 'heading', name: 'Refund processed' }],
    },
    {
      type: 'refund_failed',
      order: cancelledPaidOrder(refundOf('failed')),
      expects: [{ role: 'heading', name: 'Refund not completed' }],
    },
  ] as const)('opening a $type notification', ({ type, order, expects }) => {
    it('goes to the order page, which shows what the notification is about', { timeout: 30_000 }, async () => {
      mockedList.mockResolvedValue({ notifications: [note(type)], nextCursor: null });
      mockedMarkRead.mockResolvedValue(note(type, { readAt: '2026-10-05T12:00:00.000Z' }));
      mockedGetOrder.mockResolvedValue({ order });
      window.history.pushState({}, '', '/app/notifications');
      render(
        <AuthProvider>
          <IonReactRouter>
            <AppRoutes />
          </IonReactRouter>
        </AuthProvider>,
      );
      const row = (await screen.findAllByRole('listitem', undefined, SHELL_RENDER_WAIT))[0];

      fireEvent.click(within(row).getAllByRole('button')[0]);

      await waitFor(() => expect(window.location.pathname).toBe('/app/orders/order-1'), SHELL_RENDER_WAIT);
      expect(mockedMarkRead).toHaveBeenCalledWith({ kind: 'customer' }, `n-${type}`);
      for (const { role, name } of expects) {
        expect(await screen.findByRole(role, { name }, SHELL_RENDER_WAIT)).toBeInTheDocument();
      }
      expect(mockedGetOrder).toHaveBeenCalledWith('order-1');
    });
  });
});

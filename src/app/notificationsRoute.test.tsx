import { IonReactRouter } from '@ionic/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../features/auth/AuthProvider';
import {
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from '../features/notification/api';
import type { AppNotification } from '../features/notification/types';
import { listOrganizationOrders } from '../features/organizationOrder/api';
import { getOutlets } from '../features/outlet/api';
import { descopeMock } from '../test/mockDescopeSdk';
import { confirmedOrgOrder, orgOutlets } from '../test/organizationOrderFixtures';
import { AppRoutes } from './routes';

vi.mock('@descope/react-sdk', async () => (await import('../test/mockDescopeSdk')).mockDescopeSdkModule);

const getOrganizationsMock = vi.hoisted(() => vi.fn());
vi.mock('../features/organization/api', () => ({
  getOrganizations: getOrganizationsMock,
  createOrganization: vi.fn(),
}));
vi.mock('../features/notification/api');
vi.mock('../features/outlet/api');
vi.mock('../features/organizationOrder/api');

const mockedCount = vi.mocked(getUnreadCount);
const mockedList = vi.mocked(listNotifications);
const mockedMarkRead = vi.mocked(markNotificationRead);
const mockedOrgOrders = vi.mocked(listOrganizationOrders);
const mockedGetOutlets = vi.mocked(getOutlets);

/** As in `organizationOrdersRoute.test.tsx`: jsdom has no `matchMedia`, which Ionic's split pane calls. */
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

function renderRoutesAt(path: string) {
  window.history.pushState({}, '', path);
  return render(
    <AuthProvider>
      <IonReactRouter>
        <AppRoutes />
      </IonReactRouter>
    </AuthProvider>,
  );
}

function note(id: string, overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    type: 'order_ready',
    title: 'Ready for pickup',
    body: 'Your order from Main Canteen is ready for pickup.',
    orderId: 'order-77',
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
  getOrganizationsMock.mockReset();
  mockedCount.mockReset();
  mockedList.mockReset();
  mockedMarkRead.mockReset();
  mockedOrgOrders.mockReset();
  mockedGetOutlets.mockReset();
  mockedGetOutlets.mockResolvedValue({ outlets: orgOutlets });
  mockedOrgOrders.mockResolvedValue({ orders: [confirmedOrgOrder], nextCursor: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('notifications in the customer shell', { timeout: 30_000 }, () => {
  it('shows the bell with the server\'s unread count, from ONE provider, and opens /app/notifications', async () => {
    mockedCount.mockResolvedValue(3);
    mockedList.mockResolvedValue({ notifications: [note('a')], nextCursor: null });

    renderRoutesAt('/app/profile');

    const bell = await screen.findByRole('button', { name: 'Notifications, 3 unread' }, SHELL_RENDER_WAIT);
    expect(within(bell).getByTestId('notification-badge')).toHaveTextContent('3');
    expect(mockedCount).toHaveBeenCalledWith({ kind: 'customer' });

    fireEvent.click(bell);

    await waitFor(() => expect(window.location.pathname).toBe('/app/notifications'), SHELL_RENDER_WAIT);
    expect(await screen.findByRole('heading', { level: 1, name: 'Notifications' }, SHELL_RENDER_WAIT)).toBeInTheDocument();
    expect(await screen.findByText('Your order from Main Canteen is ready for pickup.')).toBeInTheDocument();
    expect(mockedList).toHaveBeenCalledWith({ kind: 'customer' }, { limit: 20, unread: false });
    // Navigating between pages of the shell does not start another poller.
    expect(mockedCount).toHaveBeenCalledTimes(1);
  });

  it('opening a notification marks it read, then goes to that order\'s existing page', async () => {
    mockedCount.mockResolvedValue(1);
    mockedList.mockResolvedValue({ notifications: [note('a', { orderId: 'order-77' })], nextCursor: null });
    mockedMarkRead.mockResolvedValue(note('a', { readAt: '2026-10-05T12:00:00.000Z' }));

    renderRoutesAt('/app/notifications');
    const row = (await screen.findAllByRole('listitem', undefined, SHELL_RENDER_WAIT))[0];

    fireEvent.click(within(row).getAllByRole('button')[0]);

    await waitFor(() => expect(window.location.pathname).toBe('/app/orders/order-77'), SHELL_RENDER_WAIT);
    expect(mockedMarkRead).toHaveBeenCalledWith({ kind: 'customer' }, 'a');
  });

  it('shows the bell without a badge at 0, and leaves the rest of the shell alone', async () => {
    mockedCount.mockResolvedValue(0);

    renderRoutesAt('/app/profile');

    expect(await screen.findByRole('button', { name: 'Notifications' }, SHELL_RENDER_WAIT)).toBeInTheDocument();
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('notifications in the organization shell', { timeout: 30_000 }, () => {
  function membership(role: 'owner' | 'manager' | 'staff') {
    return {
      id: 'org-1',
      name: 'Test Canteen',
      slug: 'test-canteen',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'U-1',
      role,
    };
  }

  it('puts the bell in the shared toolbar of EVERY organization page, from one provider for this organization', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('staff')] });
    mockedCount.mockResolvedValue(12);

    renderRoutesAt('/org/orders');

    const bell = await screen.findByRole('button', { name: 'Notifications, 12 unread' }, SHELL_RENDER_WAIT);
    expect(within(bell).getByTestId('notification-badge')).toHaveTextContent('12');
    expect(mockedCount).toHaveBeenCalledTimes(1);
    // The organization asked about is the member's own, from the backend — not anything in the URL.
    expect(mockedCount).toHaveBeenCalledWith({ kind: 'organization', organizationId: 'org-1' });
  });

  it('shows no badge at 0 and "99+" at 100', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('owner')] });
    mockedCount.mockResolvedValue(100);

    renderRoutesAt('/org/orders');

    expect(await screen.findByTestId('notification-badge', undefined, SHELL_RENDER_WAIT)).toHaveTextContent('99+');
  });

  it('opens /org/notifications from the bell and lists this organization\'s notifications', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('manager')] });
    mockedCount.mockResolvedValue(1);
    mockedList.mockResolvedValue({
      notifications: [note('n', { type: 'new_order', title: 'New order', body: 'New order received from Main Canteen.' })],
      nextCursor: null,
    });

    renderRoutesAt('/org/orders');
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }, SHELL_RENDER_WAIT));

    await waitFor(() => expect(window.location.pathname).toBe('/org/notifications'), SHELL_RENDER_WAIT);
    expect(await screen.findByText('New order received from Main Canteen.', undefined, SHELL_RENDER_WAIT)).toBeInTheDocument();
    expect(mockedList).toHaveBeenCalledWith(
      { kind: 'organization', organizationId: 'org-1' },
      { limit: 20, unread: false },
    );
    expect(mockedCount).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an organization id in the URL for the member\'s organization', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('staff')] });
    mockedCount.mockResolvedValue(0);
    mockedList.mockResolvedValue({ notifications: [], nextCursor: null });

    renderRoutesAt('/org/notifications?organizationId=org-attacker&scope=org:org-attacker');

    await screen.findByText('No notifications yet', undefined, SHELL_RENDER_WAIT);
    for (const [scope] of mockedList.mock.calls) {
      expect(scope).toEqual({ kind: 'organization', organizationId: 'org-1' });
    }
    for (const [scope] of mockedCount.mock.calls) {
      expect(scope).toEqual({ kind: 'organization', organizationId: 'org-1' });
    }
  });

  it('a notification opens the existing orders page', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('owner')] });
    mockedCount.mockResolvedValue(1);
    mockedList.mockResolvedValue({
      notifications: [note('n', { type: 'new_order', title: 'New order', body: 'New order received from Main Canteen.' })],
      nextCursor: null,
    });
    mockedMarkRead.mockResolvedValue(note('n', { type: 'new_order', readAt: '2026-10-05T12:00:00.000Z' }));

    renderRoutesAt('/org/notifications');
    const row = (await screen.findAllByRole('listitem', undefined, SHELL_RENDER_WAIT))[0];
    fireEvent.click(within(row).getAllByRole('button')[0]);

    await waitFor(() => expect(window.location.pathname).toBe('/org/orders'), SHELL_RENDER_WAIT);
    expect(await screen.findByRole('table', { name: 'Orders, newest first' }, SHELL_RENDER_WAIT)).toBeInTheDocument();
  });
});

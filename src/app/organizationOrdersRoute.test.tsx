import { IonReactRouter } from '@ionic/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../features/auth/AuthProvider';
import { getOutlets } from '../features/outlet/api';
import { listOrganizationOrders, runFulfillmentAction } from '../features/organizationOrder/api';
import { descopeMock } from '../test/mockDescopeSdk';
import { confirmedOrgOrder, orgOutlets, pendingOrgOrder } from '../test/organizationOrderFixtures';
import { AppRoutes } from './routes';

vi.mock('@descope/react-sdk', async () => (await import('../test/mockDescopeSdk')).mockDescopeSdkModule);

const getOrganizationsMock = vi.hoisted(() => vi.fn());
vi.mock('../features/organization/api', () => ({
  getOrganizations: getOrganizationsMock,
  createOrganization: vi.fn(),
}));
vi.mock('../features/outlet/api');
vi.mock('../features/organizationOrder/api');

const mockedList = vi.mocked(listOrganizationOrders);
const mockedRunAction = vi.mocked(runFulfillmentAction);
const mockedGetOutlets = vi.mocked(getOutlets);

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

/**
 * jsdom has no `matchMedia`, which Ionic's real `ion-split-pane` (the shell's
 * desktop layout) calls as soon as it connects. A viewport that matches no
 * query is enough: the shell then renders in its collapsed form, which is all
 * these tests need.
 */
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

/**
 * How long a lookup waits for the REAL Ionic shell's first render. Alone this
 * takes a fraction of a second, but inside the full parallel suite (one jsdom
 * per file, the machine saturated) Ionic's router/outlet hydration can slip past
 * Testing Library's 1s default. The wait is a ceiling, not a delay — it returns
 * as soon as the element appears, and a table that never appears still fails.
 */
const SHELL_RENDER_WAIT = { timeout: 15_000 };

describe('/org/orders inside the organization shell', { timeout: 30_000 }, () => {
  beforeEach(() => {
    stubMatchMedia();
    descopeMock.reset();
    descopeMock.setSignedIn();
    vi.stubEnv('VITE_DESCOPE_PROJECT_ID', 'P-test-project');
    getOrganizationsMock.mockReset();
    mockedList.mockReset();
    mockedRunAction.mockReset();
    mockedGetOutlets.mockReset();
    mockedGetOutlets.mockResolvedValue({ outlets: orgOutlets });
    mockedList.mockResolvedValue({ orders: [confirmedOrgOrder, pendingOrgOrder], nextCursor: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // Reading orders does not depend on the member's role — the backend decides who
  // may read them (owner/manager/staff alike; see the backend's authorization
  // tests). The role only decides whether the fulfilment buttons are shown (see
  // the last test here); the backend re-checks it on every action regardless.
  it("shows the orders page to a member, loading the organization from the member's own membership", async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('owner')] });

    renderRoutesAt('/org/orders');

    expect(
      await screen.findByRole('table', { name: 'Orders, newest first' }, SHELL_RENDER_WAIT),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/org/orders');
    // The organization asked about is the one the backend reported for this member — not anything in the URL.
    expect(mockedList).toHaveBeenCalledWith('org-1', { outletId: undefined, limit: 20 });
    expect(mockedGetOutlets).toHaveBeenCalledWith('org-1');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('#order-confirmed-1');
    expect(rows[1]).toHaveTextContent('#order-pending-2');
  });

  it("does not mistake an organization id in the query string for the caller's organization", async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('staff')] });

    renderRoutesAt('/org/orders?organizationId=org-attacker&outletId=outlet-attacker');

    await screen.findByRole('table', undefined, SHELL_RENDER_WAIT);
    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList).toHaveBeenCalledWith('org-1', { outletId: undefined, limit: 20 });
  });

  it("is reached from the side navigation's Orders item", async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('owner')] });

    renderRoutesAt('/org/dashboard');

    const nav = await screen.findByRole('list', undefined, SHELL_RENDER_WAIT);
    const ordersItem = within(nav).getByText('Orders').closest('ion-item');
    expect(ordersItem).not.toBeNull();
    expect(mockedList).not.toHaveBeenCalled();

    fireEvent.click(ordersItem as HTMLElement);

    await waitFor(() => expect(window.location.pathname).toBe('/org/orders'), SHELL_RENDER_WAIT);
    expect(
      await screen.findByRole('table', { name: 'Orders, newest first' }, SHELL_RENDER_WAIT),
    ).toBeInTheDocument();
    expect(mockedList).toHaveBeenCalledWith('org-1', { outletId: undefined, limit: 20 });
  });

  it.each(['owner', 'manager', 'staff'] as const)(
    "gives an %s the fulfilment action, sent for the organization of the member's own membership",
    async (role) => {
      getOrganizationsMock.mockResolvedValue({ organizations: [membership(role)] });
      mockedRunAction.mockResolvedValue({ ...confirmedOrgOrder, status: 'preparing' });

      renderRoutesAt('/org/orders?organizationId=org-attacker');
      const button = await screen.findByRole('button', { name: /Start preparing/ }, SHELL_RENDER_WAIT);
      fireEvent.click(button);

      await waitFor(() => expect(mockedRunAction).toHaveBeenCalledTimes(1));
      expect(mockedRunAction).toHaveBeenCalledWith('org-1', 'order-confirmed-1', 'start-preparing');
      expect(await screen.findByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
    },
  );

  it('sends a signed-out visitor to /login without requesting any orders', async () => {
    descopeMock.reset();

    renderRoutesAt('/org/orders');

    await waitFor(() => expect(window.location.pathname).toBe('/login'), SHELL_RENDER_WAIT);
    expect(mockedList).not.toHaveBeenCalled();
    expect(getOrganizationsMock).not.toHaveBeenCalled();
  });

  it('sends a signed-in user with no organization to onboarding without requesting any orders', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [] });

    renderRoutesAt('/org/orders');

    await waitFor(() => expect(window.location.pathname).toBe('/org/onboarding'), SHELL_RENDER_WAIT);
    expect(mockedList).not.toHaveBeenCalled();
  });
});

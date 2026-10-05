import { IonReactRouter } from '@ionic/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../features/auth/AuthProvider';
import { getOutlets } from '../features/outlet/api';
import { redeemPickup, runFulfillmentAction } from '../features/organizationOrder/api';
import { descopeMock } from '../test/mockDescopeSdk';
import { completedOrgOrder, orgOutlets, pickedUpOrgOrder } from '../test/organizationOrderFixtures';
import { AppRoutes } from './routes';

vi.mock('@descope/react-sdk', async () => (await import('../test/mockDescopeSdk')).mockDescopeSdkModule);

const getOrganizationsMock = vi.hoisted(() => vi.fn());
vi.mock('../features/organization/api', () => ({
  getOrganizations: getOrganizationsMock,
  createOrganization: vi.fn(),
}));
vi.mock('../features/outlet/api');
vi.mock('../features/organizationOrder/api');

const mockedRedeem = vi.mocked(redeemPickup);
const mockedRun = vi.mocked(runFulfillmentAction);
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

/** jsdom has no `matchMedia`, which Ionic's real split pane calls; a viewport that matches nothing is enough. */
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

/** A ceiling, not a delay, for the REAL Ionic shell's first render in the full parallel suite (see `organizationOrdersRoute.test.tsx`). */
const SHELL_RENDER_WAIT = { timeout: 15_000 };

describe('/org/pickup inside the organization shell', { timeout: 30_000 }, () => {
  beforeEach(() => {
    stubMatchMedia();
    descopeMock.reset();
    descopeMock.setSignedIn();
    vi.stubEnv('VITE_DESCOPE_PROJECT_ID', 'P-test-project');
    getOrganizationsMock.mockReset();
    mockedRedeem.mockReset();
    mockedRun.mockReset();
    mockedGetOutlets.mockReset();
    mockedGetOutlets.mockResolvedValue({ outlets: orgOutlets });
    mockedRedeem.mockResolvedValue(pickedUpOrgOrder);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(['owner', 'manager', 'staff'] as const)('shows the pickup controls to an %s', async (role) => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership(role)] });

    renderRoutesAt('/org/pickup');

    expect(await screen.findByRole('textbox', { name: 'Pickup code' }, SHELL_RENDER_WAIT)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pickup' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/org/pickup');
    expect(mockedGetOutlets).toHaveBeenCalledWith('org-1');
  });

  it("is reached from the side navigation's Pickup item", async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('staff')] });

    renderRoutesAt('/org/dashboard');

    const nav = await screen.findByRole('list', undefined, SHELL_RENDER_WAIT);
    const item = within(nav).getByText('Pickup').closest('ion-item');
    expect(item).not.toBeNull();

    fireEvent.click(item as HTMLElement);

    await waitFor(() => expect(window.location.pathname).toBe('/org/pickup'), SHELL_RENDER_WAIT);
    expect(await screen.findByRole('textbox', { name: 'Pickup code' }, SHELL_RENDER_WAIT)).toBeInTheDocument();
  });

  it("hands an order over for the organization of the member's own membership — never one named in the URL", async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('staff')] });

    renderRoutesAt('/org/pickup?organizationId=org-attacker&orderId=order-attacker&credential=K7QX-4M2P');
    const input = await screen.findByRole('textbox', { name: 'Pickup code' }, SHELL_RENDER_WAIT);
    // Nothing is read from the address: the field starts empty.
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.change(input, { target: { value: 'k7qx 4m2p' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));

    await waitFor(() => expect(mockedRedeem).toHaveBeenCalledTimes(1));
    expect(mockedRedeem).toHaveBeenCalledWith('org-1', { credential: 'K7QX-4M2P', outletId: undefined });
    expect(await screen.findByText('Order #order-picked-up-7')).toBeInTheDocument();
  });

  it('completes the order it just handed over, through the whole shell', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('manager')] });
    mockedRun.mockResolvedValue({ ...completedOrgOrder, id: pickedUpOrgOrder.id });

    renderRoutesAt('/org/pickup');
    const input = await screen.findByRole('textbox', { name: 'Pickup code' }, SHELL_RENDER_WAIT);
    fireEvent.change(input, { target: { value: 'K7QX-4M2P' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark completed' }));

    expect(await screen.findByText('This order is complete.')).toBeInTheDocument();
    expect(mockedRun).toHaveBeenCalledWith('org-1', 'order-picked-up-7', 'complete');
  });

  it('does not put the credential in the address bar at any point', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [membership('staff')] });

    renderRoutesAt('/org/pickup');
    const input = await screen.findByRole('textbox', { name: 'Pickup code' }, SHELL_RENDER_WAIT);
    fireEvent.change(input, { target: { value: 'K7QX-4M2P' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    await screen.findByText('Order #order-picked-up-7');

    expect(window.location.href).not.toMatch(/K7QX/i);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });

  it('sends a signed-out visitor to /login without requesting anything', async () => {
    descopeMock.reset();

    renderRoutesAt('/org/pickup');

    await waitFor(() => expect(window.location.pathname).toBe('/login'), SHELL_RENDER_WAIT);
    expect(getOrganizationsMock).not.toHaveBeenCalled();
    expect(mockedRedeem).not.toHaveBeenCalled();
  });

  it('sends a signed-in user with no organization to onboarding, with no pickup controls', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [] });

    renderRoutesAt('/org/pickup');

    await waitFor(() => expect(window.location.pathname).toBe('/org/onboarding'), SHELL_RENDER_WAIT);
    expect(screen.queryByRole('textbox', { name: 'Pickup code' })).not.toBeInTheDocument();
    expect(mockedRedeem).not.toHaveBeenCalled();
  });
});

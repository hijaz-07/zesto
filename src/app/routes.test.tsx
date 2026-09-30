import { IonReactRouter } from '@ionic/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../features/auth/AuthProvider';
import { descopeMock } from '../test/mockDescopeSdk';
import { AppRoutes } from './routes';

vi.mock('@descope/react-sdk', async () => (await import('../test/mockDescopeSdk')).mockDescopeSdkModule);
vi.mock('../features/explore/useExploreOutlets', () => ({
  useExploreOutlets: () => ({ status: 'ready', outlets: [], error: null, retry: vi.fn() }),
}));

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

describe('AppRoutes (signed out)', () => {
  beforeEach(() => {
    descopeMock.reset();
    vi.stubEnv('VITE_DESCOPE_PROJECT_ID', 'P-test-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['/', 'Know the demand before you cook.'],
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Use'],
    ['/refund-cancellation', 'Refund & Cancellation Policy'],
    ['/contact', 'Contact'],
  ])('serves %s publicly', async (path, heading) => {
    renderRoutesAt(path);

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
  });

  it('serves /explore publicly', async () => {
    renderRoutesAt('/explore');

    expect(await screen.findByText('No outlets available')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/explore');
  });

  it.each(['/app/menu', '/org/dashboard'])('still redirects %s to /login when signed out', async (path) => {
    renderRoutesAt(path);

    await vi.waitFor(() => expect(window.location.pathname).toBe('/login'));
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { descopeMock } from '../../test/mockDescopeSdk';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';

vi.mock('@descope/react-sdk', async () => (await import('../../test/mockDescopeSdk')).mockDescopeSdkModule);

function AuthProbe() {
  const { status, user, isAuthenticated, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="userId">{user?.userId ?? 'none'}</span>
      <span data-testid="phone">{user?.phone ?? 'none'}</span>
      <button type="button" onClick={() => void signOut()}>
        sign out
      </button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
}

describe('AuthProvider (Descope)', () => {
  beforeEach(() => {
    descopeMock.reset();
    vi.stubEnv('VITE_DESCOPE_PROJECT_ID', 'P-test-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('configures Descope with the Project ID from VITE_DESCOPE_PROJECT_ID', () => {
    renderWithProvider();

    expect(descopeMock.authProviderProps).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'P-test-project' }),
    );
  });

  it('is initializing while Descope restores the session', () => {
    descopeMock.setSessionLoading();

    renderWithProvider();

    expect(screen.getByTestId('status').textContent).toBe('initializing');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
    expect(screen.getByTestId('userId').textContent).toBe('none');
  });

  it('stays initializing while the signed-in user is still loading', () => {
    descopeMock.state = { isSessionLoading: false, isAuthenticated: true, isUserLoading: true, user: undefined };

    renderWithProvider();

    expect(screen.getByTestId('status').textContent).toBe('initializing');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('is signedIn with the Descope user once the session is authenticated', () => {
    descopeMock.setSignedIn({ userId: 'U-123', phone: '+911234567890' });

    renderWithProvider();

    expect(screen.getByTestId('status').textContent).toBe('signedIn');
    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('userId').textContent).toBe('U-123');
    expect(screen.getByTestId('phone').textContent).toBe('+911234567890');
  });

  it('is signedOut with no user when Descope reports no session', () => {
    renderWithProvider();

    expect(screen.getByTestId('status').textContent).toBe('signedOut');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
    expect(screen.getByTestId('userId').textContent).toBe('none');
  });

  it('signs out through the Descope SDK', async () => {
    descopeMock.setSignedIn();

    renderWithProvider();
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));

    await waitFor(() => expect(descopeMock.logout).toHaveBeenCalledTimes(1));
  });

  it('fails fast with a clear error when the Project ID is not configured', () => {
    vi.stubEnv('VITE_DESCOPE_PROJECT_ID', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderWithProvider()).toThrow(/VITE_DESCOPE_PROJECT_ID is not set/);

    vi.mocked(console.error).mockRestore();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';

const { onAuthStateChangedMock, signOutMock } = vi.hoisted(() => ({
  onAuthStateChangedMock: vi.fn(),
  signOutMock: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: onAuthStateChangedMock,
  signOut: signOutMock,
}));

vi.mock('../../lib/firebase', () => ({
  auth: {},
}));

function AuthProbe() {
  const { status, user, isAuthenticated } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="uid">{user?.uid ?? 'none'}</span>
    </div>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    onAuthStateChangedMock.mockReset();
    signOutMock.mockReset();
  });

  it('starts in the initializing state before Firebase reports a status', () => {
    onAuthStateChangedMock.mockImplementation(() => () => {});

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status').textContent).toBe('initializing');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('reflects the signed-in state and Firebase user once onAuthStateChanged fires with a user', async () => {
    let callback: (user: { uid: string } | null) => void = () => {};
    onAuthStateChangedMock.mockImplementation((_auth: unknown, cb: typeof callback) => {
      callback = cb;
      return () => {};
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    callback({ uid: 'user-123' });

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signedIn'));
    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('uid').textContent).toBe('user-123');
  });

  it('reflects the signed-out state once onAuthStateChanged fires with null', async () => {
    let callback: (user: { uid: string } | null) => void = () => {};
    onAuthStateChangedMock.mockImplementation((_auth: unknown, cb: typeof callback) => {
      callback = cb;
      return () => {};
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    callback(null);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signedOut'));
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('calls Firebase Auth signOut when signOut() is invoked', async () => {
    onAuthStateChangedMock.mockImplementation((_auth: unknown, cb: (user: null) => void) => {
      cb(null);
      return () => {};
    });
    signOutMock.mockResolvedValue(undefined);

    function SignOutProbe() {
      const { signOut } = useAuth();
      return (
        <button type="button" onClick={() => void signOut()}>
          sign out
        </button>
      );
    }

    render(
      <AuthProvider>
        <SignOutProbe />
      </AuthProvider>,
    );

    screen.getByRole('button', { name: 'sign out' }).click();

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
  });
});

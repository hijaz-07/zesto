import { AuthProvider as DescopeAuthProvider, useDescope, useSession, useUser } from '@descope/react-sdk';
import { useCallback, useMemo, type ReactNode } from 'react';
import { getDescopeProjectId } from './config';
import { AuthContext } from './context';
import type { AuthContextValue, AuthStatus } from './types';

export interface AuthProviderProps {
  children: ReactNode;
}

/**
 * The app's single authentication root. Descope is the source of truth for
 * session state: its SDK restores, refreshes, persists, and clears tokens
 * itself — this provider never reads or writes tokens directly.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  return (
    <DescopeAuthProvider projectId={getDescopeProjectId()}>
      <DescopeAuthBridge>{children}</DescopeAuthBridge>
    </DescopeAuthProvider>
  );
}

/** Maps Descope's session/user hooks onto Zesto's stable `useAuth()` contract. */
function DescopeAuthBridge({ children }: AuthProviderProps) {
  const { isAuthenticated, isSessionLoading } = useSession();
  const { user: descopeUser, isUserLoading } = useUser();
  const sdk = useDescope();

  let status: AuthStatus;
  if (isSessionLoading || (isAuthenticated && !descopeUser && isUserLoading)) {
    status = 'initializing';
  } else {
    status = isAuthenticated ? 'signedIn' : 'signedOut';
  }

  const signOut = useCallback(async () => {
    await sdk.logout();
  }, [sdk]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user:
        status === 'signedIn' && descopeUser
          ? {
              userId: descopeUser.userId,
              name: descopeUser.name,
              phone: descopeUser.phone,
              email: descopeUser.email,
            }
          : null,
      status,
      isAuthenticated: status === 'signedIn',
      signOut,
    }),
    [descopeUser, status, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

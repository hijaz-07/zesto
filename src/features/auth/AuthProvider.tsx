import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { auth } from '../../lib/firebase';
import { AuthContext } from './context';
import type { AuthContextValue, AuthStatus } from './types';

export interface AuthProviderProps {
  children: ReactNode;
}

/**
 * The single place in the app that subscribes to Firebase's `onAuthStateChanged`.
 * Firebase Auth (via its own persistence) is the source of truth for session state —
 * this provider never reads or writes tokens itself.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>('initializing');
  const [user, setUser] = useState<AuthContextValue['user']>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setStatus(firebaseUser ? 'signedIn' : 'signedOut');
    });
    return unsubscribe;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isAuthenticated: status === 'signedIn',
      signOut: () => firebaseSignOut(auth),
    }),
    [user, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

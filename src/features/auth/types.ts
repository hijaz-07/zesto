import type { User as FirebaseUser } from 'firebase/auth';

/**
 * `initializing` — the initial `onAuthStateChanged` callback has not fired yet.
 * `signedOut` / `signedIn` — Firebase Auth has reported a definitive state.
 */
export type AuthStatus = 'initializing' | 'signedIn' | 'signedOut';

export interface AuthContextValue {
  user: FirebaseUser | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  signOut: () => Promise<void>;
}

import type { UserId } from '../../domain/types';

/**
 * `initializing` — Descope has not finished restoring the session (or loading the signed-in user) yet.
 * `signedOut` / `signedIn` — Descope has reported a definitive session state.
 */
export type AuthStatus = 'initializing' | 'signedIn' | 'signedOut';

/**
 * The signed-in identity as the client sees it, for display and UX only.
 * It is never an authorization source: the backend derives identity from a
 * server-side-validated Descope session token, not from anything here.
 */
export interface AuthUser {
  /** Descope user ID — the stable identity key used for `users/{userId}` and `members/{userId}`. */
  userId: UserId;
  name?: string;
  phone?: string;
  email?: string;
}

export interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  signOut: () => Promise<void>;
}

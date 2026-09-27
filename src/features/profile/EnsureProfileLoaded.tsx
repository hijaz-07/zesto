import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/useAuth';
import { getMe } from './api';

/**
 * Calls `GET /api/me` exactly once per sign-in — not on every route/page —
 * so the server-side profile document exists as soon as a session starts.
 * Renders nothing; mount it once near the app root, inside `AuthProvider`.
 */
export function EnsureProfileLoaded() {
  const { status } = useAuth();
  const calledForThisSession = useRef(false);

  useEffect(() => {
    if (status === 'signedIn' && !calledForThisSession.current) {
      calledForThisSession.current = true;
      // Fire-and-forget: nothing in the shell renders the profile yet, and a
      // failure here shouldn't block the UI. Whichever feature needs the
      // profile next can call getMe() again.
      void getMe().catch(() => {});
    } else if (status === 'signedOut') {
      calledForThisSession.current = false;
    }
  }, [status]);

  return null;
}

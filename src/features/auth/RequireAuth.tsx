import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '../../components/common';
import { useAuth } from './useAuth';

const LOGIN_PATH = '/login';

export interface RequireAuthProps {
  children: ReactNode;
}

/**
 * UX-level route guard only, driven by the Descope session state behind
 * `useAuth()`. It keeps signed-out users out of authenticated shells, but it
 * is not a security boundary — backend validation of the Descope session
 * token (and Firestore Security Rules) is what actually protects the data.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'initializing') {
    return <LoadingState label="Checking sign-in status…" />;
  }

  if (status === 'signedOut') {
    // Ionic keeps this guarded view mounted after the redirect, so it re-renders with the
    // /login location; redirecting again would overwrite `from` with /login itself.
    if (location.pathname === LOGIN_PATH) {
      return null;
    }
    return <Navigate to={LOGIN_PATH} replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

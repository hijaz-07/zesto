import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '../../components/common';
import { useAuth } from './useAuth';

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
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

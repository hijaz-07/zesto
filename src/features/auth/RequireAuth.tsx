import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '../../components/common';
import { useAuth } from './useAuth';

export interface RequireAuthProps {
  children: ReactNode;
}

/**
 * UX-level route guard only. It keeps signed-out users out of authenticated
 * shells, but it is not a security boundary — Firestore Security Rules and
 * backend authorization are what actually protect the data.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'initializing') {
    return <LoadingState label="Checking sign-in status…" />;
  }

  if (status === 'signedOut') {
    return <Navigate to="/" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

import { Descope } from '@descope/react-sdk';
import { Navigate, useLocation, type Location } from 'react-router-dom';
import { LoadingState } from '../components/common';
import { SIGN_UP_OR_IN_FLOW_ID } from '../features/auth/config';
import { useAuth } from '../features/auth/useAuth';

const DEFAULT_REDIRECT = '/app/menu';

/**
 * Hosts the Descope `sign-up-or-in` flow. Descope owns the OTP UI and the
 * SMS OTP exchange; on success its SDK stores the session, `useAuth()` flips
 * to `signedIn`, and this page redirects back to where the user was headed.
 */
export function LoginPage() {
  const { status } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: Location } | null)?.from?.pathname ?? DEFAULT_REDIRECT;

  if (status === 'signedIn') {
    return <Navigate to={from} replace />;
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold text-text">Sign in to Zesto</h1>
        <p className="mt-2 text-muted">Know the demand before you cook.</p>
      </div>

      {status === 'initializing' ? (
        <LoadingState label="Checking sign-in status…" />
      ) : (
        <Descope flowId={SIGN_UP_OR_IN_FLOW_ID} />
      )}
    </div>
  );
}

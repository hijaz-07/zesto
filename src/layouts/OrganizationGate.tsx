import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ErrorState } from '../components/common/ErrorState';
import { LoadingState } from '../components/common/LoadingState';
import { Button } from '../components/ui/Button';
import { organizationErrorMessage } from '../features/organization/errors';
import { useOrganizations } from '../features/organization/useOrganizations';
import { OrganizationOnboardingPage } from '../pages/organization/OrganizationOnboardingPage';
import { OrganizationAppLayout } from './OrganizationAppLayout';

const ONBOARDING_PATH = '/org/onboarding';
const DASHBOARD_PATH = '/org/dashboard';

/**
 * Decides what `/org/*` renders based on the caller's organization
 * membership, loaded from the backend — never from client-trusted state.
 * Organization switching and a global "current organization" are
 * intentionally out of scope; see docs/architecture/frontend-routing.md.
 */
export function OrganizationGate() {
  const { status, organizations, error, retry, createOrganization } = useOrganizations();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  if (status === 'loading') {
    return <LoadingState label="Loading your organizations…" />;
  }

  if (status === 'error') {
    return (
      <ErrorState
        title="Couldn't load your organizations"
        description={organizationErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  }

  const hasOrganization = organizations.length > 0;

  if (hasOrganization) {
    return pathname === ONBOARDING_PATH ? (
      <Navigate to={DASHBOARD_PATH} replace />
    ) : (
      <OrganizationAppLayout organizationId={organizations[0].id} />
    );
  }

  return pathname === ONBOARDING_PATH ? (
    <OrganizationOnboardingPage
      createOrganization={createOrganization}
      onCreated={() => navigate(DASHBOARD_PATH, { replace: true })}
    />
  ) : (
    <Navigate to={ONBOARDING_PATH} replace />
  );
}

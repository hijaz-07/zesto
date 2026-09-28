import type { ReactNode } from 'react';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import { businessOutline } from 'ionicons/icons';
import { Navigate, useNavigate } from 'react-router-dom';
import type { OrganizationId } from '../../domain/types';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { Button } from '../../components/ui/Button';
import { OutletPickerCard } from '../../features/menu/OutletPickerCard';
import { outletErrorMessage } from '../../features/outlet/errors';
import { useOutlets } from '../../features/outlet/useOutlets';

export interface OrganizationMenusPageProps {
  organizationId: OrganizationId;
}

/**
 * `/org/menus` — the outlet picker that starts the menu-management flow.
 * Deliberately holds no "current outlet" state: picking an outlet just
 * navigates to `/org/menus/{outletId}`, and the URL is the only record of
 * that choice (see docs/architecture/frontend-routing.md for the same
 * principle applied to organizations).
 */
export function OrganizationMenusPage({ organizationId }: OrganizationMenusPageProps) {
  const { status, outlets, error, retry } = useOutlets(organizationId);
  const navigate = useNavigate();

  if (status === 'ready' && outlets.length === 1) {
    return <Navigate to={`/org/menus/${outlets[0].id}`} replace />;
  }

  let content: ReactNode;
  if (status === 'loading') {
    content = <LoadingState label="Loading outlets…" />;
  } else if (status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load outlets"
        description={outletErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (outlets.length === 0) {
    content = (
      <EmptyState
        title="No outlets yet"
        description="Create an outlet before creating menus."
        action={
          <Button onClick={() => navigate('/org/outlets')}>
            <IonIcon icon={businessOutline} />
            Go to Outlets
          </Button>
        }
      />
    );
  } else {
    content = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {outlets.map((outlet) => (
          <OutletPickerCard
            key={outlet.id}
            outlet={outlet}
            onOpenMenus={() => navigate(`/org/menus/${outlet.id}`)}
          />
        ))}
      </div>
    );
  }

  return (
    <IonPage>
      <OrganizationPageToolbar title="Menus" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Menus" subtitle="Choose an outlet to manage its menus." />
          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}

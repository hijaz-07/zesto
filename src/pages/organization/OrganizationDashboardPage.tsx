import { IonContent, IonPage } from '@ionic/react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { Button } from '../../components/ui/Button';
import type { OrganizationId } from '../../domain/types';
import { OutletDemandCard } from '../../features/organization/OutletDemandCard';
import { outletErrorMessage } from '../../features/outlet/errors';
import { useOutlets } from '../../features/outlet/useOutlets';

export interface OrganizationDashboardPageProps {
  organizationId: OrganizationId;
}

/** Each active outlet's next menu and its real demand: "know the demand before you cook". */
export function OrganizationDashboardPage({ organizationId }: OrganizationDashboardPageProps) {
  const { status, outlets, error, retry } = useOutlets(organizationId);
  const activeOutlets = outlets.filter((outlet) => outlet.status === 'active');

  let content;
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
  } else if (activeOutlets.length === 0) {
    content = (
      <EmptyState
        title="No active outlets"
        description="Add an outlet to start publishing menus."
        action={
          <Link to="/org/outlets" className="text-primary underline">
            Go to Outlets
          </Link>
        }
      />
    );
  } else {
    content = activeOutlets.map((outlet) => (
      <OutletDemandCard key={outlet.id} organizationId={organizationId} outlet={outlet} />
    ));
  }

  return (
    <IonPage>
      <OrganizationPageToolbar title="Dashboard" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Demand" subtitle="Portions ordered and paid for each outlet's next menu." />
          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}

import { useState, type ReactNode } from 'react';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import { addOutline } from 'ionicons/icons';
import type { OrganizationId, Outlet } from '../../domain/types';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { Button } from '../../components/ui/Button';
import { OutletCard } from '../../features/outlet/OutletCard';
import { OutletForm } from '../../features/outlet/OutletForm';
import { outletErrorMessage } from '../../features/outlet/errors';
import { useOutlets } from '../../features/outlet/useOutlets';

export interface OrganizationOutletsPageProps {
  organizationId: OrganizationId;
}

type OutletsView = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; outlet: Outlet };

/** Organization-facing outlet management: list, create, and edit. See docs/architecture for the underlying API. */
export function OrganizationOutletsPage({ organizationId }: OrganizationOutletsPageProps) {
  const { status, outlets, error, retry, createOutlet, updateOutlet } = useOutlets(organizationId);
  const [view, setView] = useState<OutletsView>({ mode: 'list' });

  const showList = () => setView({ mode: 'list' });

  let content: ReactNode;
  if (view.mode === 'create') {
    content = (
      <OutletForm mode="create" onSubmit={createOutlet} onSaved={showList} onCancel={showList} />
    );
  } else if (view.mode === 'edit') {
    const { outlet } = view;
    content = (
      <OutletForm
        mode="edit"
        outlet={outlet}
        onSubmit={(input) => updateOutlet(outlet.id, input)}
        onSaved={showList}
        onCancel={showList}
      />
    );
  } else if (status === 'loading') {
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
        description="Outlets are your organization's physical food locations. Create your first one to start publishing menus for it."
        action={
          <Button onClick={() => setView({ mode: 'create' })}>
            <IonIcon icon={addOutline} />
            Add Outlet
          </Button>
        }
      />
    );
  } else {
    content = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {outlets.map((outlet) => (
          <OutletCard key={outlet.id} outlet={outlet} onEdit={() => setView({ mode: 'edit', outlet })} />
        ))}
      </div>
    );
  }

  const title = view.mode === 'create' ? 'Add Outlet' : view.mode === 'edit' ? 'Edit Outlet' : 'Outlets';

  return (
    <IonPage>
      <OrganizationPageToolbar title="Outlets" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader
            title={title}
            subtitle={
              view.mode === 'list'
                ? "Outlets are your organization's physical food locations — the canteens, cafés, or counters customers order from."
                : undefined
            }
            actions={
              view.mode === 'list' ? (
                <Button onClick={() => setView({ mode: 'create' })}>
                  <IonIcon icon={addOutline} />
                  Add Outlet
                </Button>
              ) : undefined
            }
          />
          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}

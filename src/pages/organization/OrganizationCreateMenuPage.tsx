import type { ReactNode } from 'react';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import { arrowBackOutline } from 'ionicons/icons';
import { useNavigate, useParams } from 'react-router-dom';
import type { OrganizationId } from '../../domain/types';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { Button } from '../../components/ui/Button';
import { createMenu } from '../../features/menu/api';
import { MenuForm } from '../../features/menu/MenuForm';
import { outletErrorMessage } from '../../features/outlet/errors';
import { useOutlets } from '../../features/outlet/useOutlets';

export interface OrganizationCreateMenuPageProps {
  organizationId: OrganizationId;
}

/**
 * `/org/menus/:outletId/new` — the draft-menu creation form. `outletId` is
 * validated against this organization's own outlets (already loaded by
 * `useOutlets`) before the form is shown, mirroring
 * `OrganizationOutletMenusPage`'s same guard. The backend remains the
 * authoritative check either way (`POST .../menus` itself requires the
 * outlet to be active) — this is only a UX guard against a stale link or a
 * hand-typed URL.
 */
export function OrganizationCreateMenuPage({ organizationId }: OrganizationCreateMenuPageProps) {
  const { outletId } = useParams<{ outletId: string }>();
  const navigate = useNavigate();
  const outletsResult = useOutlets(organizationId);

  const backToMenus = (
    <Button variant="ghost" onClick={() => navigate(`/org/menus/${outletId}`)}>
      <IonIcon icon={arrowBackOutline} />
      Back to Menus
    </Button>
  );

  let content: ReactNode;
  if (outletsResult.status === 'loading') {
    content = <LoadingState label="Loading outlet…" />;
  } else if (outletsResult.status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load this outlet"
        description={outletErrorMessage(outletsResult.error)}
        action={<Button onClick={outletsResult.retry}>Try again</Button>}
      />
    );
  } else {
    const outlet = outletsResult.outlets.find((candidate) => candidate.id === outletId);
    if (!outlet) {
      content = (
        <EmptyState
          title="Outlet not found"
          description="This outlet doesn't exist, or you don't have access to it."
          action={
            <Button variant="secondary" onClick={() => navigate('/org/menus')}>
              Back to Outlets
            </Button>
          }
        />
      );
    } else if (outlet.status !== 'active') {
      content = (
        <EmptyState
          title="This outlet is inactive"
          description="New menus cannot be created while this outlet is inactive."
          action={
            <Button variant="secondary" onClick={() => navigate(`/org/menus/${outletId}`)}>
              Back to Menus
            </Button>
          }
        />
      );
    } else {
      content = (
        <MenuForm
          mode="create"
          onSubmit={(input) => createMenu(organizationId, outlet.id, input).then((response) => response.menu)}
          onSaved={(menu) => navigate(`/org/menus/${outlet.id}/${menu.id}`)}
          onCancel={() => navigate(`/org/menus/${outletId}`)}
        />
      );
    }
  }

  return (
    <IonPage>
      <OrganizationPageToolbar title="Create Menu" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <div>{backToMenus}</div>
          <PageHeader title="Create Menu" subtitle="The new menu starts as a draft; publish it once it's ready." />
          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}

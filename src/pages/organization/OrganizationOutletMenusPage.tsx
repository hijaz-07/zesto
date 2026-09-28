import type { ReactNode } from 'react';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import { addOutline, arrowBackOutline } from 'ionicons/icons';
import { useNavigate, useParams } from 'react-router-dom';
import type { OrganizationId, Outlet, OutletId } from '../../domain/types';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { MenuCard } from '../../features/menu/MenuCard';
import { menuErrorMessage } from '../../features/menu/errors';
import { useMenus } from '../../features/menu/useMenus';
import { outletErrorMessage } from '../../features/outlet/errors';
import { useOutlets } from '../../features/outlet/useOutlets';

export interface OrganizationOutletMenusPageProps {
  organizationId: OrganizationId;
}

interface CreateMenuButtonProps {
  outletId: OutletId;
}

/** Navigates to the draft-menu creation form for `outletId`. */
function CreateMenuButton({ outletId }: CreateMenuButtonProps) {
  const navigate = useNavigate();
  return (
    <Button onClick={() => navigate(`/org/menus/${outletId}/new`)}>
      <IonIcon icon={addOutline} />
      Create Menu
    </Button>
  );
}

interface OutletMenuListProps {
  organizationId: OrganizationId;
  outlet: Outlet;
}

/**
 * The menu list itself, split out from `OrganizationOutletMenusPage` so
 * `useMenus` (and the fetch it triggers) is only ever mounted once the
 * outlet has been confirmed to exist — never for an `outletId` that isn't
 * one of this organization's outlets.
 */
function OutletMenuList({ organizationId, outlet }: OutletMenuListProps) {
  const { status, menus, error, retry } = useMenus(organizationId, outlet.id);
  const navigate = useNavigate();
  const isActive = outlet.status === 'active';

  if (status === 'loading') {
    return <LoadingState label="Loading menus…" />;
  }

  if (status === 'error') {
    return (
      <ErrorState
        title="Couldn't load menus"
        description={menuErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  }

  if (menus.length === 0) {
    return (
      <EmptyState
        title="No menus yet"
        description={
          isActive
            ? 'Create a future menu for this outlet.'
            : 'The outlet must be active before a new menu can be created.'
        }
        action={isActive ? <CreateMenuButton outletId={outlet.id} /> : undefined}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {menus.map((menu) => (
        <MenuCard key={menu.id} menu={menu} onManage={() => navigate(`/org/menus/${outlet.id}/${menu.id}`)} />
      ))}
    </div>
  );
}

/**
 * `/org/menus/:outletId` — the menu list for one outlet. `outletId` is
 * validated against this organization's own outlets (already loaded by
 * `useOutlets`) before anything menu-related is fetched: an `outletId` that
 * doesn't resolve to a known outlet gets a not-found state, never a request
 * for that outlet's menus (see `OutletMenuList` above). The backend remains
 * the authoritative check either way — this is a UX guard, not a security
 * boundary.
 */
export function OrganizationOutletMenusPage({ organizationId }: OrganizationOutletMenusPageProps) {
  const { outletId } = useParams<{ outletId: string }>();
  const navigate = useNavigate();
  const outletsResult = useOutlets(organizationId);

  const backToOutlets = (
    <Button variant="ghost" onClick={() => navigate('/org/menus')}>
      <IonIcon icon={arrowBackOutline} />
      Back to Outlets
    </Button>
  );

  let fallback: ReactNode;
  let outlet: Outlet | undefined;

  if (outletsResult.status === 'loading') {
    fallback = <LoadingState label="Loading outlet…" />;
  } else if (outletsResult.status === 'error') {
    fallback = (
      <ErrorState
        title="Couldn't load this outlet"
        description={outletErrorMessage(outletsResult.error)}
        action={<Button onClick={outletsResult.retry}>Try again</Button>}
      />
    );
  } else {
    outlet = outletsResult.outlets.find((candidate) => candidate.id === outletId);
    if (!outlet) {
      fallback = (
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
    }
  }

  const isActive = outlet?.status === 'active';

  return (
    <IonPage>
      <OrganizationPageToolbar title="Menus" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <div>{backToOutlets}</div>
          <PageHeader
            title={outlet ? outlet.name : 'Menus'}
            subtitle={outlet ? 'Menus for this outlet.' : undefined}
            actions={
              outlet ? (isActive ? <CreateMenuButton outletId={outlet.id} /> : <Badge tone="neutral">INACTIVE</Badge>) : undefined
            }
          />
          {outlet && !isActive && (
            <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted">
              New menus cannot be created while this outlet is inactive.
            </p>
          )}
          {outlet ? <OutletMenuList organizationId={organizationId} outlet={outlet} /> : fallback}
        </div>
      </IonContent>
    </IonPage>
  );
}

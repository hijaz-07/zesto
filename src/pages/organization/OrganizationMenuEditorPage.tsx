import { useState, type ReactNode } from 'react';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import { arrowBackOutline } from 'ionicons/icons';
import { useNavigate, useParams } from 'react-router-dom';
import type { OrganizationId, OrganizationMemberRole } from '../../domain/types';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { MENU_STATUS_TONE, ORDERING_STATE_LABEL, ORDERING_STATE_TONE } from '../../features/menu/badges';
import {
  canManageMenu,
  getMenuEditPermissions,
  getMenuItemMutationPermissions,
} from '../../features/menu/editPermissions';
import { menuErrorMessage } from '../../features/menu/errors';
import { MenuForm } from '../../features/menu/MenuForm';
import { MenuLifecyclePanel } from '../../features/menu/MenuLifecyclePanel';
import { useMenu } from '../../features/menu/useMenu';
import { MenuItemsSection } from '../../features/menuItem/MenuItemsSection';
import { useMenuItems } from '../../features/menuItem/useMenuItems';
import { outletErrorMessage } from '../../features/outlet/errors';
import { useOutlets } from '../../features/outlet/useOutlets';
import { ApiError } from '../../lib/api/client';
import { formatDate, formatTime, getOrderingState } from '../../utils/date';

export interface OrganizationMenuEditorPageProps {
  organizationId: OrganizationId;
  /** The caller's membership role in this organization (from `GET /organizations`, threaded down via `OrganizationGate` -> `OrganizationAppLayout`). Gates every mutation control on this page — see `canManageMenu`. */
  role: OrganizationMemberRole;
}

/**
 * `/org/menus/:outletId/:menuId` — the menu detail/editor shell. Toggles
 * locally between a read-only detail view and `MenuForm` in edit mode
 * (mirroring `OrganizationOutletsPage`'s list/edit toggle), rather than a
 * separate `/edit` route — there is no independent "editor" URL state to
 * preserve. Menu and menu items are two independent resources
 * (`useMenu`/`useMenuItems`), matching how the backend treats them: the page
 * blocks on the menu (and the outlet, needed for item/publish permission
 * gating) loading, but lets `MenuItemsSection` show its own loading/error
 * state independently. `role` gates mutation controls only — reads (menu
 * details, status/ordering badges, the item list including disabled items)
 * are shown to every organization member regardless of role, matching the
 * backend's own `VIEW_ROLES` (all three roles) vs `MANAGE_ROLES`
 * (owner/manager only) split.
 */
export function OrganizationMenuEditorPage({ organizationId, role }: OrganizationMenuEditorPageProps) {
  const { outletId, menuId } = useParams<{ outletId: string; menuId: string }>();
  const navigate = useNavigate();
  // All three params are guaranteed present: this component only ever
  // renders under the "menus/:outletId/:menuId" route (see
  // OrganizationAppLayout), which cannot match without both dynamic
  // segments — react-router's own types just don't encode that route-shape
  // guarantee.
  const menuResult = useMenu(organizationId, outletId!, menuId!);
  const itemsResult = useMenuItems(organizationId, outletId!, menuId!);
  const outletsResult = useOutlets(organizationId);
  const [editing, setEditing] = useState(false);

  const backToMenus = (
    <Button variant="ghost" onClick={() => navigate(`/org/menus/${outletId}`)}>
      <IonIcon icon={arrowBackOutline} />
      Back to Menus
    </Button>
  );

  let fallback: ReactNode;
  if (menuResult.status === 'loading' || outletsResult.status === 'loading') {
    fallback = <LoadingState label="Loading menu…" />;
  } else if (menuResult.status === 'error') {
    fallback =
      menuResult.error instanceof ApiError && menuResult.error.status === 404 ? (
        <EmptyState
          title="Menu not found"
          description="This menu doesn't exist, or you don't have access to it."
          action={
            <Button variant="secondary" onClick={() => navigate(`/org/menus/${outletId}`)}>
              Back to Menus
            </Button>
          }
        />
      ) : (
        <ErrorState
          title="Couldn't load this menu"
          description={menuErrorMessage(menuResult.error)}
          action={<Button onClick={menuResult.retry}>Try again</Button>}
        />
      );
  } else if (outletsResult.status === 'error') {
    fallback = (
      <ErrorState
        title="Couldn't load this outlet"
        description={outletErrorMessage(outletsResult.error)}
        action={<Button onClick={outletsResult.retry}>Try again</Button>}
      />
    );
  }

  const menu = menuResult.menu;
  const outlet = outletsResult.status === 'ready' ? outletsResult.outlets.find((candidate) => candidate.id === outletId) : undefined;
  if (!fallback && menu && !outlet) {
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

  const orderingState = menu ? getOrderingState(menu.orderingOpensAt, menu.orderingClosesAt) : null;
  const permissions = menu && orderingState ? getMenuEditPermissions(menu.status, orderingState) : null;
  const outletActive = outlet?.status === 'active';
  const canManage = canManageMenu(role);
  const itemPermissions =
    menu && orderingState
      ? getMenuItemMutationPermissions(menu.status, orderingState, outletActive, canManage)
      : null;

  const itemCount = itemsResult.items.length;
  const enabledItemCount = itemsResult.items.filter((item) => item.enabled).length;
  const itemsReady = itemsResult.status === 'ready';

  const handlePublish = async () => {
    try {
      return await menuResult.publishMenu();
    } catch (error) {
      // A publish can be rejected because another process disabled or
      // deleted the menu's last enabled item concurrently; re-fetch items so
      // the list (and the checklist) reflect current truth rather than the
      // stale state that looked publishable a moment ago.
      itemsResult.retry();
      throw error;
    }
  };

  return (
    <IonPage>
      <OrganizationPageToolbar title="Menu" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <div>{backToMenus}</div>
          <PageHeader
            title={menu ? menu.title : 'Menu'}
            actions={
              menu && orderingState ? (
                <>
                  <Badge tone={MENU_STATUS_TONE[menu.status]}>{menu.status.toUpperCase()}</Badge>
                  <Badge tone={ORDERING_STATE_TONE[orderingState]}>{ORDERING_STATE_LABEL[orderingState]}</Badge>
                </>
              ) : undefined
            }
          />

          {menu && outlet && permissions && itemPermissions ? (
            <>
              {!outletActive && (
                <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted">
                  This outlet is inactive. Menu changes are unavailable.
                </p>
              )}

              {editing ? (
                <MenuForm
                  mode="edit"
                  menu={menu}
                  onSubmit={menuResult.updateMenu}
                  onSaved={() => setEditing(false)}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <>
                  <Card className="flex flex-col gap-3">
                    <p className="text-sm font-medium text-text">Menu Details</p>
                    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Menu date</dt>
                        <dd className="text-text">{formatDate(menu.menuDate)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Ordering window</dt>
                        <dd className="text-text">
                          {formatTime(menu.orderingOpensAt)} – {formatTime(menu.orderingClosesAt)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Pickup window</dt>
                        <dd className="text-text">
                          {formatTime(menu.pickupStartsAt)} – {formatTime(menu.pickupEndsAt)}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-xs uppercase tracking-wide text-muted">Description</dt>
                        <dd className="text-text">{menu.description || '—'}</dd>
                      </div>
                    </dl>
                  </Card>
                  {permissions.canSave && outletActive && canManage && (
                    <div>
                      <Button onClick={() => setEditing(true)}>Edit Menu</Button>
                    </div>
                  )}
                </>
              )}

              <MenuItemsSection itemsResult={itemsResult} permissions={itemPermissions} />

              <MenuLifecyclePanel
                menu={menu}
                itemCount={itemCount}
                enabledItemCount={enabledItemCount}
                itemsReady={itemsReady}
                outletActive={outletActive}
                canManage={canManage}
                onPublish={handlePublish}
                onArchive={menuResult.archiveMenu}
              />
            </>
          ) : (
            fallback
          )}
        </div>
      </IonContent>
    </IonPage>
  );
}

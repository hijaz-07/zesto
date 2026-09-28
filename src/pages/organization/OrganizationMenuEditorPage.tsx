import { useState, type ReactNode } from 'react';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import { arrowBackOutline } from 'ionicons/icons';
import { useNavigate, useParams } from 'react-router-dom';
import type { OrganizationId } from '../../domain/types';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { MENU_STATUS_TONE, ORDERING_STATE_LABEL, ORDERING_STATE_TONE } from '../../features/menu/badges';
import { getMenuEditPermissions } from '../../features/menu/editPermissions';
import { menuErrorMessage } from '../../features/menu/errors';
import { MenuForm } from '../../features/menu/MenuForm';
import { useMenu } from '../../features/menu/useMenu';
import { ApiError } from '../../lib/api/client';
import { formatDate, formatTime, getOrderingState } from '../../utils/date';

export interface OrganizationMenuEditorPageProps {
  organizationId: OrganizationId;
}

/**
 * `/org/menus/:outletId/:menuId` — the menu detail/editor shell. Toggles
 * locally between a read-only detail view and `MenuForm` in edit mode
 * (mirroring `OrganizationOutletsPage`'s list/edit toggle), rather than a
 * separate `/edit` route — there is no independent "editor" URL state to
 * preserve. Menu item management and the real publish action are
 * deliberately out of scope here; see the placeholders below.
 */
export function OrganizationMenuEditorPage({ organizationId }: OrganizationMenuEditorPageProps) {
  const { outletId, menuId } = useParams<{ outletId: string; menuId: string }>();
  const navigate = useNavigate();
  // Both params are guaranteed present: this component only ever renders
  // under the "menus/:outletId/:menuId" route (see OrganizationAppLayout),
  // which cannot match without both dynamic segments — react-router's own
  // types just don't encode that route-shape guarantee.
  const { status, menu, error, retry, updateMenu } = useMenu(organizationId, outletId!, menuId!);
  const [editing, setEditing] = useState(false);

  const backToMenus = (
    <Button variant="ghost" onClick={() => navigate(`/org/menus/${outletId}`)}>
      <IonIcon icon={arrowBackOutline} />
      Back to Menus
    </Button>
  );

  let fallback: ReactNode;
  if (status === 'loading') {
    fallback = <LoadingState label="Loading menu…" />;
  } else if (status === 'error') {
    fallback =
      error instanceof ApiError && error.status === 404 ? (
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
          description={menuErrorMessage(error)}
          action={<Button onClick={retry}>Try again</Button>}
        />
      );
  }

  const orderingState = menu ? getOrderingState(menu.orderingOpensAt, menu.orderingClosesAt) : null;
  const permissions = menu && orderingState ? getMenuEditPermissions(menu.status, orderingState) : null;

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

          {menu && permissions ? (
            <>
              {editing ? (
                <MenuForm
                  mode="edit"
                  menu={menu}
                  onSubmit={updateMenu}
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
                  {permissions.canSave && (
                    <div>
                      <Button onClick={() => setEditing(true)}>Edit Menu</Button>
                    </div>
                  )}
                </>
              )}

              <Card className="flex flex-col items-center gap-1 py-8 text-center">
                <p className="text-sm font-medium text-text">Menu Items</p>
                <p className="text-sm text-muted">Menu item management will be added in the next step.</p>
              </Card>

              {menu.status === 'draft' && (
                <Card className="flex flex-col gap-1">
                  <Button disabled aria-label="Publish — add an enabled menu item first">
                    Publish
                  </Button>
                  <p className="text-xs text-muted">Add at least one enabled menu item before publishing.</p>
                </Card>
              )}
            </>
          ) : (
            fallback
          )}
        </div>
      </IonContent>
    </IonPage>
  );
}

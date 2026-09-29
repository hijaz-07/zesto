import { IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { arrowBackOutline } from 'ionicons/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { exploreMenuErrorMessage } from '../../features/explore/errors';
import { ExploreMenuItemCard } from '../../features/explore/ExploreMenuItemCard';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { ORDERING_STATE_LABEL, ORDERING_STATE_TONE } from '../../features/menu/badges';
import { formatDate, formatTime } from '../../utils/date';

/**
 * `/explore/outlets/:outletId/menus/:menuId` — a read-only view of one
 * published menu and its enabled items. No ordering UI of any kind (cart,
 * quantities, "Add to cart", payment) — out of scope for Step 9C; see root
 * CLAUDE.md's "Menu editing" and the task notes for this checkpoint.
 */
export function ExploreMenuDetailPage() {
  const { outletId, menuId } = useParams<{ outletId: string; menuId: string }>();
  const navigate = useNavigate();
  const { status, menu, error, retry } = useExploreMenu(outletId, menuId);

  const backToOutlet = (
    <Button variant="ghost" onClick={() => navigate(`/explore/outlets/${outletId}`)}>
      <IonIcon icon={arrowBackOutline} />
      Back to Outlet
    </Button>
  );

  let content;
  if (status === 'loading' || status === 'idle') {
    content = <LoadingState label="Loading menu…" />;
  } else if (status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load this menu"
        description={exploreMenuErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (menu) {
    content = (
      <>
        <PageHeader
          title={menu.title}
          subtitle={formatDate(menu.menuDate)}
          actions={<Badge tone={ORDERING_STATE_TONE[menu.orderingState]}>{ORDERING_STATE_LABEL[menu.orderingState]}</Badge>}
        />
        {menu.description && <p className="text-sm text-muted">{menu.description}</p>}

        <p className="rounded-lg bg-background px-3 py-2 text-sm text-muted">
          Pickup {formatTime(menu.pickupStartsAt)} – {formatTime(menu.pickupEndsAt)}
        </p>

        {menu.items.length === 0 ? (
          <EmptyState title="No items on this menu yet" />
        ) : (
          <div className="flex flex-col gap-3">
            {menu.items.map((item) => (
              <ExploreMenuItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Menu</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <div>{backToOutlet}</div>
          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}

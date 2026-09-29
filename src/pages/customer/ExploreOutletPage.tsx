import { IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { arrowBackOutline } from 'ionicons/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { Button } from '../../components/ui/Button';
import { exploreAddressSummary } from '../../features/explore/address';
import { exploreOutletErrorMessage } from '../../features/explore/errors';
import { ExploreMenuCard } from '../../features/explore/ExploreMenuCard';
import { useExploreOutlet } from '../../features/explore/useExploreOutlet';

/**
 * `/explore/outlets/:outletId` — one outlet's public page: its details plus
 * its upcoming customer-visible menus (no items yet — see `ExploreMenuDetailPage`
 * for that). Public, matching `ExplorePage`.
 */
export function ExploreOutletPage() {
  const { outletId } = useParams<{ outletId: string }>();
  const navigate = useNavigate();
  const { status, outlet, menus, error, retry } = useExploreOutlet(outletId);

  const backToExplore = (
    <Button variant="ghost" onClick={() => navigate('/explore')}>
      <IonIcon icon={arrowBackOutline} />
      Back to Explore
    </Button>
  );

  let content;
  if (status === 'loading' || status === 'idle') {
    content = <LoadingState label="Loading outlet…" />;
  } else if (status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load this outlet"
        description={exploreOutletErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (outlet) {
    const summary = exploreAddressSummary(outlet.address);

    content = (
      <>
        <PageHeader title={outlet.name} subtitle={summary} />
        {outlet.description && <p className="text-sm text-muted">{outlet.description}</p>}

        <h2 className="mt-2 text-sm font-semibold uppercase tracking-wide text-muted">Upcoming menus</h2>
        {menus.length === 0 ? (
          <EmptyState title="No upcoming menus" description="Check back soon for a new menu." />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {menus.map((menu) => (
              <ExploreMenuCard
                key={menu.id}
                menu={menu}
                onClick={() => navigate(`/explore/outlets/${outlet.id}/menus/${menu.id}`)}
              />
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
          <IonTitle>Outlet</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <div>{backToExplore}</div>
          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}

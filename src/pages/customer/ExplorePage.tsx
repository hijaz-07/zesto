import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { Button } from '../../components/ui/Button';
import { exploreOutletsErrorMessage } from '../../features/explore/errors';
import { ExploreOutletCard } from '../../features/explore/ExploreOutletCard';
import { useExploreOutlets } from '../../features/explore/useExploreOutlets';

/**
 * `/explore` — the public customer discovery feed. No authentication and no
 * customer/organization affiliation required (see root CLAUDE.md's
 * "Customer capabilities" and the Step 9C task notes).
 */
export function ExplorePage() {
  const { status, outlets, error, retry } = useExploreOutlets();
  const navigate = useNavigate();

  let content;
  if (status === 'loading') {
    content = <LoadingState label="Loading outlets…" />;
  } else if (status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load outlets"
        description={exploreOutletsErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (outlets.length === 0) {
    content = (
      <EmptyState
        title="No outlets available"
        description="Check back soon for outlets with an upcoming menu."
      />
    );
  } else {
    content = (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {outlets.map((outlet) => (
          <ExploreOutletCard
            key={outlet.id}
            outlet={outlet}
            onClick={() => navigate(`/explore/outlets/${outlet.id}`)}
          />
        ))}
      </div>
    );
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Explore</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="flex flex-col gap-4 p-4">{content}</div>
      </IonContent>
    </IonPage>
  );
}

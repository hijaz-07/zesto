import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { ExploreOutletList } from '../../features/explore/ExploreOutletList';

/**
 * `/explore` — the public customer discovery feed. No authentication and no
 * customer/organization affiliation required (see root CLAUDE.md's
 * "Customer capabilities" and the Step 9C task notes).
 */
export function ExplorePage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Explore</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <ExploreOutletList />
        </div>
      </IonContent>
    </IonPage>
  );
}

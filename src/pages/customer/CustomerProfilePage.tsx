import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { EmptyState } from '../../components/common/EmptyState';

export function CustomerProfilePage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Profile</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <EmptyState
          title="Sign-in not implemented yet"
          description="Customer authentication will be added in a later phase."
        />
      </IonContent>
    </IonPage>
  );
}

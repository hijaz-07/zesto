import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { EmptyState } from '../../components/common/EmptyState';

export function CustomerOrdersPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Orders</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <EmptyState
          title="No orders yet"
          description="Your pre-orders will show up here once ordering is connected to a backend."
        />
      </IonContent>
    </IonPage>
  );
}

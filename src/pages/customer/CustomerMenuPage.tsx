import { IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { CustomerMenuView } from '../../features/customer/CustomerMenuView';
import { NotificationBell } from '../../features/notification/NotificationBell';

export function CustomerMenuPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Menu</IonTitle>
          <IonButtons slot="end">
            <NotificationBell />
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <CustomerMenuView />
      </IonContent>
    </IonPage>
  );
}

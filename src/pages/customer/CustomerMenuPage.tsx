import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { CustomerMenuView } from '../../features/customer/CustomerMenuView';

export function CustomerMenuPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Menu</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <CustomerMenuView />
      </IonContent>
    </IonPage>
  );
}

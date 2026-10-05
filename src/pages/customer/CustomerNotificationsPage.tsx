import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { NotificationsView } from '../../features/notification/NotificationsView';
import type { NotificationScope } from '../../features/notification/types';

const CUSTOMER_SCOPE: NotificationScope = { kind: 'customer' };

/**
 * `/app/notifications` — the signed-in customer's own notifications. The
 * customer is whoever the session says: nothing about who they are is read from
 * the URL, a prop or storage.
 */
export function CustomerNotificationsPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Notifications</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <NotificationsView scope={CUSTOMER_SCOPE} />
      </IonContent>
    </IonPage>
  );
}

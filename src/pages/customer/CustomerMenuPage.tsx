import { IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { PageHeader } from '../../components/common/PageHeader';
import { ExploreOutletList } from '../../features/explore/ExploreOutletList';
import { NotificationBell } from '../../features/notification/NotificationBell';

/** The signed-in customer's home tab: the real upcoming menus, from the same feed as `/explore`. */
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
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Upcoming menus" subtitle="Choose an outlet to see its next menu and pre-order." />
          <ExploreOutletList />
        </div>
      </IonContent>
    </IonPage>
  );
}

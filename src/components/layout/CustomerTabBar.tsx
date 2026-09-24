import { IonIcon, IonLabel, IonTabBar, IonTabButton } from '@ionic/react';
import { fastFoodOutline, personOutline, receiptOutline } from 'ionicons/icons';

export function CustomerTabBar() {
  return (
    <IonTabBar slot="bottom">
      <IonTabButton tab="menu" href="/app/menu">
        <IonIcon icon={fastFoodOutline} />
        <IonLabel>Menu</IonLabel>
      </IonTabButton>
      <IonTabButton tab="orders" href="/app/orders">
        <IonIcon icon={receiptOutline} />
        <IonLabel>Orders</IonLabel>
      </IonTabButton>
      <IonTabButton tab="profile" href="/app/profile">
        <IonIcon icon={personOutline} />
        <IonLabel>Profile</IonLabel>
      </IonTabButton>
    </IonTabBar>
  );
}

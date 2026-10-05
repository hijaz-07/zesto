import { IonButtons, IonHeader, IonMenuButton, IonTitle, IonToolbar } from '@ionic/react';
import { NotificationBell } from '../../features/notification/NotificationBell';

export interface OrganizationPageToolbarProps {
  title: string;
}

export function OrganizationPageToolbar({ title }: OrganizationPageToolbarProps) {
  return (
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonMenuButton />
        </IonButtons>
        <IonTitle>{title}</IonTitle>
        <IonButtons slot="end">
          <NotificationBell />
        </IonButtons>
      </IonToolbar>
    </IonHeader>
  );
}

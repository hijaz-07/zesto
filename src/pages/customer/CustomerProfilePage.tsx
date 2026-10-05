import { IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { EmptyState } from '../../components/common/EmptyState';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../features/auth/useAuth';
import { NotificationBell } from '../../features/notification/NotificationBell';

export function CustomerProfilePage() {
  const { user, signOut } = useAuth();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Profile</IonTitle>
          <IonButtons slot="end">
            <NotificationBell />
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <EmptyState
          title={user?.name || user?.phone || 'Signed in'}
          description="Profile details will be added in a later phase."
          action={
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          }
        />
      </IonContent>
    </IonPage>
  );
}

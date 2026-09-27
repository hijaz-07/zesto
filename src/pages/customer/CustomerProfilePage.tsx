import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { EmptyState } from '../../components/common/EmptyState';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../features/auth/useAuth';

export function CustomerProfilePage() {
  const { user, signOut } = useAuth();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Profile</IonTitle>
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

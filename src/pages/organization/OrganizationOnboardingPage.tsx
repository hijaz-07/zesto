import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import type { OrganizationWithRole } from '../../domain/types';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../features/auth/useAuth';
import type { CreateOrganizationInput } from '../../features/organization/api';
import { CreateOrganizationForm } from '../../features/organization/CreateOrganizationForm';

export interface OrganizationOnboardingPageProps {
  createOrganization: (input: CreateOrganizationInput) => Promise<OrganizationWithRole>;
  onCreated: () => void;
}

export function OrganizationOnboardingPage({ createOrganization, onCreated }: OrganizationOnboardingPageProps) {
  const { signOut } = useAuth();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Zesto</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="mx-auto flex min-h-full max-w-md flex-col gap-8 p-6">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-text">Set up your organization</h1>
            <p className="mt-2 text-sm text-muted">
              An organization is your canteen, café, or restaurant on Zesto. Once it&apos;s
              created, you can publish menus and start collecting demand from customers.
            </p>
          </div>

          <CreateOrganizationForm createOrganization={createOrganization} onCreated={onCreated} />

          <div className="text-center">
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
}

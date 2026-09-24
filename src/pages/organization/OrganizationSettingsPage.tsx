import { IonContent, IonPage } from '@ionic/react';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { EmptyState } from '../../components/common/EmptyState';

export function OrganizationSettingsPage() {
  return (
    <IonPage>
      <OrganizationPageToolbar title="Settings" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Settings" subtitle="Organization profile, outlets, and members." />
          <EmptyState
            title="Settings not implemented yet"
            description="Organization authentication and profile management will be added in a later phase."
          />
        </div>
      </IonContent>
    </IonPage>
  );
}

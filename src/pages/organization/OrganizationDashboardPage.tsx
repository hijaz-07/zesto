import { IonContent, IonPage } from '@ionic/react';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { OrganizationMenuOverview } from '../../features/organization/OrganizationMenuOverview';

export function OrganizationDashboardPage() {
  return (
    <IonPage>
      <OrganizationPageToolbar title="Dashboard" />
      <IonContent>
        <OrganizationMenuOverview />
      </IonContent>
    </IonPage>
  );
}

import { IonContent, IonPage } from '@ionic/react';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { DemandOverview } from '../../features/organization/DemandOverview';
import { demandOverview } from '../../features/organization/data';

export function OrganizationAnalyticsPage() {
  return (
    <IonPage>
      <OrganizationPageToolbar title="Analytics" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Analytics" subtitle="Demand trends for planning ahead." />
          <DemandOverview lines={demandOverview} />
        </div>
      </IonContent>
    </IonPage>
  );
}

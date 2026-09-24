import { IonContent, IonPage } from '@ionic/react';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { EmptyState } from '../../components/common/EmptyState';

export function OrganizationOrdersPage() {
  return (
    <IonPage>
      <OrganizationPageToolbar title="Orders" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Orders" subtitle="Monitor incoming pre-orders as they arrive." />
          <EmptyState
            title="No orders to monitor yet"
            description="Live order monitoring will appear here once ordering is connected to a backend."
          />
        </div>
      </IonContent>
    </IonPage>
  );
}

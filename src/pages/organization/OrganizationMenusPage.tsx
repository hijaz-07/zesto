import { IonContent, IonPage } from '@ionic/react';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { PageHeader } from '../../components/common/PageHeader';
import { EmptyState } from '../../components/common/EmptyState';
import { Button } from '../../components/ui/Button';

export function OrganizationMenusPage() {
  return (
    <IonPage>
      <OrganizationPageToolbar title="Menus" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Menus" subtitle="Manage upcoming and past menus." />
          <EmptyState
            title="Only tomorrow's menu exists in this preview"
            description="Menu history and multi-day planning will appear here once menu persistence is implemented."
            action={<Button variant="secondary">Go to tomorrow's menu</Button>}
          />
        </div>
      </IonContent>
    </IonPage>
  );
}

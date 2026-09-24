import { IonIcon } from '@ionic/react';
import { addOutline, createOutline } from 'ionicons/icons';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/common/PageHeader';
import { demandOverview, tomorrowsOrgMenu } from './data';
import { MenuScheduleSummary } from './MenuScheduleSummary';
import { MenuItemsTable } from './MenuItemsTable';
import { DemandOverview } from './DemandOverview';

export function OrganizationMenuOverview() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title={tomorrowsOrgMenu.title}
        subtitle="Menu controls shown here are not yet connected to a backend."
        actions={
          <>
            <Button variant="secondary">
              <IonIcon icon={createOutline} />
              Edit menu
            </Button>
            <Button variant="primary">
              <IonIcon icon={addOutline} />
              Add item
            </Button>
          </>
        }
      />
      <MenuScheduleSummary menu={tomorrowsOrgMenu} />
      <MenuItemsTable items={tomorrowsOrgMenu.items} />
      <DemandOverview lines={demandOverview} />
    </div>
  );
}

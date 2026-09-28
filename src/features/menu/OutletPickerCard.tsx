import { IonIcon } from '@ionic/react';
import { chevronForwardOutline } from 'ionicons/icons';
import type { Outlet } from '../../domain/types';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';

export interface OutletPickerCardProps {
  outlet: Outlet;
  onOpenMenus: () => void;
}

/** A short "city, state" summary, or `undefined` if the outlet has neither. */
function addressSummary(outlet: Outlet): string | undefined {
  const parts = [outlet.address?.city, outlet.address?.state].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * One outlet in the `/org/menus` outlet picker. Inactive outlets are shown
 * like any other — they can still be opened to view their existing menus;
 * only menu *creation* is blocked, and only once inside that outlet's menu
 * list (see `OrganizationOutletMenusPage`).
 */
export function OutletPickerCard({ outlet, onOpenMenus }: OutletPickerCardProps) {
  const summary = addressSummary(outlet);

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-text">{outlet.name}</h3>
        <Badge tone={outlet.status === 'active' ? 'success' : 'neutral'}>
          {outlet.status === 'active' ? 'ACTIVE' : 'INACTIVE'}
        </Badge>
      </div>
      {outlet.description && <p className="text-sm text-muted">{outlet.description}</p>}
      {summary && <p className="text-xs text-muted">{summary}</p>}
      <div className="mt-2">
        <Button onClick={onOpenMenus} aria-label={`Open Menus for ${outlet.name}`}>
          Open Menus
          <IonIcon icon={chevronForwardOutline} />
        </Button>
      </div>
    </Card>
  );
}

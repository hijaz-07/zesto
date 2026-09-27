import { IonIcon } from '@ionic/react';
import { createOutline } from 'ionicons/icons';
import type { Outlet } from '../../domain/types';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';

export interface OutletCardProps {
  outlet: Outlet;
  onEdit: () => void;
}

/** A short "city, state" summary, or `undefined` if the outlet has neither. */
function addressSummary(outlet: Outlet): string | undefined {
  const parts = [outlet.address?.city, outlet.address?.state].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function OutletCard({ outlet, onEdit }: OutletCardProps) {
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
        <Button variant="secondary" onClick={onEdit}>
          <IonIcon icon={createOutline} />
          Edit
        </Button>
      </div>
    </Card>
  );
}

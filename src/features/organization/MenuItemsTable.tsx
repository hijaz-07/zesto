import { IonIcon } from '@ionic/react';
import { createOutline, trashOutline } from 'ionicons/icons';
import type { MenuItem } from '../../domain/types';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';

export interface MenuItemsTableProps {
  items: MenuItem[];
}

export function MenuItemsTable({ items }: MenuItemsTableProps) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <th className="px-4 py-3 font-medium">Item</th>
            <th className="px-4 py-3 font-medium">Price</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3 font-medium text-text">{item.name}</td>
              <td className="px-4 py-3 text-text">{formatPaiseAsRupees(item.priceInPaise)}</td>
              <td className="px-4 py-3">
                <Badge tone={item.enabled ? 'success' : 'neutral'}>
                  {item.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Button variant="secondary" className="px-2 py-1">
                    <IonIcon icon={createOutline} />
                    Edit
                  </Button>
                  <Button variant={item.enabled ? 'secondary' : 'primary'} className="px-2 py-1">
                    {item.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="danger" className="px-2 py-1">
                    <IonIcon icon={trashOutline} />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

import type { ReactNode } from 'react';
import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';
import type { ExploreMenuItem } from './types';

export interface ExploreMenuItemCardProps {
  item: ExploreMenuItem;
  /** Optional slot rendered under the price, e.g. cart quantity controls. Omitted entirely, this renders as a plain read-only item. */
  quantityControl?: ReactNode;
}

/**
 * A published menu item. Purely presentational: it has no cart/quantity
 * logic of its own, and renders read-only when `quantityControl` is
 * omitted. Disabled items never reach this component: the public API
 * already omits them.
 */
export function ExploreMenuItemCard({ item, quantityControl }: ExploreMenuItemCardProps) {
  return (
    <Card className="flex items-center justify-between gap-3">
      <div>
        <p className="font-medium text-text">{item.name}</p>
        {item.description && <p className="text-sm text-muted">{item.description}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <p className="text-sm font-semibold text-text">{formatPaiseAsRupees(item.priceInPaise)}</p>
        {quantityControl}
      </div>
    </Card>
  );
}

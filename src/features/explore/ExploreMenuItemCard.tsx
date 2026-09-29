import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';
import type { ExploreMenuItem } from './types';

export interface ExploreMenuItemCardProps {
  item: ExploreMenuItem;
}

/**
 * A read-only published menu item. No quantity control and no "Add to
 * cart" — ordering is out of scope for this checkpoint (see root
 * CLAUDE.md's "Menu editing" and the Step 9C task notes). Disabled items
 * never reach this component: the public API already omits them.
 */
export function ExploreMenuItemCard({ item }: ExploreMenuItemCardProps) {
  return (
    <Card className="flex items-center justify-between gap-3">
      <div>
        <p className="font-medium text-text">{item.name}</p>
        {item.description && <p className="text-sm text-muted">{item.description}</p>}
      </div>
      <p className="shrink-0 text-sm font-semibold text-text">{formatPaiseAsRupees(item.priceInPaise)}</p>
    </Card>
  );
}

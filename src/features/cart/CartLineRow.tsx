import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { ExploreMenuItem } from '../explore/types';
import { formatPaiseAsRupees } from '../../utils/currency';
import { CartItemQuantityControls } from './CartItemQuantityControls';
import type { CartContext, CartLine } from './types';

export interface CartLineRowProps {
  context: CartContext;
  line: CartLine;
  /** The same item as it currently appears on the live published menu, or `undefined` if it's gone (disabled/deleted) — only meaningful once `menuChecked` is true. */
  liveItem: ExploreMenuItem | undefined;
  /** Whether the live menu has finished loading, so "no longer available" can be told apart from "still checking". */
  menuChecked: boolean;
  onRemove: () => void;
}

/**
 * One line in the cart preview. Always renders the line's own snapshot
 * (name/price) as the source of truth for the subtotal — a changed or
 * missing live item is surfaced as a note, never silently applied to the
 * snapshot (see root CLAUDE.md's "Menu editing" and the Step 11A task notes).
 */
export function CartLineRow({ context, line, liveItem, menuChecked, onRemove }: CartLineRowProps) {
  const isUnavailable = menuChecked && !liveItem;
  const priceChanged = liveItem !== undefined && liveItem.priceInPaise !== line.priceInPaise;
  const lineTotalInPaise = line.priceInPaise * line.quantity;

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-text">{line.name}</p>
          {line.description && <p className="text-sm text-muted">{line.description}</p>}
          <p className="mt-1 text-sm text-muted">
            {formatPaiseAsRupees(line.priceInPaise)} each · {formatPaiseAsRupees(lineTotalInPaise)}
          </p>
          {isUnavailable && <p className="mt-1 text-xs text-danger">No longer available on this menu.</p>}
          {priceChanged && liveItem && (
            <p className="mt-1 text-xs text-warning">
              Price on the menu is now {formatPaiseAsRupees(liveItem.priceInPaise)}.
            </p>
          )}
        </div>
        <Button variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <CartItemQuantityControls
        context={context}
        item={{
          itemId: line.itemId,
          name: line.name,
          description: line.description,
          priceInPaise: line.priceInPaise,
        }}
        disabled={isUnavailable}
      />
    </Card>
  );
}

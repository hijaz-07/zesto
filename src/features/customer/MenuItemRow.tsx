import { IonIcon } from '@ionic/react';
import { addOutline, removeOutline } from 'ionicons/icons';
import type { MenuItem } from '../../domain/types';
import { useQuantitySelector } from '../../hooks/useQuantitySelector';
import { formatPaiseAsRupees } from '../../utils/currency';
import { Card } from '../../components/ui/Card';

export interface MenuItemRowProps {
  item: MenuItem;
}

export function MenuItemRow({ item }: MenuItemRowProps) {
  const { quantity, increment, decrement } = useQuantitySelector();

  return (
    <Card className="flex items-center justify-between gap-3">
      <div>
        <p className="font-medium text-text">{item.name}</p>
        {item.description && <p className="text-sm text-muted">{item.description}</p>}
        <p className="mt-1 text-sm font-semibold text-text">{formatPaiseAsRupees(item.priceInPaise)}</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={`Decrease quantity for ${item.name}`}
          onClick={decrement}
          disabled={quantity === 0}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-text disabled:opacity-40"
        >
          <IonIcon icon={removeOutline} />
        </button>
        <span
          data-testid={`quantity-${item.id}`}
          className="w-4 text-center text-sm font-medium text-text"
        >
          {quantity}
        </span>
        <button
          type="button"
          aria-label={`Increase quantity for ${item.name}`}
          onClick={increment}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-text"
        >
          <IonIcon icon={addOutline} />
        </button>
      </div>
    </Card>
  );
}

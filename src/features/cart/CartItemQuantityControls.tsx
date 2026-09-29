import { IonIcon } from '@ionic/react';
import { addOutline, removeOutline } from 'ionicons/icons';
import { useCart } from './useCart';
import type { CartContext, CartItemSnapshot } from './types';

export interface CartItemQuantityControlsProps {
  context: CartContext;
  item: CartItemSnapshot;
  /** True while adding would conflict with the cart's existing context (see `cartHasContextConflict`) — disables increment so a tap never silently no-ops. */
  disabled?: boolean;
}

/** The +/- stepper for one menu item, backed directly by the shared cart. */
export function CartItemQuantityControls({ context, item, disabled = false }: CartItemQuantityControlsProps) {
  const { cart, increment, decrement } = useCart();
  const quantity = cart.lines.find((line) => line.itemId === item.itemId)?.quantity ?? 0;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={`Decrease quantity for ${item.name}`}
        onClick={() => decrement(item.itemId)}
        disabled={quantity === 0}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-text disabled:opacity-40"
      >
        <IonIcon icon={removeOutline} />
      </button>
      <span
        data-testid={`cart-quantity-${item.itemId}`}
        className="w-4 text-center text-sm font-medium text-text"
      >
        {quantity}
      </span>
      <button
        type="button"
        aria-label={`Increase quantity for ${item.name}`}
        onClick={() => increment(context, item)}
        disabled={disabled}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-text disabled:opacity-40"
      >
        <IonIcon icon={addOutline} />
      </button>
    </div>
  );
}

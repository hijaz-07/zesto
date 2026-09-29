import type { Cart } from '../cart/types';

export interface CartOrderRequest {
  outletId: string;
  menuId: string;
  items: Array<{ itemId: string; quantity: number }>;
}

/**
 * Extracts the minimal order-creation payload from the cart: `outletId`/
 * `menuId`/`itemId`/`quantity` only — never a price, name, or any other
 * snapshot field, since the backend is the sole source of truth for those
 * (see functions/src/domain/orders.ts's `createOrder`). Returns `null` when
 * there is nothing to submit (no context, or no lines) — the caller must
 * treat that as "cart is empty," not send an empty request.
 *
 * The cart's own invariants (see `../cart/cart.ts`) already guarantee every
 * line shares one outlet/menu context and carries a positive integer
 * quantity, so this trusts that shape rather than re-validating it.
 */
export function cartToOrderRequest(cart: Cart): CartOrderRequest | null {
  if (!cart.context || cart.lines.length === 0) {
    return null;
  }

  return {
    outletId: cart.context.outletId,
    menuId: cart.context.menuId,
    items: cart.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
  };
}

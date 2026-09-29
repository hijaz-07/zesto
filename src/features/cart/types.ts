/**
 * Client-side cart types. This is a UI preview of customer demand only —
 * there is no backend order/payment yet (see root CLAUDE.md's "Demand-driven
 * ordering" and the Step 11A task notes). `priceInPaise` is always an
 * integer; never store or compute money as a float.
 */

/** Identifies which published outlet/menu a cart's lines belong to. A cart holds lines from exactly one context at a time. */
export interface CartContext {
  outletId: string;
  menuId: string;
}

/** The item data snapshotted into a cart line when it's added, independent of the live menu (see `CartLine`). */
export interface CartItemSnapshot {
  itemId: string;
  name: string;
  description?: string;
  priceInPaise: number;
}

/**
 * One selected item in the cart. Carries its own name/description/price
 * snapshot rather than just an `itemId` reference, so the cart still renders
 * correctly even if the published menu is edited afterward — mirroring the
 * business rule that a real order preserves its price at the time it was
 * placed (root CLAUDE.md's "Menu editing").
 */
export interface CartLine extends CartItemSnapshot {
  quantity: number;
}

/** `context` is `null` exactly when `lines` is empty — an empty cart belongs to no context yet. */
export interface Cart {
  context: CartContext | null;
  lines: CartLine[];
}

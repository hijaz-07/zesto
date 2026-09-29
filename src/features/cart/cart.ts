import type { Cart, CartContext, CartItemSnapshot, CartLine } from './types';

/** A cart with no context and no lines — the starting point, and what the cart returns to once its last line is removed. */
export function createEmptyCart(): Cart {
  return { context: null, lines: [] };
}

export function sameCartContext(a: CartContext, b: CartContext): boolean {
  return a.outletId === b.outletId && a.menuId === b.menuId;
}

/** True when `cart` already belongs to a different outlet/menu than `context` — adding to it would mix contexts. An empty cart never conflicts. */
export function cartHasContextConflict(cart: Cart, context: CartContext): boolean {
  return cart.context !== null && !sameCartContext(cart.context, context);
}

/**
 * Adds `item` to the cart, or increments its quantity by 1 if it's already
 * present. A no-op (returns `cart` unchanged) when `context` conflicts with
 * the cart's current context — callers must resolve that explicitly (e.g.
 * via `createEmptyCart()`) rather than have items silently mixed or a
 * previous selection silently discarded.
 */
export function addOrIncrementCartItem(cart: Cart, context: CartContext, item: CartItemSnapshot): Cart {
  if (cartHasContextConflict(cart, context)) {
    return cart;
  }

  const existingIndex = cart.lines.findIndex((line) => line.itemId === item.itemId);
  if (existingIndex === -1) {
    return { context, lines: [...cart.lines, { ...item, quantity: 1 }] };
  }

  const lines = cart.lines.map((line, index) =>
    index === existingIndex ? { ...line, quantity: line.quantity + 1 } : line,
  );
  return { context, lines };
}

/** Decrements an item's quantity by 1, removing the line entirely once it reaches 0. A no-op if the item isn't in the cart. */
export function decrementCartItem(cart: Cart, itemId: string): Cart {
  const existing = cart.lines.find((line) => line.itemId === itemId);
  if (!existing) {
    return cart;
  }
  if (existing.quantity <= 1) {
    return removeCartLine(cart, itemId);
  }

  const lines = cart.lines.map((line) =>
    line.itemId === itemId ? { ...line, quantity: line.quantity - 1 } : line,
  );
  return { ...cart, lines };
}

/** Removes an item's line entirely, regardless of quantity. Clears the cart's context once the last line is gone. */
export function removeCartLine(cart: Cart, itemId: string): Cart {
  const lines = cart.lines.filter((line) => line.itemId !== itemId);
  return { context: lines.length > 0 ? cart.context : null, lines };
}

export function cartSubtotalInPaise(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.priceInPaise * line.quantity, 0);
}

export function cartTotalQuantity(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}

function isCartContext(value: unknown): value is CartContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const context = value as Record<string, unknown>;
  return typeof context.outletId === 'string' && typeof context.menuId === 'string';
}

function isCartLine(value: unknown): value is CartLine {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const line = value as Record<string, unknown>;
  return (
    typeof line.itemId === 'string' &&
    typeof line.name === 'string' &&
    (line.description === undefined || typeof line.description === 'string') &&
    typeof line.priceInPaise === 'number' &&
    Number.isInteger(line.priceInPaise) &&
    line.priceInPaise >= 0 &&
    typeof line.quantity === 'number' &&
    Number.isInteger(line.quantity) &&
    line.quantity > 0
  );
}

/** Runtime shape check for a `Cart` read back from persistence — untrusted until validated (e.g. an older/corrupted localStorage value). */
export function isCart(value: unknown): value is Cart {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cart = value as Record<string, unknown>;
  if (cart.context !== null && !isCartContext(cart.context)) {
    return false;
  }
  if (!Array.isArray(cart.lines) || !cart.lines.every(isCartLine)) {
    return false;
  }
  if (cart.context === null && cart.lines.length > 0) {
    return false;
  }
  return true;
}

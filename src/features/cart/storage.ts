import { createEmptyCart, isCart } from './cart';
import type { Cart } from './types';

/** Namespaced so it can't collide with Descope's own session storage or any other key Zesto adds later. Bump the suffix if `Cart`'s shape ever changes incompatibly. */
const CART_STORAGE_KEY = 'zesto.cart.v1';

/** Reads the persisted cart, falling back to an empty cart if nothing is stored, storage is unavailable, or the stored value doesn't match the current `Cart` shape. */
export function loadCart(): Cart {
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) {
      return createEmptyCart();
    }
    const parsed: unknown = JSON.parse(raw);
    return isCart(parsed) ? parsed : createEmptyCart();
  } catch {
    return createEmptyCart();
  }
}

/** Persists the cart. Failures (private browsing, storage quota, disabled storage) are swallowed — the cart still works for the rest of this session from in-memory state. */
export function saveCart(cart: Cart): void {
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  } catch {
    // Ignore — see doc comment above.
  }
}

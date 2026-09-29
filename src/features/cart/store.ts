import { loadCart, saveCart } from './storage';
import type { Cart } from './types';

/**
 * A minimal external store for cart state, read via React's
 * `useSyncExternalStore` (see `useCart.ts`). This keeps the cart shared and
 * reactive across every component that reads it (the menu detail page, the
 * cart page, ...) without pulling in Context — the codebase has no global
 * state library, and a plain per-component `useState` couldn't stay in sync
 * across pages.
 */

let cartState: Cart = loadCart();
const listeners = new Set<() => void>();

export function getCartSnapshot(): Cart {
  return cartState;
}

export function subscribeCart(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replaces the cart, persists it, and notifies every subscriber. */
export function setCart(next: Cart): void {
  cartState = next;
  saveCart(next);
  for (const listener of listeners) {
    listener();
  }
}

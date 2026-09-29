import { useCallback, useSyncExternalStore } from 'react';
import { addOrIncrementCartItem, createEmptyCart, decrementCartItem, removeCartLine } from './cart';
import { getCartSnapshot, setCart, subscribeCart } from './store';
import type { Cart, CartContext, CartItemSnapshot } from './types';

export interface UseCartResult {
  cart: Cart;
  /** Adds `item` to the cart, or increments it if already present. No-ops if `context` conflicts with the cart's current context — see `cartHasContextConflict`. */
  increment: (context: CartContext, item: CartItemSnapshot) => void;
  decrement: (itemId: string) => void;
  removeLine: (itemId: string) => void;
  clearCart: () => void;
}

/** Reactive access to the shared cart (see `store.ts`), plus its mutating actions. Every mutation persists immediately. */
export function useCart(): UseCartResult {
  const cart = useSyncExternalStore(subscribeCart, getCartSnapshot);

  const increment = useCallback((context: CartContext, item: CartItemSnapshot) => {
    setCart(addOrIncrementCartItem(getCartSnapshot(), context, item));
  }, []);

  const decrement = useCallback((itemId: string) => {
    setCart(decrementCartItem(getCartSnapshot(), itemId));
  }, []);

  const removeLine = useCallback((itemId: string) => {
    setCart(removeCartLine(getCartSnapshot(), itemId));
  }, []);

  const clearCart = useCallback(() => {
    setCart(createEmptyCart());
  }, []);

  return { cart, increment, decrement, removeLine, clearCart };
}

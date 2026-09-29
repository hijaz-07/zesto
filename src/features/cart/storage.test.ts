import { beforeEach, describe, expect, it } from 'vitest';
import { addOrIncrementCartItem, createEmptyCart } from './cart';
import { loadCart, saveCart } from './storage';
import type { CartContext, CartItemSnapshot } from './types';

const context: CartContext = { outletId: 'outlet-1', menuId: 'menu-1' };
const biriyani: CartItemSnapshot = { itemId: 'item-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000 };

describe('cart storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty cart when nothing is stored', () => {
    expect(loadCart()).toEqual(createEmptyCart());
  });

  it('round-trips a saved cart, namespaced under a Zesto-specific key', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), context, biriyani);

    saveCart(cart);

    expect(window.localStorage.getItem('zesto.cart.v1')).not.toBeNull();
    expect(loadCart()).toEqual(cart);
  });

  it('never touches any Descope session storage key', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), context, biriyani);
    saveCart(cart);

    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      expect(key?.toLowerCase()).not.toContain('descope');
      expect(key?.toLowerCase()).not.toContain('session');
    }
  });

  it('falls back to an empty cart when the stored value is corrupted JSON', () => {
    window.localStorage.setItem('zesto.cart.v1', '{not valid json');

    expect(loadCart()).toEqual(createEmptyCart());
  });

  it('falls back to an empty cart when the stored value has an unexpected shape', () => {
    window.localStorage.setItem('zesto.cart.v1', JSON.stringify({ some: 'unrelated shape' }));

    expect(loadCart()).toEqual(createEmptyCart());
  });
});

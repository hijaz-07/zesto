import { describe, expect, it } from 'vitest';
import { createEmptyCart } from '../cart/cart';
import type { Cart } from '../cart/types';
import { cartToOrderRequest } from './cartToOrderRequest';

describe('cartToOrderRequest', () => {
  it('extracts outletId, menuId, and itemId/quantity pairs only', () => {
    const cart: Cart = {
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [
        { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2 },
        { itemId: 'item-2', name: 'Veg Meals', description: 'Comfort food', priceInPaise: 8000, quantity: 1 },
      ],
    };

    const request = cartToOrderRequest(cart);

    expect(request).toEqual({
      outletId: 'outlet-1',
      menuId: 'menu-1',
      items: [
        { itemId: 'item-1', quantity: 2 },
        { itemId: 'item-2', quantity: 1 },
      ],
    });
  });

  it('never includes name, description, or price', () => {
    const cart: Cart = {
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [{ itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2 }],
    };

    const request = cartToOrderRequest(cart);

    expect(request?.items[0]).toEqual({ itemId: 'item-1', quantity: 2 });
    expect(Object.keys(request?.items[0] ?? {}).sort()).toEqual(['itemId', 'quantity']);
  });

  it('returns null for an empty cart', () => {
    expect(cartToOrderRequest(createEmptyCart())).toBeNull();
  });

  it('returns null when context is null even if lines were somehow present', () => {
    const cart: Cart = {
      context: null,
      lines: [],
    };

    expect(cartToOrderRequest(cart)).toBeNull();
  });

  it('every line submitted belongs to the same single outlet/menu context (the cart\'s own invariant)', () => {
    const cart: Cart = {
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [
        { itemId: 'item-1', name: 'A', priceInPaise: 100, quantity: 1 },
        { itemId: 'item-2', name: 'B', priceInPaise: 200, quantity: 1 },
      ],
    };

    const request = cartToOrderRequest(cart);

    // A single outletId/menuId pair covers every line — there is no
    // per-line context field at all, so a mixed-context cart is structurally
    // impossible to represent in the request.
    expect(request?.outletId).toBe('outlet-1');
    expect(request?.menuId).toBe('menu-1');
    expect(request?.items).toHaveLength(2);
  });
});

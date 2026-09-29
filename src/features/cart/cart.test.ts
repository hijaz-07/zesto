import { describe, expect, it } from 'vitest';
import {
  addOrIncrementCartItem,
  cartHasContextConflict,
  cartSubtotalInPaise,
  cartTotalQuantity,
  createEmptyCart,
  decrementCartItem,
  isCart,
  removeCartLine,
  sameCartContext,
} from './cart';
import type { CartContext, CartItemSnapshot } from './types';

const outletMenu: CartContext = { outletId: 'outlet-1', menuId: 'menu-1' };
const otherOutletMenu: CartContext = { outletId: 'outlet-2', menuId: 'menu-2' };

const biriyani: CartItemSnapshot = {
  itemId: 'item-biriyani',
  name: 'Chicken Biriyani',
  description: 'Slow-cooked basmati rice with spiced chicken.',
  priceInPaise: 12000,
};

const vegMeals: CartItemSnapshot = {
  itemId: 'item-veg-meals',
  name: 'Veg Meals',
  priceInPaise: 8000,
};

describe('createEmptyCart', () => {
  it('has no context and no lines', () => {
    expect(createEmptyCart()).toEqual({ context: null, lines: [] });
  });
});

describe('addOrIncrementCartItem', () => {
  it('adds the first item with quantity 1 and adopts the context', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);

    expect(cart.context).toEqual(outletMenu);
    expect(cart.lines).toEqual([{ ...biriyani, quantity: 1 }]);
  });

  it('increments the quantity of an item already in the cart', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, biriyani);

    expect(cart.lines).toEqual([{ ...biriyani, quantity: 2 }]);
  });

  it('adds a second, different item alongside the first within the same context', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, vegMeals);

    expect(cart.lines).toHaveLength(2);
    expect(cart.lines.map((line) => line.itemId)).toEqual(['item-biriyani', 'item-veg-meals']);
  });

  it('preserves priceInPaise exactly, without any floating-point conversion', () => {
    const oddPrice: CartItemSnapshot = { itemId: 'item-x', name: 'Item X', priceInPaise: 9999 };
    const cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, oddPrice);

    expect(cart.lines[0].priceInPaise).toBe(9999);
    expect(Number.isInteger(cart.lines[0].priceInPaise)).toBe(true);
  });

  it('does not mix items from a different outlet/menu context into an existing cart', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);

    const result = addOrIncrementCartItem(cart, otherOutletMenu, vegMeals);

    expect(result).toBe(cart);
    expect(result.context).toEqual(outletMenu);
    expect(result.lines).toHaveLength(1);
  });

  it('lets a different context start fresh once the cart is empty', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), otherOutletMenu, vegMeals);

    expect(cart.context).toEqual(otherOutletMenu);
    expect(cart.lines).toEqual([{ ...vegMeals, quantity: 1 }]);
  });
});

describe('cartHasContextConflict', () => {
  it('is false for an empty cart regardless of context', () => {
    expect(cartHasContextConflict(createEmptyCart(), outletMenu)).toBe(false);
  });

  it('is false when the context matches the cart', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    expect(cartHasContextConflict(cart, outletMenu)).toBe(false);
  });

  it('is true when the context differs from the cart', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    expect(cartHasContextConflict(cart, otherOutletMenu)).toBe(true);
  });
});

describe('decrementCartItem', () => {
  it('decrements a quantity above 1', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, biriyani);

    cart = decrementCartItem(cart, biriyani.itemId);

    expect(cart.lines).toEqual([{ ...biriyani, quantity: 1 }]);
  });

  it('removes the line entirely when decrementing from 1', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = decrementCartItem(cart, biriyani.itemId);

    expect(cart.lines).toEqual([]);
    expect(cart.context).toBeNull();
  });

  it('is a no-op for an item not in the cart', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    const result = decrementCartItem(cart, 'item-not-present');

    expect(result).toBe(cart);
  });

  it('is a no-op on an empty cart', () => {
    const empty = createEmptyCart();
    expect(decrementCartItem(empty, biriyani.itemId)).toBe(empty);
  });
});

describe('removeCartLine', () => {
  it('removes only the targeted line, keeping the context while other lines remain', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, vegMeals);

    cart = removeCartLine(cart, biriyani.itemId);

    expect(cart.lines).toEqual([{ ...vegMeals, quantity: 1 }]);
    expect(cart.context).toEqual(outletMenu);
  });

  it('clears the context once the last line is removed', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = removeCartLine(cart, biriyani.itemId);

    expect(cart).toEqual(createEmptyCart());
  });

  it('removes a line regardless of its quantity', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, biriyani);

    cart = removeCartLine(cart, biriyani.itemId);

    expect(cart.lines).toEqual([]);
  });
});

describe('cartSubtotalInPaise', () => {
  it('is 0 for an empty cart', () => {
    expect(cartSubtotalInPaise(createEmptyCart())).toBe(0);
  });

  it('sums price times quantity across all lines using integer arithmetic', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani); // 12000 x1
    cart = addOrIncrementCartItem(cart, outletMenu, biriyani); // 12000 x2
    cart = addOrIncrementCartItem(cart, outletMenu, vegMeals); // 8000 x1

    expect(cartSubtotalInPaise(cart)).toBe(12000 * 2 + 8000);
  });
});

describe('cartTotalQuantity', () => {
  it('is 0 for an empty cart', () => {
    expect(cartTotalQuantity(createEmptyCart())).toBe(0);
  });

  it('sums quantities across all lines', () => {
    let cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, biriyani);
    cart = addOrIncrementCartItem(cart, outletMenu, vegMeals);

    expect(cartTotalQuantity(cart)).toBe(3);
  });
});

describe('sameCartContext', () => {
  it('is true for two contexts with the same outlet and menu', () => {
    expect(sameCartContext(outletMenu, { ...outletMenu })).toBe(true);
  });

  it('is false when either id differs', () => {
    expect(sameCartContext(outletMenu, { ...outletMenu, menuId: 'menu-2' })).toBe(false);
    expect(sameCartContext(outletMenu, { ...outletMenu, outletId: 'outlet-2' })).toBe(false);
  });
});

describe('isCart', () => {
  it('accepts an empty cart', () => {
    expect(isCart(createEmptyCart())).toBe(true);
  });

  it('accepts a cart with valid lines', () => {
    const cart = addOrIncrementCartItem(createEmptyCart(), outletMenu, biriyani);
    expect(isCart(cart)).toBe(true);
  });

  it('rejects a non-empty lines array with a null context', () => {
    const malformed: unknown = { context: null, lines: [{ ...biriyani, quantity: 1 }] };
    expect(isCart(malformed)).toBe(false);
  });

  it('rejects a line with a non-integer price', () => {
    const malformed: unknown = {
      context: outletMenu,
      lines: [{ ...biriyani, priceInPaise: 99.5, quantity: 1 }],
    };
    expect(isCart(malformed)).toBe(false);
  });

  it('rejects a line with a zero or negative quantity', () => {
    const malformed: unknown = { context: outletMenu, lines: [{ ...biriyani, quantity: 0 }] };
    expect(isCart(malformed)).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(isCart(null)).toBe(false);
    expect(isCart('not a cart')).toBe(false);
    expect(isCart(42)).toBe(false);
    expect(isCart({})).toBe(false);
  });
});

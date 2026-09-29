import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyCart } from './cart';
import { setCart } from './store';
import { useCart } from './useCart';
import type { CartContext, CartItemSnapshot } from './types';

const context: CartContext = { outletId: 'outlet-1', menuId: 'menu-1' };
const otherContext: CartContext = { outletId: 'outlet-2', menuId: 'menu-2' };
const biriyani: CartItemSnapshot = { itemId: 'item-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000 };

describe('useCart', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setCart(createEmptyCart());
  });

  it('starts empty', () => {
    const { result } = renderHook(() => useCart());
    expect(result.current.cart).toEqual(createEmptyCart());
  });

  it('adds and increments an item', () => {
    const { result } = renderHook(() => useCart());

    act(() => result.current.increment(context, biriyani));
    expect(result.current.cart.lines).toEqual([{ ...biriyani, quantity: 1 }]);

    act(() => result.current.increment(context, biriyani));
    expect(result.current.cart.lines).toEqual([{ ...biriyani, quantity: 2 }]);
  });

  it('decrements and removes at zero', () => {
    const { result } = renderHook(() => useCart());

    act(() => result.current.increment(context, biriyani));
    act(() => result.current.decrement(biriyani.itemId));

    expect(result.current.cart.lines).toEqual([]);
  });

  it('removes a line directly regardless of quantity', () => {
    const { result } = renderHook(() => useCart());

    act(() => result.current.increment(context, biriyani));
    act(() => result.current.increment(context, biriyani));
    act(() => result.current.removeLine(biriyani.itemId));

    expect(result.current.cart.lines).toEqual([]);
  });

  it('clears the cart entirely', () => {
    const { result } = renderHook(() => useCart());

    act(() => result.current.increment(context, biriyani));
    act(() => result.current.clearCart());

    expect(result.current.cart).toEqual(createEmptyCart());
  });

  it('does not add an item from a conflicting outlet/menu context', () => {
    const { result } = renderHook(() => useCart());

    act(() => result.current.increment(context, biriyani));
    act(() => result.current.increment(otherContext, biriyani));

    expect(result.current.cart.context).toEqual(context);
    expect(result.current.cart.lines).toHaveLength(1);
  });

  it('shares state across every hook instance, like two components reading the same cart', () => {
    const a = renderHook(() => useCart());
    const b = renderHook(() => useCart());

    act(() => a.result.current.increment(context, biriyani));

    expect(b.result.current.cart.lines).toEqual([{ ...biriyani, quantity: 1 }]);
  });

  it('persists every mutation so a fresh read picks it up, matching a page refresh', () => {
    const { result } = renderHook(() => useCart());

    act(() => result.current.increment(context, biriyani));

    const persisted = window.localStorage.getItem('zesto.cart.v1');
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted as string)).toEqual({
      context,
      lines: [{ ...biriyani, quantity: 1 }],
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { Cart } from '../cart/types';
import type { ExploreMenuDetail } from '../explore/types';
import { computeCartStaleness } from './staleness';

const menu: ExploreMenuDetail = {
  id: 'menu-1',
  menuDate: '2026-09-29',
  title: 'Tuesday Special Menu',
  orderingOpensAt: '2026-09-28T04:00:00+05:30',
  orderingClosesAt: '2026-09-29T10:00:00+05:30',
  pickupStartsAt: '2026-09-29T12:00:00+05:30',
  pickupEndsAt: '2026-09-29T14:00:00+05:30',
  orderingState: 'open',
  items: [
    { id: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, displayOrder: 1 },
    { id: 'item-2', name: 'Veg Meals', priceInPaise: 8000, displayOrder: 2 },
  ],
};

function cartWith(lines: Cart['lines']): Cart {
  return { context: { outletId: 'outlet-1', menuId: 'menu-1' }, lines };
}

describe('computeCartStaleness', () => {
  it('reports not-ready while the live menu is still loading', () => {
    const cart = cartWith([{ itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 }]);

    expect(computeCartStaleness(cart, 'loading', null)).toEqual({ ready: false, issues: [] });
    expect(computeCartStaleness(cart, 'idle', null)).toEqual({ ready: false, issues: [] });
  });

  it('reports a single menu_unavailable issue when the live menu fetch failed', () => {
    const cart = cartWith([{ itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 }]);

    expect(computeCartStaleness(cart, 'error', null)).toEqual({
      ready: true,
      issues: [{ type: 'menu_unavailable' }],
    });
  });

  it('reports no issues when every line matches the live menu and ordering is open', () => {
    const cart = cartWith([
      { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2 },
      { itemId: 'item-2', name: 'Veg Meals', priceInPaise: 8000, quantity: 1 },
    ]);

    expect(computeCartStaleness(cart, 'ready', menu)).toEqual({ ready: true, issues: [] });
  });

  it('flags an item that no longer exists on the live menu', () => {
    const cart = cartWith([{ itemId: 'item-discontinued', name: 'Discontinued', priceInPaise: 5000, quantity: 1 }]);

    const result = computeCartStaleness(cart, 'ready', menu);

    expect(result.ready).toBe(true);
    expect(result.issues).toContainEqual({
      type: 'item_unavailable',
      itemId: 'item-discontinued',
      name: 'Discontinued',
    });
  });

  it('flags an item whose price has changed', () => {
    const cart = cartWith([{ itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 11000, quantity: 1 }]);

    const result = computeCartStaleness(cart, 'ready', menu);

    expect(result.issues).toContainEqual({
      type: 'price_changed',
      itemId: 'item-1',
      name: 'Chicken Biriyani',
      oldPriceInPaise: 11000,
      newPriceInPaise: 12000,
    });
  });

  it('flags ordering not yet open', () => {
    const cart = cartWith([{ itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 }]);
    const notOpenMenu = { ...menu, orderingState: 'not_open' as const };

    const result = computeCartStaleness(cart, 'ready', notOpenMenu);

    expect(result.issues).toContainEqual({ type: 'ordering_not_open' });
  });

  it('flags ordering closed', () => {
    const cart = cartWith([{ itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 }]);
    const closedMenu = { ...menu, orderingState: 'closed' as const };

    const result = computeCartStaleness(cart, 'ready', closedMenu);

    expect(result.issues).toContainEqual({ type: 'ordering_closed' });
  });

  it('can report multiple issues at once', () => {
    const cart = cartWith([
      { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 11000, quantity: 1 },
      { itemId: 'item-gone', name: 'Gone Item', priceInPaise: 5000, quantity: 1 },
    ]);
    const closedMenu = { ...menu, orderingState: 'closed' as const };

    const result = computeCartStaleness(cart, 'ready', closedMenu);

    expect(result.issues).toHaveLength(3);
  });
});

import type { Cart } from '../cart/types';
import type { ExploreMenuDetail } from '../explore/types';
import type { ExploreMenuState } from '../explore/useExploreMenu';

/**
 * One way the cart's snapshot has drifted from the live published menu, or
 * from the menu's own orderability, since the cart was built. Never
 * resolved automatically — the customer must explicitly go back to the
 * cart and fix it (see root CLAUDE.md's "Menu editing" and this
 * checkpoint's "Stale cart / menu validation" notes).
 */
export type StalenessIssue =
  | { type: 'item_unavailable'; itemId: string; name: string }
  | { type: 'price_changed'; itemId: string; name: string; oldPriceInPaise: number; newPriceInPaise: number }
  | { type: 'ordering_not_open' }
  | { type: 'ordering_closed' }
  | { type: 'menu_unavailable' };

export interface CartStalenessResult {
  /** Whether staleness has actually been determined yet (the live-menu fetch finished, success or error). `false` means "still checking" — never treat it as "no issues." */
  ready: boolean;
  issues: StalenessIssue[];
}

const CHECKING: CartStalenessResult = { ready: false, issues: [] };

/**
 * Compares the cart's item/price snapshot against the live published menu.
 * Purely a report — it never mutates the cart, only surfaces what changed
 * so `OrderReviewSection` can block submission and let the customer resolve
 * it explicitly.
 *
 * `menuStatus === 'error'` (the menu no longer resolves at all — deleted,
 * unpublished, or its outlet gone inactive; `useExploreMenu`'s backend
 * folds all of these into one 404, see functions/src/routes/explore.ts)
 * is reported as a single `menu_unavailable` issue rather than checked line
 * by line, since there is no live item data to compare against at all.
 *
 * @param {Cart} cart The current cart.
 * @param {ExploreMenuState['status']} menuStatus `useExploreMenu`'s status for the cart's own outlet/menu context.
 * @param {ExploreMenuDetail | null} menu The live menu, once `menuStatus === 'ready'`.
 * @return {CartStalenessResult} Whether staleness is known yet, and every issue found.
 */
export function computeCartStaleness(
  cart: Cart,
  menuStatus: ExploreMenuState['status'],
  menu: ExploreMenuDetail | null,
): CartStalenessResult {
  if (menuStatus === 'error') {
    return { ready: true, issues: [{ type: 'menu_unavailable' }] };
  }
  if (menuStatus !== 'ready' || !menu) {
    return CHECKING;
  }

  const issues: StalenessIssue[] = [];

  if (menu.orderingState === 'not_open') {
    issues.push({ type: 'ordering_not_open' });
  } else if (menu.orderingState === 'closed') {
    issues.push({ type: 'ordering_closed' });
  }

  for (const line of cart.lines) {
    const liveItem = menu.items.find((item) => item.id === line.itemId);
    if (!liveItem) {
      issues.push({ type: 'item_unavailable', itemId: line.itemId, name: line.name });
    } else if (liveItem.priceInPaise !== line.priceInPaise) {
      issues.push({
        type: 'price_changed',
        itemId: line.itemId,
        name: line.name,
        oldPriceInPaise: line.priceInPaise,
        newPriceInPaise: liveItem.priceInPaise,
      });
    }
  }

  return { ready: true, issues };
}

import type { Menu } from '../menu/types';

/**
 * The menu the kitchen prepares for next: the earliest published menu whose
 * service date is today or later (business dates compare as `YYYY-MM-DD` strings).
 */
export function selectNextMenu(menus: readonly Menu[], today: string): Menu | null {
  const upcoming = menus
    .filter((menu) => menu.status === 'published' && menu.menuDate >= today)
    .sort((a, b) => a.menuDate.localeCompare(b.menuDate) || a.orderingOpensAt.localeCompare(b.orderingOpensAt));
  return upcoming[0] ?? null;
}

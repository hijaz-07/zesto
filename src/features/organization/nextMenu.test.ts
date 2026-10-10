import { describe, expect, it } from 'vitest';
import type { Menu, MenuStatus } from '../menu/types';
import { selectNextMenu } from './nextMenu';

function menu(id: string, menuDate: string, status: MenuStatus = 'published'): Menu {
  return {
    id,
    organizationId: 'org-1',
    outletId: 'outlet-1',
    menuDate,
    title: id,
    status,
    orderingOpensAt: `${menuDate}T00:00:00.000Z`,
    orderingClosesAt: `${menuDate}T03:30:00.000Z`,
    pickupStartsAt: `${menuDate}T07:00:00.000Z`,
    pickupEndsAt: `${menuDate}T08:30:00.000Z`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    createdBy: 'U-owner',
  };
}

describe('selectNextMenu', () => {
  it('picks the earliest published menu dated today or later', () => {
    const menus = [menu('later', '2026-10-13'), menu('past', '2026-10-09'), menu('next', '2026-10-11')];
    expect(selectNextMenu(menus, '2026-10-10')?.id).toBe('next');
  });

  it("includes today's menu", () => {
    expect(selectNextMenu([menu('today', '2026-10-10')], '2026-10-10')?.id).toBe('today');
  });

  it('ignores drafts and archived menus', () => {
    const menus = [menu('draft', '2026-10-11', 'draft'), menu('archived', '2026-10-11', 'archived')];
    expect(selectNextMenu(menus, '2026-10-10')).toBeNull();
  });

  it('returns null when nothing is upcoming', () => {
    expect(selectNextMenu([], '2026-10-10')).toBeNull();
  });
});

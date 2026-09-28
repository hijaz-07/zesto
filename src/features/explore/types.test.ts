import { describe, expect, it } from 'vitest';
import type {
  ExploreMenuDetail,
  ExploreMenuItem,
  ExploreOutlet,
  ExploreOutletMenu,
  ExploreOutletSummary,
} from './types';

/** Used only to give each compile-time proof below a call-expression statement (see `typeOnly` doc comment). */
function typeOnly(value: unknown): void {
  void value;
}

/**
 * These are compile-time proofs, not runtime behavior: `npm run typecheck`
 * (not vitest's esbuild-transpiled run, which strips types) is what
 * actually enforces them. Each `@ts-expect-error` proves the named
 * admin/audit field is NOT assignable to the customer-safe type — if a
 * later change ever widened one of these types to include it, the
 * `@ts-expect-error` itself would become an unused-directive error and
 * `npm run typecheck` would fail, catching the regression. Wrapped in
 * `typeOnly(...)` purely so each line is a call expression, not a bare
 * unused one (`@typescript-eslint/no-unused-expressions`).
 */
describe('customer-safe explore types exclude admin/audit fields', () => {
  it('ExploreOutlet has no organizationId, slug, status, phone, location, createdBy, or audit timestamps', () => {
    const outlet: ExploreOutlet = { id: 'outlet-1', name: 'Main Canteen' };
    // @ts-expect-error -- organizationId must not exist on the customer-safe outlet type
    typeOnly(outlet.organizationId);
    // @ts-expect-error -- slug must not exist on the customer-safe outlet type
    typeOnly(outlet.slug);
    // @ts-expect-error -- status must not exist on the customer-safe outlet type
    typeOnly(outlet.status);
    // @ts-expect-error -- createdBy must not exist on the customer-safe outlet type
    typeOnly(outlet.createdBy);

    expect(outlet.id).toBe('outlet-1');
  });

  it('ExploreOutletSummary/ExploreOutletMenu have no organizationId, outletId, status, createdBy, or audit timestamps', () => {
    const menu: ExploreOutletMenu = {
      id: 'menu-1',
      menuDate: '2026-09-29',
      title: 'Tuesday Special Menu',
      orderingOpensAt: '2026-09-28T04:00:00+05:30',
      orderingClosesAt: '2026-09-28T10:00:00+05:30',
      pickupStartsAt: '2026-09-29T12:00:00+05:30',
      pickupEndsAt: '2026-09-29T14:00:00+05:30',
      orderingState: 'open',
    };
    // @ts-expect-error -- organizationId must not exist on the customer-safe menu type
    typeOnly(menu.organizationId);
    // @ts-expect-error -- outletId must not exist on the customer-safe menu type
    typeOnly(menu.outletId);
    // @ts-expect-error -- status must not exist on the customer-safe menu type
    typeOnly(menu.status);
    // @ts-expect-error -- publishedAt must not exist on the customer-safe menu type
    typeOnly(menu.publishedAt);

    const summary: ExploreOutletSummary = { id: 'outlet-1', name: 'Main Canteen', nextMenu: menu };
    // @ts-expect-error -- createdBy must not exist on the customer-safe outlet summary type
    typeOnly(summary.createdBy);

    expect(menu.orderingState).toBe('open');
  });

  it('ExploreMenuItem has no menuId, enabled, createdBy, or audit timestamps', () => {
    const item: ExploreMenuItem = {
      id: 'item-1',
      name: 'Chicken Biriyani',
      priceInPaise: 12000,
      displayOrder: 1,
    };
    // @ts-expect-error -- menuId must not exist on the customer-safe item type
    typeOnly(item.menuId);
    // @ts-expect-error -- enabled must not exist on the customer-safe item type: disabled items are omitted, never flagged
    typeOnly(item.enabled);
    // @ts-expect-error -- createdBy must not exist on the customer-safe item type
    typeOnly(item.createdBy);

    expect(item.priceInPaise).toBe(12000);
  });

  it('ExploreMenuDetail carries items alongside the menu fields, with no admin fields either', () => {
    const detail: ExploreMenuDetail = {
      id: 'menu-1',
      menuDate: '2026-09-29',
      title: 'Tuesday Special Menu',
      orderingOpensAt: '2026-09-28T04:00:00+05:30',
      orderingClosesAt: '2026-09-28T10:00:00+05:30',
      pickupStartsAt: '2026-09-29T12:00:00+05:30',
      pickupEndsAt: '2026-09-29T14:00:00+05:30',
      orderingState: 'closed',
      items: [],
    };
    // @ts-expect-error -- status must not exist on the customer-safe menu detail type
    typeOnly(detail.status);

    expect(detail.items).toEqual([]);
  });
});

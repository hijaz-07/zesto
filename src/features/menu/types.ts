import type { OrganizationId, OutletId, UserId } from '../../domain/types';

export type MenuId = string;

export type MenuStatus = 'draft' | 'published' | 'archived';

/**
 * A future planned service for a specific calendar date at an outlet.
 * Mirrors the backend's `MenuResponse` (functions/src/domain/menus.ts)
 * exactly — timestamp fields are ISO strings, not Firestore `Timestamp`s.
 */
export interface Menu {
  id: MenuId;
  organizationId: OrganizationId;
  outletId: OutletId;
  menuDate: string;
  title: string;
  description?: string;
  status: MenuStatus;
  orderingOpensAt: string;
  orderingClosesAt: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: UserId;
  publishedAt?: string;
}

/** One menu item's demand: portions from paid, not-cancelled orders. */
export interface MenuItemDemand {
  itemId: string;
  name: string;
  portions: number;
}

/** `GET .../menus/{menuId}/demand`: computed on the server from paid, not-cancelled orders. */
export interface MenuDemand {
  menuId: MenuId;
  paidOrders: number;
  totalPortions: number;
  items: MenuItemDemand[];
  computedAt: string;
}

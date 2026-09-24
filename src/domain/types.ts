/**
 * Core domain types for the frontend foundation.
 * These mirror docs/architecture/domain-model.md and are placeholder
 * shapes for development shells — no persistence layer exists yet.
 */

export type MenuItemId = string;

export interface MenuItem {
  id: MenuItemId;
  name: string;
  description?: string;
  priceInPaise: number;
  imageUrl?: string;
  displayOrder: number;
  enabled: boolean;
}

export type MenuState = 'draft' | 'published' | 'ordering_open' | 'ordering_closed';

export interface Menu {
  id: string;
  menuDate: string;
  title: string;
  description?: string;
  state: MenuState;
  orderingOpensAt: string;
  orderingClosesAt: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  items: MenuItem[];
}

export interface DemandLine {
  menuItemId: MenuItemId;
  menuItemName: string;
  totalQuantity: number;
}

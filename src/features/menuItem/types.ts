import type { UserId } from '../../domain/types';
import type { MenuId } from '../menu/types';

export type MenuItemId = string;

/**
 * A single dish offered on a `Menu`. Mirrors the backend's
 * `MenuItemResponse` (functions/src/domain/menuItems.ts) exactly —
 * timestamp fields are ISO strings, not Firestore `Timestamp`s.
 */
export interface MenuItem {
  id: MenuItemId;
  menuId: MenuId;
  name: string;
  description?: string;
  priceInPaise: number;
  enabled: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  createdBy: UserId;
}

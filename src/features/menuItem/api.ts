import type { OrganizationId, OutletId } from '../../domain/types';
import { apiFetch } from '../../lib/api/client';
import type { MenuId } from '../menu/types';
import type { MenuItem, MenuItemId } from './types';

export interface CreateMenuItemInput {
  name: string;
  description?: string;
  priceInPaise: number;
  displayOrder: number;
}

export interface UpdateMenuItemInput {
  name?: string;
  description?: string;
  priceInPaise?: number;
  enabled?: boolean;
  displayOrder?: number;
}

interface GetMenuItemsResponse {
  items: MenuItem[];
}

interface GetMenuItemResponse {
  item: MenuItem;
}

interface CreateMenuItemResponse {
  item: MenuItem;
}

interface UpdateMenuItemResponse {
  item: MenuItem;
}

/** Every item on `menuId`, enabled and disabled alike. */
export function getMenuItems(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
): Promise<GetMenuItemsResponse> {
  return apiFetch<GetMenuItemsResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/items`,
  );
}

/** A single menu item. */
export function getMenuItem(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
  itemId: MenuItemId,
): Promise<GetMenuItemResponse> {
  return apiFetch<GetMenuItemResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/items/${itemId}`,
  );
}

/** Creates a new item on `menuId`; it always starts `enabled: true`. */
export function createMenuItem(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
  input: CreateMenuItemInput,
): Promise<CreateMenuItemResponse> {
  return apiFetch<CreateMenuItemResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/items`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

/** Updates an existing item's editable fields. */
export function updateMenuItem(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
  itemId: MenuItemId,
  input: UpdateMenuItemInput,
): Promise<UpdateMenuItemResponse> {
  return apiFetch<UpdateMenuItemResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/items/${itemId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

/** Permanently deletes an item; only allowed while the parent menu is a draft. */
export async function deleteMenuItem(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
  itemId: MenuItemId,
): Promise<void> {
  await apiFetch(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/items/${itemId}`,
    { method: 'DELETE' },
  );
}

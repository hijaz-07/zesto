import type { OrganizationId, OutletId } from '../../domain/types';
import { apiFetch } from '../../lib/api/client';
import type { Menu, MenuId } from './types';

export interface CreateMenuInput {
  menuDate: string;
  title: string;
  description?: string;
  orderingOpensAt: string;
  orderingClosesAt: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
}

export interface UpdateMenuInput {
  menuDate?: string;
  title?: string;
  description?: string;
  orderingOpensAt?: string;
  orderingClosesAt?: string;
  pickupStartsAt?: string;
  pickupEndsAt?: string;
}

interface GetMenusResponse {
  menus: Menu[];
}

interface GetMenuResponse {
  menu: Menu;
}

interface CreateMenuResponse {
  menu: Menu;
}

interface UpdateMenuResponse {
  menu: Menu;
}

interface PublishMenuResponse {
  menu: Menu;
}

interface ArchiveMenuResponse {
  menu: Menu;
}

/** Every menu belonging to `outletId`, every lifecycle state alike. */
export function getMenus(organizationId: OrganizationId, outletId: OutletId): Promise<GetMenusResponse> {
  return apiFetch<GetMenusResponse>(`/organizations/${organizationId}/outlets/${outletId}/menus`);
}

/** A single menu. */
export function getMenu(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
): Promise<GetMenuResponse> {
  return apiFetch<GetMenuResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}`,
  );
}

/** Creates a new menu; it always starts `"draft"`. */
export function createMenu(
  organizationId: OrganizationId,
  outletId: OutletId,
  input: CreateMenuInput,
): Promise<CreateMenuResponse> {
  return apiFetch<CreateMenuResponse>(`/organizations/${organizationId}/outlets/${outletId}/menus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Updates an existing menu's editable fields; `status` can never be changed here. */
export function updateMenu(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
  input: UpdateMenuInput,
): Promise<UpdateMenuResponse> {
  return apiFetch<UpdateMenuResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

/** Publishes a draft menu. Takes no request body. */
export function publishMenu(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
): Promise<PublishMenuResponse> {
  return apiFetch<PublishMenuResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/publish`,
    { method: 'POST' },
  );
}

/** Archives a published menu. Takes no request body. */
export function archiveMenu(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
): Promise<ArchiveMenuResponse> {
  return apiFetch<ArchiveMenuResponse>(
    `/organizations/${organizationId}/outlets/${outletId}/menus/${menuId}/archive`,
    { method: 'POST' },
  );
}

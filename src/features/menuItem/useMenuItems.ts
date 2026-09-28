import { useCallback, useEffect, useState } from 'react';
import type { OrganizationId, OutletId } from '../../domain/types';
import type { MenuId } from '../menu/types';
import {
  createMenuItem as createMenuItemRequest,
  deleteMenuItem as deleteMenuItemRequest,
  getMenuItems,
  updateMenuItem as updateMenuItemRequest,
  type CreateMenuItemInput,
  type UpdateMenuItemInput,
} from './api';
import type { MenuItem, MenuItemId } from './types';

export type MenuItemsState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; items: MenuItem[] };

export interface UseMenuItemsResult {
  status: MenuItemsState['status'];
  items: MenuItem[];
  error: unknown;
  retry: () => void;
  createMenuItem: (input: CreateMenuItemInput) => Promise<MenuItem>;
  updateMenuItem: (itemId: MenuItemId, input: UpdateMenuItemInput) => Promise<MenuItem>;
  deleteMenuItem: (itemId: MenuItemId) => Promise<void>;
}

/**
 * Loads `menuId`'s items, re-fetching if `organizationId`/`outletId`/
 * `menuId` changes. Does not track a "current item" or expose any state
 * beyond one menu's list — that selection is left to the caller.
 */
export function useMenuItems(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
): UseMenuItemsResult {
  const [state, setState] = useState<MenuItemsState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getMenuItems(organizationId, outletId, menuId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', items: response.items });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', error });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [organizationId, outletId, menuId, reloadToken]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  const createMenuItem = useCallback(
    async (input: CreateMenuItemInput) => {
      const response = await createMenuItemRequest(organizationId, outletId, menuId, input);
      setState((previous) => ({
        status: 'ready',
        items: previous.status === 'ready' ? [...previous.items, response.item] : [response.item],
      }));
      return response.item;
    },
    [organizationId, outletId, menuId],
  );

  const updateMenuItem = useCallback(
    async (itemId: MenuItemId, input: UpdateMenuItemInput) => {
      const response = await updateMenuItemRequest(organizationId, outletId, menuId, itemId, input);
      setState((previous) => ({
        status: 'ready',
        items:
          previous.status === 'ready'
            ? previous.items.map((item) => (item.id === itemId ? response.item : item))
            : [response.item],
      }));
      return response.item;
    },
    [organizationId, outletId, menuId],
  );

  const deleteMenuItem = useCallback(
    async (itemId: MenuItemId) => {
      await deleteMenuItemRequest(organizationId, outletId, menuId, itemId);
      setState((previous) => ({
        status: 'ready',
        items: previous.status === 'ready' ? previous.items.filter((item) => item.id !== itemId) : [],
      }));
    },
    [organizationId, outletId, menuId],
  );

  return {
    status: state.status,
    items: state.status === 'ready' ? state.items : [],
    error: state.status === 'error' ? state.error : null,
    retry,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
  };
}

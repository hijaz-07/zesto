import { useCallback, useEffect, useState } from 'react';
import type { OrganizationId, OutletId } from '../../domain/types';
import {
  createMenu as createMenuRequest,
  getMenus,
  updateMenu as updateMenuRequest,
  publishMenu as publishMenuRequest,
  archiveMenu as archiveMenuRequest,
  type CreateMenuInput,
  type UpdateMenuInput,
} from './api';
import type { Menu, MenuId } from './types';

export type MenusState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; menus: Menu[] };

export interface UseMenusResult {
  status: MenusState['status'];
  menus: Menu[];
  error: unknown;
  retry: () => void;
  createMenu: (input: CreateMenuInput) => Promise<Menu>;
  updateMenu: (menuId: MenuId, input: UpdateMenuInput) => Promise<Menu>;
  publishMenu: (menuId: MenuId) => Promise<Menu>;
  archiveMenu: (menuId: MenuId) => Promise<Menu>;
}

/**
 * Loads `outletId`'s menus, re-fetching if `organizationId`/`outletId`
 * changes. Does not track a "current menu" or expose any state beyond one
 * outlet's list — that selection is left to the caller.
 */
export function useMenus(organizationId: OrganizationId, outletId: OutletId): UseMenusResult {
  const [state, setState] = useState<MenusState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getMenus(organizationId, outletId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', menus: response.menus });
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
  }, [organizationId, outletId, reloadToken]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  const createMenu = useCallback(
    async (input: CreateMenuInput) => {
      const response = await createMenuRequest(organizationId, outletId, input);
      setState((previous) => ({
        status: 'ready',
        menus: previous.status === 'ready' ? [...previous.menus, response.menu] : [response.menu],
      }));
      return response.menu;
    },
    [organizationId, outletId],
  );

  const updateMenu = useCallback(
    async (menuId: MenuId, input: UpdateMenuInput) => {
      const response = await updateMenuRequest(organizationId, outletId, menuId, input);
      setState((previous) => ({
        status: 'ready',
        menus:
          previous.status === 'ready'
            ? previous.menus.map((menu) => (menu.id === menuId ? response.menu : menu))
            : [response.menu],
      }));
      return response.menu;
    },
    [organizationId, outletId],
  );

  const publishMenu = useCallback(
    async (menuId: MenuId) => {
      const response = await publishMenuRequest(organizationId, outletId, menuId);
      setState((previous) => ({
        status: 'ready',
        menus:
          previous.status === 'ready'
            ? previous.menus.map((menu) => (menu.id === menuId ? response.menu : menu))
            : [response.menu],
      }));
      return response.menu;
    },
    [organizationId, outletId],
  );

  const archiveMenu = useCallback(
    async (menuId: MenuId) => {
      const response = await archiveMenuRequest(organizationId, outletId, menuId);
      setState((previous) => ({
        status: 'ready',
        menus:
          previous.status === 'ready'
            ? previous.menus.map((menu) => (menu.id === menuId ? response.menu : menu))
            : [response.menu],
      }));
      return response.menu;
    },
    [organizationId, outletId],
  );

  return {
    status: state.status,
    menus: state.status === 'ready' ? state.menus : [],
    error: state.status === 'error' ? state.error : null,
    retry,
    createMenu,
    updateMenu,
    publishMenu,
    archiveMenu,
  };
}

import { useCallback, useEffect, useState } from 'react';
import type { OrganizationId, OutletId } from '../../domain/types';
import {
  archiveMenu as archiveMenuRequest,
  getMenu,
  publishMenu as publishMenuRequest,
  updateMenu as updateMenuRequest,
  type UpdateMenuInput,
} from './api';
import type { Menu, MenuId } from './types';

export type MenuState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; menu: Menu };

export interface UseMenuResult {
  status: MenuState['status'];
  menu: Menu | null;
  error: unknown;
  retry: () => void;
  updateMenu: (input: UpdateMenuInput) => Promise<Menu>;
  publishMenu: () => Promise<Menu>;
  archiveMenu: () => Promise<Menu>;
}

/**
 * Loads a single menu, re-fetching if `organizationId`/`outletId`/`menuId`
 * changes. Mirrors `useMenus`' shape for the list case, but for exactly one
 * menu — the detail/editor page doesn't need the outlet's full menu list.
 */
export function useMenu(organizationId: OrganizationId, outletId: OutletId, menuId: MenuId): UseMenuResult {
  const [state, setState] = useState<MenuState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getMenu(organizationId, outletId, menuId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', menu: response.menu });
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

  const updateMenu = useCallback(
    async (input: UpdateMenuInput) => {
      const response = await updateMenuRequest(organizationId, outletId, menuId, input);
      setState({ status: 'ready', menu: response.menu });
      return response.menu;
    },
    [organizationId, outletId, menuId],
  );

  const publishMenu = useCallback(async () => {
    const response = await publishMenuRequest(organizationId, outletId, menuId);
    setState({ status: 'ready', menu: response.menu });
    return response.menu;
  }, [organizationId, outletId, menuId]);

  const archiveMenu = useCallback(async () => {
    const response = await archiveMenuRequest(organizationId, outletId, menuId);
    setState({ status: 'ready', menu: response.menu });
    return response.menu;
  }, [organizationId, outletId, menuId]);

  return {
    status: state.status,
    menu: state.status === 'ready' ? state.menu : null,
    error: state.status === 'error' ? state.error : null,
    retry,
    updateMenu,
    publishMenu,
    archiveMenu,
  };
}

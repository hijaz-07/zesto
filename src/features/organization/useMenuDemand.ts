import { useCallback, useEffect, useState } from 'react';
import type { OrganizationId, OutletId } from '../../domain/types';
import { getMenuDemand } from '../menu/api';
import type { MenuDemand, MenuId } from '../menu/types';

export type MenuDemandState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; demand: MenuDemand };

/** Loads one menu's demand from the server; `refresh` re-reads it. */
export function useMenuDemand(
  organizationId: OrganizationId,
  outletId: OutletId,
  menuId: MenuId,
): MenuDemandState & { refresh: () => void } {
  const [state, setState] = useState<MenuDemandState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMenuDemand(organizationId, outletId, menuId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', demand: response.demand });
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

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  return { ...state, refresh };
}

import { useCallback, useEffect, useState } from 'react';
import { getExploreMenu } from './api';
import type { ExploreMenuDetail, ExploreMenuId, ExploreOutlet, ExploreOutletId } from './types';

export type ExploreMenuState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; outlet: ExploreOutlet; menu: ExploreMenuDetail };

export interface UseExploreMenuResult {
  status: ExploreMenuState['status'];
  outlet: ExploreOutlet | null;
  menu: ExploreMenuDetail | null;
  error: unknown;
  retry: () => void;
}

/**
 * Loads one customer-safe published menu and its enabled items, re-fetching
 * if `outletId`/`menuId` changes. Public — no authentication or
 * organization membership is required, and this never mutates anything.
 * While either ID is missing/empty, this never calls the API and reports
 * `status: 'idle'`, mirroring `useExploreOutlet`.
 */
export function useExploreMenu(
  outletId: ExploreOutletId | undefined,
  menuId: ExploreMenuId | undefined,
): UseExploreMenuResult {
  const [state, setState] = useState<ExploreMenuState>(
    outletId && menuId ? { status: 'loading' } : { status: 'idle' },
  );
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    // Nothing to fetch, and nothing to set: `derivedState` below already
    // reports `idle` whenever either ID is falsy, purely from render-time
    // props — no need for an effect (or a setState) just to say so.
    if (!outletId || !menuId) {
      return;
    }

    // No synchronous setState here (unlike `retry`): the initial `useState`
    // value already covers the mount case, and — matching this codebase's
    // other list/detail hooks (e.g. `useMenus`, `useOutlets`) — a change to
    // either ID alone re-fetches without an intermediate loading flash,
    // simply swapping in the new `ready`/`error` result once it resolves.
    let cancelled = false;

    getExploreMenu(outletId, menuId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', outlet: response.outlet, menu: response.menu });
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
  }, [outletId, menuId, reloadToken]);

  // Overrides a stale `loading`/`ready`/`error` left over from previous,
  // non-empty IDs the instant either ID becomes empty again, without
  // waiting for the effect above to run.
  const derivedState: ExploreMenuState = outletId && menuId ? state : { status: 'idle' };

  const retry = useCallback(() => {
    if (!outletId || !menuId) {
      return;
    }
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, [outletId, menuId]);

  return {
    status: derivedState.status,
    outlet: derivedState.status === 'ready' ? derivedState.outlet : null,
    menu: derivedState.status === 'ready' ? derivedState.menu : null,
    error: derivedState.status === 'error' ? derivedState.error : null,
    retry,
  };
}

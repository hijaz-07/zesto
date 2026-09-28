import { useCallback, useEffect, useState } from 'react';
import { getExploreOutlet } from './api';
import type { ExploreOutlet, ExploreOutletId, ExploreOutletMenu } from './types';

export type ExploreOutletState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; outlet: ExploreOutlet; menus: ExploreOutletMenu[] };

export interface UseExploreOutletResult {
  status: ExploreOutletState['status'];
  outlet: ExploreOutlet | null;
  menus: ExploreOutletMenu[];
  error: unknown;
  retry: () => void;
}

/**
 * Loads one outlet's public explore page, re-fetching if `outletId`
 * changes. Public — no authentication or organization membership is
 * required. While `outletId` is missing/empty, this never calls the API
 * and reports `status: 'idle'` instead of `'loading'` — the caller (e.g. a
 * route whose `:outletId` param hasn't resolved yet) is expected to check
 * for that rather than see a perpetual, misleading loading spinner.
 */
export function useExploreOutlet(outletId: ExploreOutletId | undefined): UseExploreOutletResult {
  const [state, setState] = useState<ExploreOutletState>(
    outletId ? { status: 'loading' } : { status: 'idle' },
  );
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    // Nothing to fetch, and nothing to set: `derivedState` below already
    // reports `idle` whenever `outletId` is falsy, purely from render-time
    // props — no need for an effect (or a setState) just to say so.
    if (!outletId) {
      return;
    }

    // No synchronous setState here (unlike `retry`): the initial `useState`
    // value already covers the mount case, and — matching this codebase's
    // other list/detail hooks (e.g. `useMenus`, `useOutlets`) — a change to
    // `outletId` alone re-fetches without an intermediate loading flash,
    // simply swapping in the new `ready`/`error` result once it resolves.
    let cancelled = false;

    getExploreOutlet(outletId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', outlet: response.outlet, menus: response.menus });
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
  }, [outletId, reloadToken]);

  // Overrides a stale `loading`/`ready`/`error` left over from a previous,
  // non-empty `outletId` the instant it becomes empty again, without
  // waiting for the effect above to run.
  const derivedState: ExploreOutletState = outletId ? state : { status: 'idle' };

  const retry = useCallback(() => {
    if (!outletId) {
      return;
    }
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, [outletId]);

  return {
    status: derivedState.status,
    outlet: derivedState.status === 'ready' ? derivedState.outlet : null,
    menus: derivedState.status === 'ready' ? derivedState.menus : [],
    error: derivedState.status === 'error' ? derivedState.error : null,
    retry,
  };
}

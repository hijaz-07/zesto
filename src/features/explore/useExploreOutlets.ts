import { useCallback, useEffect, useState } from 'react';
import { getExploreOutlets } from './api';
import type { ExploreOutletSummary } from './types';

export type ExploreOutletsState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; outlets: ExploreOutletSummary[] };

export interface UseExploreOutletsResult {
  status: ExploreOutletsState['status'];
  outlets: ExploreOutletSummary[];
  error: unknown;
  retry: () => void;
}

/**
 * Loads the default customer discovery feed on mount. Public — no
 * authentication or organization membership is required (see
 * `./api.ts`), and this hook takes no arguments and never caches globally:
 * each mount fetches its own copy, matching `useOrganizations`' shape for a
 * single, un-parameterized list.
 */
export function useExploreOutlets(): UseExploreOutletsResult {
  const [state, setState] = useState<ExploreOutletsState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getExploreOutlets()
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', outlets: response.outlets });
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
  }, [reloadToken]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  return {
    status: state.status,
    outlets: state.status === 'ready' ? state.outlets : [],
    error: state.status === 'error' ? state.error : null,
    retry,
  };
}

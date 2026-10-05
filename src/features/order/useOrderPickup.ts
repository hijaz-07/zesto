import { useCallback, useEffect, useState } from 'react';
import { getPickupCredential } from './api';
import type { OrderId, PickupCredential } from './types';

type PickupState =
  | { status: 'idle' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; credential: PickupCredential };

export interface UseOrderPickupResult {
  /** `loading` from the moment a credential is wanted until the backend answers. */
  status: 'idle' | 'loading' | 'error' | 'ready';
  /** The credential, only while `status === 'ready'`. */
  credential: PickupCredential | null;
  error: unknown;
  /** Asks the backend again after a failure. */
  retry: () => void;
}

const IDLE: PickupState = { status: 'idle' };

/**
 * Loads the pickup credential for the signed-in customer's own order, while
 * `active` (the order is `ready`) and for as long as it is.
 *
 * The credential is a SECRET and lives here, in React state, and nowhere else:
 * not `localStorage`, `sessionStorage` or IndexedDB, not the URL, not a module
 * variable or cache, not a log. Nothing survives a reload — every mount asks
 * the backend afresh — and it is dropped from memory the moment it stops being
 * wanted (the order is picked up, the component unmounts, or a different order
 * is shown), not merely hidden. See `useOrderPickup.test.ts`, which fails if any
 * browser storage or URL is touched, and `pickupSecretHygiene.test.ts`, which
 * fails if this feature's source ever mentions one.
 *
 * Only the order's own customer is ever answered by the backend, so asking for
 * someone else's order is a 404 there, however this is called.
 */
export function useOrderPickup(orderId: OrderId | undefined, active: boolean): UseOrderPickupResult {
  const [state, setState] = useState<PickupState>(IDLE);
  const [reloadToken, setReloadToken] = useState(0);
  const wanted = active && orderId !== undefined;

  useEffect(() => {
    if (!wanted || orderId === undefined) {
      return;
    }

    let cancelled = false;
    // An async function, so a response that is not even a promise (a test
    // double, say) is a failure to show, never a crash.
    void (async () => {
      try {
        const credential = await getPickupCredential(orderId);
        if (!credential) {
          // Never "ready" without something to show.
          throw new Error('No pickup credential was returned.');
        }
        if (!cancelled) {
          setState({ status: 'ready', credential });
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setState({ status: 'error', error });
        }
      }
    })();

    return () => {
      cancelled = true;
      // No longer wanted (or about to be asked for again): forget it now.
      setState(IDLE);
    };
  }, [wanted, orderId, reloadToken]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  if (!wanted) {
    return { status: 'idle', credential: null, error: null, retry };
  }
  return {
    status: state.status === 'idle' ? 'loading' : state.status,
    credential: state.status === 'ready' ? state.credential : null,
    error: state.status === 'error' ? state.error : null,
    retry,
  };
}

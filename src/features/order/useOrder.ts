import { useCallback, useEffect, useState } from 'react';
import { getOrder } from './api';
import type { Order, OrderId } from './types';

export type OrderState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; order: Order };

export interface UseOrderResult {
  status: OrderState['status'];
  order: Order | null;
  error: unknown;
  retry: () => void;
}

/**
 * Loads one order the caller owns, by ID — authenticated, via the same
 * `apiFetch` every other feature uses; the customer app shell (`RequireAuth`)
 * already guarantees a session exists wherever this is used. Always
 * re-fetches from the backend rather than trusting any value the caller
 * might already have (e.g. the just-created order returned by
 * `useCreateOrder`), so the confirmation page keeps working correctly on a
 * hard refresh, and always reflects the backend's authoritative state.
 * Mirrors `../explore/useExploreMenu`'s shape.
 */
export function useOrder(orderId: OrderId | undefined): UseOrderResult {
  const [state, setState] = useState<OrderState>(orderId ? { status: 'loading' } : { status: 'idle' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!orderId) {
      return;
    }

    let cancelled = false;

    getOrder(orderId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', order: response.order });
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
  }, [orderId, reloadToken]);

  const derivedState: OrderState = orderId ? state : { status: 'idle' };

  const retry = useCallback(() => {
    if (!orderId) {
      return;
    }
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, [orderId]);

  return {
    status: derivedState.status,
    order: derivedState.status === 'ready' ? derivedState.order : null,
    error: derivedState.status === 'error' ? derivedState.error : null,
    retry,
  };
}

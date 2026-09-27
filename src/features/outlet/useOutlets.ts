import { useCallback, useEffect, useState } from 'react';
import type { OrganizationId, Outlet, OutletId } from '../../domain/types';
import {
  createOutlet as createOutletRequest,
  getOutlets,
  updateOutlet as updateOutletRequest,
  type CreateOutletInput,
  type UpdateOutletInput,
} from './api';

export type OutletsState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; outlets: Outlet[] };

export interface UseOutletsResult {
  status: OutletsState['status'];
  outlets: Outlet[];
  error: unknown;
  retry: () => void;
  createOutlet: (input: CreateOutletInput) => Promise<Outlet>;
  updateOutlet: (outletId: OutletId, input: UpdateOutletInput) => Promise<Outlet>;
}

/**
 * Loads `organizationId`'s outlets, re-fetching if `organizationId` changes.
 * Does not track a "current outlet" or expose any state beyond one
 * organization's list — that selection is left to the caller.
 */
export function useOutlets(organizationId: OrganizationId): UseOutletsResult {
  const [state, setState] = useState<OutletsState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getOutlets(organizationId)
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
  }, [organizationId, reloadToken]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  const createOutlet = useCallback(
    async (input: CreateOutletInput) => {
      const response = await createOutletRequest(organizationId, input);
      setState((previous) => ({
        status: 'ready',
        outlets: previous.status === 'ready' ? [...previous.outlets, response.outlet] : [response.outlet],
      }));
      return response.outlet;
    },
    [organizationId],
  );

  const updateOutlet = useCallback(
    async (outletId: OutletId, input: UpdateOutletInput) => {
      const response = await updateOutletRequest(organizationId, outletId, input);
      setState((previous) => ({
        status: 'ready',
        outlets:
          previous.status === 'ready'
            ? previous.outlets.map((outlet) => (outlet.id === outletId ? response.outlet : outlet))
            : [response.outlet],
      }));
      return response.outlet;
    },
    [organizationId],
  );

  return {
    status: state.status,
    outlets: state.status === 'ready' ? state.outlets : [],
    error: state.status === 'error' ? state.error : null,
    retry,
    createOutlet,
    updateOutlet,
  };
}

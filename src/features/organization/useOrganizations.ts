import { useCallback, useEffect, useState } from 'react';
import type { OrganizationWithRole } from '../../domain/types';
import { createOrganization as createOrganizationRequest, getOrganizations, type CreateOrganizationInput } from './api';

export type OrganizationsState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; organizations: OrganizationWithRole[] };

export interface UseOrganizationsResult {
  status: OrganizationsState['status'];
  organizations: OrganizationWithRole[];
  error: unknown;
  retry: () => void;
  createOrganization: (input: CreateOrganizationInput) => Promise<OrganizationWithRole>;
}

/** Loads the caller's organizations once. Intended to be called from a single place (`OrganizationGate`), not per-component. */
export function useOrganizations(): UseOrganizationsResult {
  const [state, setState] = useState<OrganizationsState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getOrganizations()
      .then((response) => {
        if (!cancelled) {
          setState({ status: 'ready', organizations: response.organizations });
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

  const createOrganization = useCallback(async (input: CreateOrganizationInput) => {
    const response = await createOrganizationRequest(input);
    const created: OrganizationWithRole = {
      ...response.organization,
      role: response.membership.role,
    };
    setState((previous) => ({
      status: 'ready',
      organizations: previous.status === 'ready' ? [...previous.organizations, created] : [created],
    }));
    return created;
  }, []);

  return {
    status: state.status,
    organizations: state.status === 'ready' ? state.organizations : [],
    error: state.status === 'error' ? state.error : null,
    retry,
    createOrganization,
  };
}

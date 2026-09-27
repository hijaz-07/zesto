import type {
  OrganizationId,
  Outlet,
  OutletAddress,
  OutletId,
  OutletLocation,
  OutletStatus,
} from '../../domain/types';
import { apiFetch } from '../../lib/api/client';

export interface CreateOutletInput {
  name: string;
  slug: string;
  description?: string;
  phone?: string;
  address?: OutletAddress;
  location?: OutletLocation;
}

export interface UpdateOutletInput {
  name?: string;
  description?: string;
  phone?: string;
  address?: OutletAddress;
  location?: OutletLocation;
  status?: OutletStatus;
}

interface GetOutletsResponse {
  outlets: Outlet[];
}

interface CreateOutletResponse {
  outlet: Outlet;
}

interface UpdateOutletResponse {
  outlet: Outlet;
}

/** Every outlet in `organizationId`, active and inactive alike. */
export function getOutlets(organizationId: OrganizationId): Promise<GetOutletsResponse> {
  return apiFetch<GetOutletsResponse>(`/organizations/${organizationId}/outlets`);
}

/** Creates a new outlet in `organizationId`; it always starts `active`. */
export function createOutlet(
  organizationId: OrganizationId,
  input: CreateOutletInput,
): Promise<CreateOutletResponse> {
  return apiFetch<CreateOutletResponse>(`/organizations/${organizationId}/outlets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Updates an existing outlet's editable fields; `slug` can never be changed here. */
export function updateOutlet(
  organizationId: OrganizationId,
  outletId: OutletId,
  input: UpdateOutletInput,
): Promise<UpdateOutletResponse> {
  return apiFetch<UpdateOutletResponse>(`/organizations/${organizationId}/outlets/${outletId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

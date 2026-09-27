import type { Organization, OrganizationMember, OrganizationWithRole } from '../../domain/types';
import { apiFetch } from '../../lib/api/client';

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

interface GetOrganizationsResponse {
  organizations: OrganizationWithRole[];
}

interface CreateOrganizationResponse {
  organization: Organization;
  membership: OrganizationMember;
}

/** The caller's organizations where they have an active membership. */
export function getOrganizations(): Promise<GetOrganizationsResponse> {
  return apiFetch<GetOrganizationsResponse>('/organizations');
}

/** Creates a new organization; the caller becomes its owner. */
export function createOrganization(input: CreateOrganizationInput): Promise<CreateOrganizationResponse> {
  return apiFetch<CreateOrganizationResponse>('/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

import type { OrganizationId, OutletId } from '../../domain/types';
import { apiFetch } from '../../lib/api/client';
import type { OrganizationOrdersPage } from './types';

export interface ListOrganizationOrdersParams {
  /** Narrows the list to one outlet. A requested filter only: the backend verifies it belongs to the organization. */
  outletId?: OutletId;
  /** The `nextCursor` of the previous page; omit for the first page. */
  cursor?: string;
  /** A hint only: the backend enforces its own default and maximum. */
  limit?: number;
}

/**
 * Reads one page of `organizationId`'s orders, newest first
 * (`GET /organizations/{organizationId}/orders`). Both ids are only requests:
 * whether the caller may see this organization's orders (and whether the
 * outlet is really one of its outlets) is decided by the backend from the
 * signed-in session's own membership, never by anything sent here.
 */
export function listOrganizationOrders(
  organizationId: OrganizationId,
  params: ListOrganizationOrdersParams = {},
): Promise<OrganizationOrdersPage> {
  const query = new URLSearchParams();
  if (params.outletId) {
    query.set('outletId', params.outletId);
  }
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  const queryString = query.toString();
  const path = `/organizations/${organizationId}/orders`;
  return apiFetch<OrganizationOrdersPage>(queryString ? `${path}?${queryString}` : path);
}

import type { OrganizationId, OutletId } from '../../domain/types';
import { ApiError, apiFetch } from '../../lib/api/client';
import type { FulfillmentAction } from './fulfillment';
import type { OrganizationOrdersPage, OrganizationOrderSummary } from './types';

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

/**
 * Asks the backend to move an order along
 * (`POST /organizations/{organizationId}/orders/{orderId}/start-preparing` or
 * `.../mark-ready`). Sends NO body: the action is in the URL, and everything
 * else — the order's current state, whether it is paid, who is acting, whether
 * they may — is decided by the backend. Resolves with the order's row as it
 * stands afterwards (the same shape the list returns); an action whose result
 * already holds resolves too, unchanged. A refusal rejects with the
 * `ApiError`: 403 (no access), 404 (no such order here), 409 (the order is not
 * in a state this can act on).
 */
export async function runFulfillmentAction(
  organizationId: OrganizationId,
  orderId: string,
  action: FulfillmentAction,
): Promise<OrganizationOrderSummary> {
  const data = await apiFetch<{ order?: OrganizationOrderSummary } | undefined>(
    `/organizations/${encodeURIComponent(organizationId)}/orders/${encodeURIComponent(orderId)}/${action}`,
    { method: 'POST' },
  );
  // A row for some other order must never be swapped into this one's place.
  if (!data?.order || data.order.id !== orderId) {
    throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
  }
  return data.order;
}

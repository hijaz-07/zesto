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

export interface RedeemPickupInput {
  /** What the customer showed: the scanned QR payload, or the typed backup code. A SECRET — never stored or logged. */
  credential: string;
  /** The outlet this counter serves, if chosen. Only ever a narrowing check on the backend, never authority. */
  outletId?: OutletId;
}

/**
 * Hands a ready order over by redeeming the customer's pickup credential
 * (`POST /organizations/{organizationId}/pickups`). The body is exactly the
 * credential and, if one was chosen, the outlet — picked explicitly, so nothing
 * else a caller's object carries can ride along. No order id, status, payment or
 * actor is ever sent: the backend finds the order from the credential and
 * decides everything else (its organization, its state, that it is paid, who is
 * acting) from its own data and the signed-in session.
 *
 * The credential is a SECRET: it goes in the request body only — never the URL —
 * and this function keeps no copy of it.
 *
 * Resolves with the order's row as it stands after the pickup (the same shape the
 * list returns) — but only if that row really says `picked_up`: anything else is
 * treated as an unexpected response, so a stale or confused answer is never shown
 * as a successful handover. A refusal rejects with the `ApiError`: 400 (not a
 * pickup code), 403 (no access), 404 (no order of this organization awaiting
 * pickup matches), 409 (already picked up, not ready, not paid, wrong outlet, or
 * a lost race), 503.
 */
export async function redeemPickup(
  organizationId: OrganizationId,
  input: RedeemPickupInput,
): Promise<OrganizationOrderSummary> {
  const body = input.outletId
    ? { credential: input.credential, outletId: input.outletId }
    : { credential: input.credential };
  const data = await apiFetch<{ order?: OrganizationOrderSummary } | undefined>(
    `/organizations/${encodeURIComponent(organizationId)}/pickups`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!data?.order || typeof data.order.id !== 'string' || data.order.status !== 'picked_up') {
    throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
  }
  return data.order;
}

/**
 * Asks the backend to move an order along
 * (`POST /organizations/{organizationId}/orders/{orderId}/start-preparing`,
 * `.../mark-ready` or `.../complete`). Sends NO body: the action is in the URL, and everything
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

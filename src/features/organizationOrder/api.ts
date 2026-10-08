import type { OrganizationId, OutletId } from '../../domain/types';
import { ApiError, apiFetch } from '../../lib/api/client';
import { ORGANIZATION_CANCELLATION_REASONS, type OrganizationCancellationReason } from './cancellation';
import type { FulfillmentAction } from './fulfillment';
import {
  ORGANIZATION_REFUND_STATES,
  type OrganizationOrderCancellation,
  type OrganizationOrderRefund,
  type OrganizationOrdersPage,
  type OrganizationOrderSummary,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The cancellation block, only if it is exactly the approved shape; otherwise none. Only the two approved fields are copied. */
function readCancellation(raw: unknown): OrganizationOrderCancellation | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { cancelledBy, cancelledAt } = raw;
  if (
    (cancelledBy !== 'customer' && cancelledBy !== 'organization') ||
    typeof cancelledAt !== 'string' ||
    Number.isNaN(Date.parse(cancelledAt))
  ) {
    return undefined;
  }
  return { cancelledBy, cancelledAt };
}

/**
 * The refund block, only if it is a well-formed one; anything else is treated as
 * no refund information (so the row says the status is unavailable rather than a
 * wrong one). Only the two approved fields are copied, so nothing else a server
 * might one day add — a provider or refund identifier, say — is carried along.
 */
function readRefund(raw: unknown): OrganizationOrderRefund | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { state, refundedInPaise } = raw;
  if (
    typeof state !== 'string' ||
    !(ORGANIZATION_REFUND_STATES as readonly string[]).includes(state) ||
    typeof refundedInPaise !== 'number' ||
    !Number.isInteger(refundedInPaise) ||
    refundedInPaise < 0
  ) {
    return undefined;
  }
  return { state: state as OrganizationOrderRefund['state'], refundedInPaise };
}

/**
 * One row of an organization order response, with its cancellation and refund
 * blocks re-read through the validators above: a malformed block is dropped,
 * never repaired or guessed, and no unapproved field survives inside either.
 */
function readOrder(row: OrganizationOrderSummary): OrganizationOrderSummary {
  if (!isRecord(row) || (!('cancellation' in row) && !('refund' in row))) {
    // Nothing to re-read: the row is handed on as it came.
    return row;
  }
  const { cancellation: rawCancellation, refund: rawRefund, ...rest } = row;
  const cancellation = readCancellation(rawCancellation);
  const refund = readRefund(rawRefund);
  return { ...rest, ...(cancellation ? { cancellation } : {}), ...(refund ? { refund } : {}) };
}

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
  return apiFetch<OrganizationOrdersPage>(queryString ? `${path}?${queryString}` : path).then((page) => {
    if (!Array.isArray(page?.orders)) {
      return page;
    }
    const orders = page.orders.map(readOrder);
    return orders.every((order, index) => order === page.orders[index]) ? page : { ...page, orders };
  });
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
  return readOrder(data.order);
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
  return readOrder(data.order);
}

/**
 * Cancels one of the organization's orders
 * (`POST /organizations/{organizationId}/orders/{orderId}/cancel`). The body is
 * only ever `{ reason }`, one of the approved reasons: whether the order may be
 * cancelled, who may cancel it, whether and how much to refund are decided by the
 * backend from its own records, so no amount, status, role, user or provider
 * detail is sent. Safe to repeat (a second call on an already-cancelled order
 * answers the same way), but callers send one request per operator decision.
 *
 * Resolves with the order's row as it stands afterwards (the same shape the list
 * returns, now with its cancellation and refund blocks) — but only if that row is
 * this order and really says `cancelled`: anything else is an unexpected
 * response, so a stale or confused answer is never shown as a cancellation. A
 * refusal rejects with the `ApiError`: 400 (reason), 403 (no access, or staff),
 * 404 (no such order here), 409 (the order can no longer be cancelled), 503.
 */
export async function cancelOrganizationOrder(
  organizationId: OrganizationId,
  orderId: string,
  reason: OrganizationCancellationReason,
): Promise<OrganizationOrderSummary> {
  if (!(ORGANIZATION_CANCELLATION_REASONS as readonly string[]).includes(reason)) {
    throw new ApiError(400, 'invalid_argument', 'Choose a reason for cancelling this order.');
  }
  const data = await apiFetch<{ order?: OrganizationOrderSummary } | undefined>(
    `/organizations/${encodeURIComponent(organizationId)}/orders/${encodeURIComponent(orderId)}/cancel`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) },
  );
  if (!data?.order || data.order.id !== orderId || data.order.status !== 'cancelled') {
    throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
  }
  return readOrder(data.order);
}

/**
 * Asks the backend to start a new refund attempt for a cancelled order whose latest
 * refund failed
 * (`POST /organizations/{organizationId}/orders/{orderId}/retry-refund`). Sends NO
 * body: which refund, how much and whether it may be retried are decided by the
 * backend from its own records, so no amount, refund, payment or provider detail
 * is ever sent. Not meant to be repeated blindly — a repeat while the new refund
 * is still in progress is answered 409.
 *
 * Resolves with the order's row as it stands afterwards (the same shape the list
 * returns, now showing the refund as in progress) — but only if that row is this
 * order and still says `cancelled`. A refusal rejects with the `ApiError`: 403
 * (no access, or staff), 404 (no such order here), 409 (there is no failed refund
 * to retry), 503.
 */
export async function retryOrganizationRefund(
  organizationId: OrganizationId,
  orderId: string,
): Promise<OrganizationOrderSummary> {
  const data = await apiFetch<{ order?: OrganizationOrderSummary } | undefined>(
    `/organizations/${encodeURIComponent(organizationId)}/orders/${encodeURIComponent(orderId)}/retry-refund`,
    { method: 'POST' },
  );
  if (!data?.order || data.order.id !== orderId || data.order.status !== 'cancelled') {
    throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
  }
  return readOrder(data.order);
}

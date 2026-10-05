import { ApiError, apiFetch } from '../../lib/api/client';
import type { Order, OrderHistoryPage, OrderId, PickupCredential } from './types';

/**
 * The authenticated customer order API (functions/src/routes/orders.ts).
 * Uses the same `apiFetch` every other feature uses — no separate client.
 * The request body sent to `POST /orders` is intentionally minimal: the
 * backend is the sole source of truth for pricing, `organizationId`, and
 * the order's initial `status`/`paymentStatus`/`currency` (see
 * functions/src/domain/orders.ts's `createOrder`), so nothing beyond
 * `outletId`/`menuId`/`items`/`idempotencyKey` is ever sent.
 */

export interface CreateOrderRequestItem {
  itemId: string;
  quantity: number;
}

export interface CreateOrderInput {
  outletId: string;
  menuId: string;
  items: CreateOrderRequestItem[];
  idempotencyKey: string;
}

interface OrderResponseEnvelope {
  order: Order;
}

/** Creates a pending-payment order from the given cart contents. Idempotent: retrying with the same `idempotencyKey` returns the original order rather than creating another. */
export function createOrder(input: CreateOrderInput): Promise<OrderResponseEnvelope> {
  return apiFetch<OrderResponseEnvelope>('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Reads one order the caller owns. */
export function getOrder(orderId: OrderId): Promise<OrderResponseEnvelope> {
  return apiFetch<OrderResponseEnvelope>(`/orders/${orderId}`);
}

/** Generous bound on either value; a real QR payload is ~47 characters, a code 9. */
const PICKUP_VALUE_MAX_LENGTH = 200;

function isPickupValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PICKUP_VALUE_MAX_LENGTH;
}

/**
 * Reads the pickup credential for an order the caller OWNS
 * (`GET /orders/{orderId}/pickup-credential`) — what the customer shows staff
 * to collect it. Only the order's own customer is ever answered (anyone else,
 * including the organization's staff, gets a 404), and only while the order is
 * `ready` and paid (otherwise a 409).
 *
 * The result is a SECRET. Callers must hold it in memory only and never write
 * it to storage, a URL, or a log — and this function itself keeps no copy: it
 * is not cached here, and every call asks the backend again. The response is
 * checked and exactly the two approved fields are returned, so anything else a
 * server might one day add can never be carried along.
 *
 * @throws {ApiError} The backend's refusal, or `invalid_response` if the answer
 *   is not the expected shape.
 */
export async function getPickupCredential(orderId: OrderId): Promise<PickupCredential> {
  const data = await apiFetch<{ pickup?: { qrPayload?: unknown; code?: unknown } } | undefined>(
    `/orders/${encodeURIComponent(orderId)}/pickup-credential`,
  );
  const pickup = data?.pickup;
  if (!pickup || !isPickupValue(pickup.qrPayload) || !isPickupValue(pickup.code)) {
    throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
  }
  return { qrPayload: pickup.qrPayload, code: pickup.code };
}

export interface ListOrdersParams {
  /** The `nextCursor` of the previous page; omit for the first page. */
  cursor?: string;
  /** A hint only: the backend enforces its own default and maximum. */
  limit?: number;
}

/**
 * Reads one page of the caller's own order history, newest first. Only a
 * cursor and a page-size hint ever go to the server: which orders come back is
 * decided entirely by the backend from the signed-in session, never by
 * anything sent here.
 */
export function listOrders(params: ListOrdersParams = {}): Promise<OrderHistoryPage> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  const queryString = query.toString();
  return apiFetch<OrderHistoryPage>(queryString ? `/orders?${queryString}` : '/orders');
}

import { apiFetch } from '../../lib/api/client';
import type { Order, OrderHistoryPage, OrderId } from './types';

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

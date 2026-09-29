import { apiFetch } from '../../lib/api/client';
import type { Order, OrderId } from './types';

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

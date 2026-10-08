import { ApiError, apiFetch } from '../../lib/api/client';
import {
  CUSTOMER_CANCELLATION_REASONS,
  REFUND_STATUSES,
  type CustomerCancellationReason,
  type Order,
  type OrderCancellation,
  type OrderHistoryPage,
  type OrderId,
  type OrderRefund,
  type PickupCredential,
} from './types';

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

/** The wire shape of a single-order read and of a cancellation: the order, plus the server's own cancellation hint and refund summary. */
interface OrderWithCancellationResponse {
  order: Order;
  cancellation?: unknown;
  refund?: unknown;
}

const CANCELLATION_STATES: readonly string[] = ['cancellable', 'not_cancellable', 'cancelled'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The cancellation hint, only if it is exactly the shape the backend sends; otherwise none (never a guess). */
function readCancellation(raw: unknown): OrderCancellation | undefined {
  if (!isRecord(raw) || typeof raw.state !== 'string' || !CANCELLATION_STATES.includes(raw.state)) {
    return undefined;
  }
  if (typeof raw.canCancel !== 'boolean') {
    return undefined;
  }
  // `canCancel` is true only for `cancellable`; a contradiction is not trusted.
  if (raw.canCancel !== (raw.state === 'cancellable')) {
    return undefined;
  }
  return { state: raw.state as OrderCancellation['state'], canCancel: raw.canCancel };
}

/**
 * The refund summary, only if it is a well-formed one; anything else is treated
 * as no refund information, so a malformed block can never put a wrong status or
 * amount on screen. Exactly the approved fields are copied, so nothing else a
 * server might one day add is carried along.
 */
function readRefund(raw: unknown): OrderRefund | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { status, amountInPaise, currency, initiatedAt, completedAt } = raw;
  if (
    typeof status !== 'string' ||
    !(REFUND_STATUSES as readonly string[]).includes(status) ||
    typeof amountInPaise !== 'number' ||
    !Number.isInteger(amountInPaise) ||
    amountInPaise < 1 ||
    currency !== 'INR' ||
    typeof initiatedAt !== 'string' ||
    (completedAt !== undefined && typeof completedAt !== 'string')
  ) {
    return undefined;
  }
  return {
    status: status as OrderRefund['status'],
    amountInPaise,
    currency,
    initiatedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

/** Folds the cancellation hint and refund summary into the order they describe. */
function withCancellationAndRefund(data: OrderWithCancellationResponse | undefined): OrderResponseEnvelope {
  if (!data || !isRecord(data.order)) {
    throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
  }
  const cancellation = readCancellation(data.cancellation);
  const refund = readRefund(data.refund);
  return {
    order: {
      ...data.order,
      ...(cancellation ? { cancellation } : {}),
      ...(refund ? { refund } : {}),
    },
  };
}

/** Creates a pending-payment order from the given cart contents. Idempotent: retrying with the same `idempotencyKey` returns the original order rather than creating another. */
export function createOrder(input: CreateOrderInput): Promise<OrderResponseEnvelope> {
  return apiFetch<OrderResponseEnvelope>('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * Reads one order the caller owns, with the server's own cancellation hint and,
 * if the order has one, its refund summary folded into the returned order.
 */
export async function getOrder(orderId: OrderId): Promise<OrderResponseEnvelope> {
  return withCancellationAndRefund(await apiFetch<OrderWithCancellationResponse>(`/orders/${orderId}`));
}

/**
 * Cancels an order the caller owns (`POST /orders/{orderId}/cancel`). The body
 * is only ever `{ reason? }`: whether the order may be cancelled, and whether and
 * how much to refund, are decided by the backend from its own records, so no
 * amount, status, deadline, user or provider detail is ever sent. Safe to repeat
 * (a second call on an already-cancelled order answers the same way), but
 * callers still send one request per customer decision.
 *
 * @throws {ApiError} The backend's refusal (`409` when the order can no longer
 *   be cancelled), or `invalid_response` if the answer is not a cancelled order.
 */
export async function cancelOrder(
  orderId: OrderId,
  reason?: CustomerCancellationReason,
): Promise<OrderResponseEnvelope> {
  const body: { reason?: CustomerCancellationReason } = {};
  if (reason !== undefined && (CUSTOMER_CANCELLATION_REASONS as readonly string[]).includes(reason)) {
    body.reason = reason;
  }
  const result = withCancellationAndRefund(
    await apiFetch<OrderWithCancellationResponse>(`/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  if (result.order.id !== orderId || result.order.status !== 'cancelled') {
    throw new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
  }
  // The order is verified cancelled above, so its hint is known even if the block was missing or unreadable.
  return {
    order: { ...result.order, cancellation: result.order.cancellation ?? { state: 'cancelled', canCancel: false } },
  };
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

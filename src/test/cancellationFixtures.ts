import type { Order, OrderRefund } from '../features/order/types';
import {
  completedOrder,
  confirmedOrder,
  pendingOrder,
  pickedUpOrder,
  preparingOrder,
  readyOrder,
} from './paymentFixtures';

/**
 * Orders as `GET /orders/{orderId}` returns them to their own customer once the
 * server has added its cancellation hint (and, after a cancellation, the refund
 * summary). The hint is the server's answer, so each fixture says what the
 * server would say for that situation.
 */

const CANCELLABLE = { state: 'cancellable', canCancel: true } as const;
const NOT_CANCELLABLE = { state: 'not_cancellable', canCancel: false } as const;
const CANCELLED = { state: 'cancelled', canCancel: false } as const;

export const cancellablePendingOrder: Order = { ...pendingOrder, cancellation: CANCELLABLE };
export const cancellableConfirmedOrder: Order = { ...confirmedOrder, cancellation: CANCELLABLE };
/** A paid, confirmed order after the ordering deadline: the server says no. */
export const lateConfirmedOrder: Order = { ...confirmedOrder, cancellation: NOT_CANCELLABLE };
export const lockedPreparingOrder: Order = { ...preparingOrder, cancellation: NOT_CANCELLABLE };
export const lockedReadyOrder: Order = { ...readyOrder, cancellation: NOT_CANCELLABLE };
export const lockedPickedUpOrder: Order = { ...pickedUpOrder, cancellation: NOT_CANCELLABLE };
export const lockedCompletedOrder: Order = { ...completedOrder, cancellation: NOT_CANCELLABLE };

/** Cancelled before it was paid: nothing was captured, so there is no refund. */
export const cancelledUnpaidOrder: Order = {
  ...pendingOrder,
  status: 'cancelled',
  updatedAt: '2026-09-30T08:10:00+05:30',
  cancellation: CANCELLED,
};

export function refundOf(status: OrderRefund['status'], overrides: Partial<OrderRefund> = {}): OrderRefund {
  return {
    status,
    amountInPaise: 30000,
    currency: 'INR',
    initiatedAt: '2026-09-30T08:10:00.000Z',
    ...(status === 'processed' ? { completedAt: '2026-10-02T09:30:00.000Z' } : {}),
    ...overrides,
  };
}

/**
 * Cancelled after it was paid: the whole amount is being refunded. `null` is a
 * cancelled paid order whose refund summary is missing.
 */
export function cancelledPaidOrder(refund: OrderRefund | null = refundOf('requested')): Order {
  return {
    ...confirmedOrder,
    status: 'cancelled',
    updatedAt: '2026-09-30T08:10:00+05:30',
    cancellation: CANCELLED,
    ...(refund ? { refund } : {}),
  };
}

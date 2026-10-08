import type { CustomerCancellationReason, Order } from './types';

/** The customer's words for each approved cancellation reason. */
export const CANCELLATION_REASON_LABEL: Record<CustomerCancellationReason, string> = {
  changed_my_mind: 'I changed my mind',
  ordered_by_mistake: 'I ordered by mistake',
  wrong_items_or_quantity: 'Wrong items or quantity',
  wrong_pickup_time: 'Wrong pickup time',
  other: 'Other',
};

/**
 * Whether the refund card belongs on this order: it was cancelled AND money was
 * captured (it is paid, or a refund already exists). An order cancelled before
 * payment has no refund and shows nothing — never a made-up one.
 */
export function showsRefundCard(order: Order): boolean {
  return order.status === 'cancelled' && (order.refund !== undefined || order.paymentStatus === 'paid');
}

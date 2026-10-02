import type { BadgeTone } from '../../components/ui/Badge';
import type { OrderPaymentStatus, OrderStatus } from './types';

export interface OrderStatusBadge {
  label: string;
  tone: BadgeTone;
}

const ORDER_STATUS_BADGE: Record<OrderStatus, OrderStatusBadge> = {
  pending_payment: { label: 'Payment pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/**
 * The badges shown for an order in the history list, from the backend's own
 * `status`/`paymentStatus` — never inferred from anything else. An order is
 * always one of: payment pending (warning), confirmed (success, plus "Paid"
 * once the backend has verified payment), or cancelled (danger). A cancelled
 * order never shows "Payment pending": its payment is no longer awaited.
 */
export function orderStatusBadges(order: {
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
}): OrderStatusBadge[] {
  const badges = [ORDER_STATUS_BADGE[order.status]];
  if (order.paymentStatus === 'paid') {
    badges.push({ label: 'Paid', tone: 'success' });
  }
  return badges;
}

import { orderStatusBadges, type OrderStatusBadge } from '../order/orderStatusBadges';
import type { OrderPaymentStatus, OrderStatus } from '../order/types';

interface OrderLike {
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
}

/**
 * The Status column's badge: exactly the label and tone customers already see
 * for the same order (it is the customer list's own status badge), so the two
 * sides never describe one order differently.
 */
export function organizationOrderStatusBadge(order: OrderLike): OrderStatusBadge {
  return orderStatusBadges(order)[0];
}

/**
 * The Payment column's badge, from the backend's own `paymentStatus` — never
 * inferred. A cancelled order whose payment never arrived is "Unpaid" rather
 * than "Pending" (nothing is awaited any more, the same rule the customer list
 * follows), while a cancelled order that WAS paid still says "Paid": that is
 * exactly the case staff must notice.
 */
export function organizationOrderPaymentBadge(order: OrderLike): OrderStatusBadge {
  if (order.paymentStatus === 'paid') {
    return { label: 'Paid', tone: 'success' };
  }
  if (order.status === 'cancelled') {
    return { label: 'Unpaid', tone: 'neutral' };
  }
  return { label: 'Pending', tone: 'warning' };
}

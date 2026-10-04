import type { BadgeTone } from '../../components/ui/Badge';
import type { OrderPaymentStatus, OrderStatus } from './types';

export interface OrderStatusBadge {
  label: string;
  tone: BadgeTone;
}

const ORDER_STATUS_BADGE: Record<OrderStatus, OrderStatusBadge> = {
  pending_payment: { label: 'Payment pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  preparing: { label: 'Preparing', tone: 'warning' },
  ready: { label: 'Ready', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/**
 * The badge for a status this build does not know — one the backend added after
 * this bundle was built (a later fulfilment state, say). It shows the status as
 * words rather than crashing the whole list over one unfamiliar row.
 */
function unknownStatusBadge(status: string): OrderStatusBadge {
  const words = status.replace(/_/g, ' ').trim();
  return { label: words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown', tone: 'neutral' };
}

/**
 * The badges shown for an order in the history list, from the backend's own
 * `status`/`paymentStatus` — never inferred from anything else. An order is
 * always one of: payment pending (warning), confirmed (success, plus "Paid"
 * once the backend has verified payment), preparing (warning — in progress,
 * plus "Paid"), ready (success, plus "Paid"), or cancelled (danger). A
 * cancelled order never shows "Payment pending": its payment is no longer
 * awaited.
 */
export function orderStatusBadges(order: {
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
}): OrderStatusBadge[] {
  // Typed wider than `OrderStatusBadge` on purpose: at runtime the lookup can miss.
  const known: OrderStatusBadge | undefined = ORDER_STATUS_BADGE[order.status];
  const badges = [known ?? unknownStatusBadge(order.status)];
  if (order.paymentStatus === 'paid') {
    badges.push({ label: 'Paid', tone: 'success' });
  }
  return badges;
}

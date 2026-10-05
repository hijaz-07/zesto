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
  picked_up: { label: 'Picked up', tone: 'success' },
  // Finished: nothing is left to do, so it is quiet rather than another green.
  completed: { label: 'Completed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/**
 * A status as words, e.g. `out_for_delivery` -> "Out for delivery". Used for a
 * status this build does not know — one the backend added after this bundle was
 * built (a later fulfilment state, say) — so an unfamiliar one is shown as text
 * rather than crashing a whole list or page over one row.
 */
export function humanizeStatus(status: string): string {
  const words = status.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

function unknownStatusBadge(status: string): OrderStatusBadge {
  return { label: humanizeStatus(status), tone: 'neutral' };
}

/**
 * The badges shown for an order in the history list, from the backend's own
 * `status`/`paymentStatus` — never inferred from anything else. An order is
 * always one of: payment pending (warning), confirmed (success, plus "Paid"
 * once the backend has verified payment), preparing (warning — in progress,
 * plus "Paid"), ready (success, plus "Paid"), picked up (success, plus "Paid"),
 * completed (neutral, plus "Paid"), or cancelled (danger). A cancelled order
 * never shows "Payment pending": its payment is no longer awaited.
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

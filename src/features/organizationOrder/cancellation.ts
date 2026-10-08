import type { BadgeTone } from '../../components/ui/Badge';
import type { OrganizationMemberRole } from '../../domain/types';
import type { OrderPaymentStatus, OrderStatus } from '../order/types';
import type { OrganizationOrderSummary } from './types';

/**
 * Why an organization cancels an order, exactly the backend's
 * `ORGANIZATION_CANCELLATION_REASONS` (functions/src/domain/cancellation.ts).
 * Required on an organization cancellation; no free text in v1.
 */
export const ORGANIZATION_CANCELLATION_REASONS = [
  'item_unavailable',
  'outlet_closed',
  'cannot_fulfil_in_time',
  'duplicate_order',
  'customer_requested',
  'other',
] as const;

export type OrganizationCancellationReason = (typeof ORGANIZATION_CANCELLATION_REASONS)[number];

/** The operator's words for each approved reason. */
export const ORGANIZATION_CANCELLATION_REASON_LABEL: Record<OrganizationCancellationReason, string> = {
  item_unavailable: 'An item is unavailable',
  outlet_closed: 'The outlet is closed',
  cannot_fulfil_in_time: "We can't fulfil it in time",
  duplicate_order: 'Duplicate order',
  customer_requested: 'The customer asked us to cancel',
  other: 'Other',
};

/**
 * Whether `role` is offered the Cancel order action: owner and manager only, as
 * on the backend (`ORDER_CANCELLATION_ROLES`). Cancelling a paid order starts a
 * refund, which is money, so unlike fulfilment staff are left out. Only what is
 * shown — the backend checks the caller's active membership and role on every
 * request, so a person who tampers with this still cannot cancel anything.
 */
export function canCancelOrders(role: OrganizationMemberRole): boolean {
  return role === 'owner' || role === 'manager';
}

/**
 * Whether `role` is offered refund recovery (retrying a failed refund): owner and
 * manager only. Its own function, like the backend's separate role lists, because
 * "may cancel" and "may recover money" are different decisions that merely
 * coincide today.
 */
export function canRecoverRefunds(role: OrganizationMemberRole): boolean {
  return role === 'owner' || role === 'manager';
}

/** The statuses an organization may cancel from (the backend's `CANCELLABLE_ORDER_STATUSES`). */
const CANCELLABLE_STATUSES: readonly OrderStatus[] = ['pending_payment', 'confirmed', 'preparing', 'ready'];

/**
 * Whether the row on screen is one the Cancel order action is offered for, from
 * the status the backend last reported: not picked up, completed or already
 * cancelled. A hint for the screen only — the cancel request is decided again by
 * the backend, which may still refuse it (409).
 */
export function isOrderCancellable(order: { status: OrderStatus }): boolean {
  return CANCELLABLE_STATUSES.includes(order.status);
}

/** The cancellation line under a cancelled order's status: who cancelled it. */
export function cancelledByText(order: OrganizationOrderSummary): string | null {
  if (order.status !== 'cancelled' || !order.cancellation) {
    return null;
  }
  return order.cancellation.cancelledBy === 'customer' ? 'Cancelled by the customer' : 'Cancelled by your team';
}

export type RefundViewKind = 'pending' | 'processed' | 'failed' | 'partial' | 'unavailable';

/** How a cancelled order's refund is shown to an operator. */
export interface OrganizationRefundView {
  kind: RefundViewKind;
  /** The badge text: words, so the state is never carried by color alone. */
  label: string;
  tone: BadgeTone;
  /** Whether an owner or manager must act (the refund did not complete by itself). */
  needsAttention: boolean;
}

/**
 * The refund state to show for an order, or `null` when none applies (the order
 * was not cancelled, or was cancelled before any money was captured). Built only
 * from the backend's own `status`, `paymentStatus` and refund summary:
 *
 * - `in_progress` → "Refund pending" (requested or submitted; the operator need
 *   not tell the two apart);
 * - `refunded` → "Refund processed";
 * - `attention_required` → "Refund failed — attention required";
 * - `partially_refunded` → surfaced as needing attention too (v1 refunds in full,
 *   so it should not occur);
 * - a cancelled, PAID order with no readable refund summary → "Refund status
 *   unavailable": never a guessed state.
 */
export function organizationRefundView(order: {
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  refund?: OrganizationOrderSummary['refund'];
}): OrganizationRefundView | null {
  if (order.status !== 'cancelled') {
    return null;
  }
  if (!order.refund) {
    return order.paymentStatus === 'paid'
      ? { kind: 'unavailable', label: 'Refund status unavailable', tone: 'neutral', needsAttention: false }
      : null;
  }
  switch (order.refund.state) {
    case 'refunded':
      return { kind: 'processed', label: 'Refund processed', tone: 'success', needsAttention: false };
    case 'attention_required':
      return { kind: 'failed', label: 'Refund failed — attention required', tone: 'danger', needsAttention: true };
    case 'partially_refunded':
      return { kind: 'partial', label: 'Partly refunded — attention required', tone: 'danger', needsAttention: true };
    case 'in_progress':
      return { kind: 'pending', label: 'Refund pending', tone: 'warning', needsAttention: false };
  }
}

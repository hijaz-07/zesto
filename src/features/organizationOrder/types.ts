import type { ISODateString } from '../../types/common';
import type { OrderCurrency, OrderPaymentStatus, OrderStatus, OrderSummaryItem } from '../order/types';

/**
 * The organization-side order list, mirroring the backend's response shape
 * exactly (functions/src/domain/organizationOrders.ts's
 * `OrganizationOrderSummaryResponse`). Deliberately carries no customer
 * identity, no organization id, no payment-provider data and no per-line
 * prices: the first order dashboard is read-only and shows none of them. The
 * status/payment/currency vocabulary is the one customers already see (see
 * ../order/types) — this feature adds no order states of its own.
 */

export type OrganizationOrderId = string;

/** One row of the organization's order list. */
export interface OrganizationOrderSummary {
  id: OrganizationOrderId;
  outletId: string;
  menuId: string;
  /** Absent if the outlet no longer exists. */
  outlet?: { name: string };
  /** Absent if the menu no longer exists. */
  menu?: { title: string; menuDate: ISODateString };
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  currency: OrderCurrency;
  subtotalInPaise: number;
  totalInPaise: number;
  /** Total portions ordered across every line. */
  itemCount: number;
  /** At most the first ten lines, from the order's own snapshots; see `moreItemLines`. */
  items: OrderSummaryItem[];
  /** How many further lines exist beyond `items`. */
  moreItemLines: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /** Present on a cancelled order whose cancellation was recorded. */
  cancellation?: OrganizationOrderCancellation;
  /** Present on an order that has had refund activity. */
  refund?: OrganizationOrderRefund;
}

/**
 * What an operator is told of a cancellation: whether the customer or the
 * organization cancelled it, and when. Never the reason, the actor's identity or
 * any other audit field — the backend does not send them and this type has no
 * place for them.
 */
export interface OrganizationOrderCancellation {
  cancelledBy: 'customer' | 'organization';
  cancelledAt: ISODateString;
}

/**
 * The backend's payment-level refund state for an order, as mirrored on the
 * order (functions/src/domain/refundAmounts.ts's `PaymentRefundState`, minus
 * `none`, which is sent as no block at all).
 */
export const ORGANIZATION_REFUND_STATES = [
  'in_progress',
  'partially_refunded',
  'refunded',
  'attention_required',
] as const;

export type OrganizationRefundState = (typeof ORGANIZATION_REFUND_STATES)[number];

/** The refund summary on an organization order row: its state and what has been refunded so far. No refund, payment or provider identifier. */
export interface OrganizationOrderRefund {
  state: OrganizationRefundState;
  refundedInPaise: number;
}

/** One page of the organization's orders, newest first. */
export interface OrganizationOrdersPage {
  orders: OrganizationOrderSummary[];
  /** Pass back as `cursor` for the next page; `null` when this is the last page. */
  nextCursor: string | null;
}

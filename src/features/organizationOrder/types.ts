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
}

/** One page of the organization's orders, newest first. */
export interface OrganizationOrdersPage {
  orders: OrganizationOrderSummary[];
  /** Pass back as `cursor` for the next page; `null` when this is the last page. */
  nextCursor: string | null;
}

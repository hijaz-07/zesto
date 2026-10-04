import type { ISODateString } from '../../types/common';

/**
 * Customer order types, mirroring the backend's authoritative response shape
 * exactly (functions/src/domain/orders.ts's `OrderResponse`). An `Order` is
 * always the backend's own computed result — id, prices, totals, status —
 * never constructed or derived from the cart on the frontend (see
 * `../../features/cart`'s types, which remain a separate, purely local
 * preview of demand until an order is actually created).
 */

export type OrderId = string;

/**
 * Every status the backend gives an order (functions/src/domain/orders.ts's
 * `OrderStatus`). `preparing` and `ready` are set by the organization as it
 * fulfils a paid order; the customer never changes them.
 */
export const ORDER_STATUSES = ['pending_payment', 'confirmed', 'preparing', 'ready', 'cancelled'] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Whether a payment has confirmed an order — it is `confirmed`, or has since
 * moved on into fulfilment (`preparing`, `ready`). Once the organization starts
 * work on an order it is no longer `confirmed`, but it is still a paid order,
 * so anything that asks "has this been paid and accepted?" must use this
 * rather than comparing with `'confirmed'`.
 */
export function isPaymentConfirmedStatus(status: OrderStatus): boolean {
  return status === 'confirmed' || status === 'preparing' || status === 'ready';
}

/** `'paid'` is only ever set by the backend, after server-side verification of a Razorpay payment (see ../payment). */
export type OrderPaymentStatus = 'pending' | 'paid';

export type OrderCurrency = 'INR';

/** A snapshot of one ordered item, exactly as the backend recorded it at order-creation time. */
export interface OrderItemSnapshot {
  itemId: string;
  name: string;
  priceInPaise: number;
  quantity: number;
  lineTotalInPaise: number;
}

export interface Order {
  id: OrderId;
  organizationId: string;
  outletId: string;
  menuId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  currency: OrderCurrency;
  subtotalInPaise: number;
  totalInPaise: number;
  items: OrderItemSnapshot[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** One line of an order as summarized in the history list: name and quantity only. */
export interface OrderSummaryItem {
  name: string;
  quantity: number;
}

/**
 * One row of the customer's order history, mirroring the backend's list shape
 * exactly (functions/src/domain/orderHistory.ts's `OrderSummaryResponse`).
 * Deliberately a different type from `Order`: it is a summary (a few item
 * lines, no prices per line) plus display-only outlet/menu context. The full,
 * authoritative order is always re-read from `GET /orders/{orderId}` when the
 * customer opens one.
 */
export interface OrderSummary {
  id: OrderId;
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
  /** The first few lines only; see `moreItemLines`. */
  items: OrderSummaryItem[];
  /** How many further lines exist beyond `items`. */
  moreItemLines: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** One page of order history, newest first. */
export interface OrderHistoryPage {
  orders: OrderSummary[];
  /** Pass back as `cursor` for the next page; `null` when this is the last page. */
  nextCursor: string | null;
}

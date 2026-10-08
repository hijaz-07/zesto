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
 * `OrderStatus`). `preparing`, `ready`, `picked_up` and `completed` are set by
 * the organization as it fulfils a paid order and hands it over; the customer
 * never changes them. `picked_up` happens only when staff redeem the
 * customer's pickup credential.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'confirmed',
  'preparing',
  'ready',
  'picked_up',
  'completed',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Whether a payment has confirmed an order — it is `confirmed`, or has since
 * moved on into fulfilment (`preparing`, `ready`) or been handed over
 * (`picked_up`, `completed`). Once the organization starts work on an order it
 * is no longer `confirmed`, but it is still a paid order, so anything that asks
 * "has this been paid and accepted?" must use this rather than comparing with
 * `'confirmed'`.
 */
export function isPaymentConfirmedStatus(status: OrderStatus): boolean {
  return (
    status === 'confirmed' ||
    status === 'preparing' ||
    status === 'ready' ||
    status === 'picked_up' ||
    status === 'completed'
  );
}

/**
 * What a customer shows staff to collect a ready order, as returned by
 * `GET /orders/{orderId}/pickup-credential` (functions/src/domain/orderPickup.ts).
 * Exactly these two fields and nothing else. It is a secret: it lives in memory
 * only (see `useOrderPickup`) and is never put in storage, a URL, or any log.
 */
export interface PickupCredential {
  /** The text encoded in the QR code. */
  qrPayload: string;
  /** The backup code to read out, as the backend formats it (`K7QX-4M2P`). */
  code: string;
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

/**
 * Why a customer cancels, exactly the backend's `CUSTOMER_CANCELLATION_REASONS`
 * (functions/src/domain/cancellation.ts). Optional on a cancellation; no free text.
 */
export const CUSTOMER_CANCELLATION_REASONS = [
  'changed_my_mind',
  'ordered_by_mistake',
  'wrong_items_or_quantity',
  'wrong_pickup_time',
  'other',
] as const;

export type CustomerCancellationReason = (typeof CUSTOMER_CANCELLATION_REASONS)[number];

/**
 * The server's own answer to "can this customer cancel this order right now?"
 * (`GET /orders/{orderId}`, `POST /orders/{orderId}/cancel`). `canCancel` is a
 * hint for the screen only: the cancel route decides again and may still refuse.
 */
export interface OrderCancellation {
  state: 'cancellable' | 'not_cancellable' | 'cancelled';
  canCancel: boolean;
}

/** A refund's own status, exactly the backend's `REFUND_STATUS_VALUES`. */
export const REFUND_STATUSES = ['requested', 'pending', 'processed', 'failed'] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Whether a refund has settled one way or the other; nothing more will change on it. */
export function isTerminalRefundStatus(status: RefundStatus): boolean {
  return status === 'processed' || status === 'failed';
}

/**
 * The safe refund summary the backend gives the customer: how much, in what
 * state, and when it started and finished — never a provider, payment or refund
 * identifier (functions/src/domain/orderCancellation.ts's `CancellationRefundSummary`).
 */
export interface OrderRefund {
  status: RefundStatus;
  amountInPaise: number;
  currency: OrderCurrency;
  initiatedAt: ISODateString;
  /** Present only once the refund is `processed`. */
  completedAt?: ISODateString;
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
  /**
   * The server's cancellation hint. Absent where the order did not come from a
   * read that carries it (e.g. the payment-verification response), in which case
   * the screen offers no cancel action until it has re-read the order.
   */
  cancellation?: OrderCancellation;
  /** The order's refund, if it has one. Absent for an order that has none. */
  refund?: OrderRefund;
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

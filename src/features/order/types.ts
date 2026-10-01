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

export type OrderStatus = 'pending_payment' | 'confirmed' | 'cancelled';

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

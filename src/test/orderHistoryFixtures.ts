import type { OrderSummary } from '../features/order/types';

/** A confirmed, paid order as the history list endpoint returns it. */
export const confirmedSummary: OrderSummary = {
  id: 'order-1',
  outletId: 'outlet-1',
  menuId: 'menu-1',
  outlet: { name: 'Main Canteen' },
  menu: { title: 'Tuesday Special Menu', menuDate: '2026-09-29' },
  status: 'confirmed',
  paymentStatus: 'paid',
  currency: 'INR',
  subtotalInPaise: 30000,
  totalInPaise: 30000,
  itemCount: 3,
  items: [
    { name: 'Chicken Biriyani', quantity: 2 },
    { name: 'Veg Meals', quantity: 1 },
  ],
  moreItemLines: 0,
  createdAt: '2026-09-28T10:30:00+05:30',
  updatedAt: '2026-09-28T10:35:00+05:30',
};

/** An order still waiting for payment. */
export const pendingSummary: OrderSummary = {
  ...confirmedSummary,
  id: 'order-2',
  outlet: { name: 'Hostel Café' },
  menu: { title: 'Wednesday Menu', menuDate: '2026-09-30' },
  status: 'pending_payment',
  paymentStatus: 'pending',
  subtotalInPaise: 12000,
  totalInPaise: 12000,
  itemCount: 1,
  items: [{ name: 'Fish Curry Meals', quantity: 1 }],
  createdAt: '2026-09-29T09:00:00+05:30',
  updatedAt: '2026-09-29T09:00:00+05:30',
};

/** A cancelled order. */
export const cancelledSummary: OrderSummary = {
  ...confirmedSummary,
  id: 'order-3',
  outlet: { name: 'North Block Canteen' },
  menu: { title: 'Thursday Menu', menuDate: '2026-10-01' },
  status: 'cancelled',
  paymentStatus: 'pending',
  subtotalInPaise: 8000,
  totalInPaise: 8000,
  itemCount: 1,
  items: [{ name: 'Masala Dosa', quantity: 1 }],
  createdAt: '2026-09-30T08:00:00+05:30',
  updatedAt: '2026-09-30T08:10:00+05:30',
};

/** `count` distinct summaries, for pagination tests. */
export function manySummaries(count: number, idPrefix = 'bulk'): OrderSummary[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...confirmedSummary,
    id: `${idPrefix}-${index + 1}`,
    outlet: { name: `Canteen ${idPrefix}-${index + 1}` },
  }));
}

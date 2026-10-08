import type { Outlet } from '../domain/types';
import type { OrganizationOrderSummary } from '../features/organizationOrder/types';

/** A confirmed, paid order as the organization list endpoint returns it. */
export const confirmedOrgOrder: OrganizationOrderSummary = {
  id: 'order-confirmed-1',
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

/** A paid order the organization has started preparing, as the list/action endpoints return it. */
export const preparingOrgOrder: OrganizationOrderSummary = {
  ...confirmedOrgOrder,
  id: 'order-preparing-5',
  status: 'preparing',
  updatedAt: '2026-09-28T10:40:00+05:30',
};

/** A paid order the organization has marked ready for pickup. */
export const readyOrgOrder: OrganizationOrderSummary = {
  ...confirmedOrgOrder,
  id: 'order-ready-6',
  status: 'ready',
  updatedAt: '2026-09-28T10:50:00+05:30',
};

/** A paid order staff have handed over (they redeemed the customer's pickup credential), as the list/action endpoints return it. */
export const pickedUpOrgOrder: OrganizationOrderSummary = {
  ...confirmedOrgOrder,
  id: 'order-picked-up-7',
  status: 'picked_up',
  updatedAt: '2026-09-28T11:00:00+05:30',
};

/** A paid order staff have closed out after handing it over. */
export const completedOrgOrder: OrganizationOrderSummary = {
  ...confirmedOrgOrder,
  id: 'order-completed-8',
  status: 'completed',
  updatedAt: '2026-09-28T11:10:00+05:30',
};

/** An order still waiting for payment. */
export const pendingOrgOrder: OrganizationOrderSummary = {
  ...confirmedOrgOrder,
  id: 'order-pending-2',
  outletId: 'outlet-2',
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

/** A cancelled order whose payment never arrived. */
export const cancelledOrgOrder: OrganizationOrderSummary = {
  ...confirmedOrgOrder,
  id: 'order-cancelled-3',
  outletId: 'outlet-3',
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

/** An order with more lines than the list spells out. */
export const longOrgOrder: OrganizationOrderSummary = {
  ...confirmedOrgOrder,
  id: 'order-long-4',
  itemCount: 26,
  items: Array.from({ length: 10 }, (_unused, index) => ({ name: `Dish ${index + 1}`, quantity: 2 })),
  moreItemLines: 3,
};

/** `count` distinct orders, for pagination tests. */
export function manyOrgOrders(count: number, idPrefix = 'bulk'): OrganizationOrderSummary[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...confirmedOrgOrder,
    id: `${idPrefix}-${index + 1}`,
    outlet: { name: `Canteen ${idPrefix}-${index + 1}` },
  }));
}

function outlet(id: string, name: string, status: Outlet['status']): Outlet {
  return {
    id,
    organizationId: 'org-1',
    name,
    slug: id,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'U-1',
  };
}

/** Two active outlets and one deactivated one, as `GET /organizations/{id}/outlets` returns them. */
export const orgOutlets: Outlet[] = [
  outlet('outlet-1', 'Main Canteen', 'active'),
  outlet('outlet-2', 'Hostel Café', 'active'),
  outlet('outlet-3', 'Old Annex', 'inactive'),
];

/**
 * A paid order cancelled by the organization, with its refund in the given state
 * as the list endpoint reports it. `refund: null` is a cancelled paid order whose
 * refund block is missing.
 */
export function cancelledPaidOrgOrder(
  refund: OrganizationOrderSummary['refund'] | null = { state: 'in_progress', refundedInPaise: 0 },
  overrides: Partial<OrganizationOrderSummary> = {},
): OrganizationOrderSummary {
  return {
    ...confirmedOrgOrder,
    id: 'order-cancelled-paid-9',
    status: 'cancelled',
    updatedAt: '2026-09-30T08:10:00+05:30',
    cancellation: { cancelledBy: 'organization', cancelledAt: '2026-09-30T02:40:00.000Z' },
    ...(refund ? { refund } : {}),
    ...overrides,
  };
}

/** An unpaid order the customer cancelled: nothing was captured, so no refund. */
export const customerCancelledUnpaidOrgOrder: OrganizationOrderSummary = {
  ...cancelledOrgOrder,
  id: 'order-cancelled-unpaid-10',
  cancellation: { cancelledBy: 'customer', cancelledAt: '2026-09-30T02:40:00.000Z' },
};

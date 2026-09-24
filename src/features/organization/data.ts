import type { DemandLine, Menu } from '../../domain/types';

/** Placeholder data for the organization development shell. Not fetched from any backend. */
export const tomorrowsOrgMenu: Menu = {
  id: 'dev-menu-1',
  menuDate: '2026-09-25',
  title: "Tomorrow's Menu",
  state: 'ordering_open',
  orderingOpensAt: '2026-09-24T18:00:00+05:30',
  orderingClosesAt: '2026-09-25T09:00:00+05:30',
  pickupStartsAt: '2026-09-25T12:30:00+05:30',
  pickupEndsAt: '2026-09-25T14:00:00+05:30',
  items: [
    {
      id: 'item-chicken-biriyani',
      name: 'Chicken Biriyani',
      priceInPaise: 12000,
      displayOrder: 1,
      enabled: true,
    },
    {
      id: 'item-beef-biriyani',
      name: 'Beef Biriyani',
      priceInPaise: 13000,
      displayOrder: 2,
      enabled: true,
    },
    {
      id: 'item-veg-meals',
      name: 'Veg Meals',
      priceInPaise: 8000,
      displayOrder: 3,
      enabled: false,
    },
  ],
};

export const demandOverview: DemandLine[] = [
  { menuItemId: 'item-chicken-biriyani', menuItemName: 'Chicken Biriyani', totalQuantity: 42 },
  { menuItemId: 'item-beef-biriyani', menuItemName: 'Beef Biriyani', totalQuantity: 18 },
  { menuItemId: 'item-veg-meals', menuItemName: 'Veg Meals', totalQuantity: 9 },
];

import type { Menu } from '../../domain/types';

/** Placeholder data for the customer development shell. Not fetched from any backend. */
export const tomorrowsMenu: Menu = {
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
      description: 'Slow-cooked basmati rice with spiced chicken.',
      priceInPaise: 12000,
      displayOrder: 1,
      enabled: true,
    },
    {
      id: 'item-beef-biriyani',
      name: 'Beef Biriyani',
      description: 'Basmati rice layered with tender beef masala.',
      priceInPaise: 13000,
      displayOrder: 2,
      enabled: true,
    },
    {
      id: 'item-veg-meals',
      name: 'Veg Meals',
      description: 'Rice, sambar, curry, and two sides.',
      priceInPaise: 8000,
      displayOrder: 3,
      enabled: true,
    },
  ],
};

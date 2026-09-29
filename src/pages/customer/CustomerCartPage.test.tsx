import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyCart } from '../../features/cart/cart';
import { setCart } from '../../features/cart/store';
import type { ExploreMenuDetail } from '../../features/explore/types';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { CustomerCartPage } from './CustomerCartPage';

vi.mock('../../features/explore/useExploreMenu');

const mockedUseExploreMenu = vi.mocked(useExploreMenu);

function mockMenu(overrides: Partial<ReturnType<typeof useExploreMenu>>) {
  mockedUseExploreMenu.mockReturnValue({
    status: 'idle',
    outlet: null,
    menu: null,
    error: null,
    retry: vi.fn(),
    ...overrides,
  });
}

const menuDetail: ExploreMenuDetail = {
  id: 'menu-1',
  menuDate: '2026-09-30',
  title: 'Tuesday Special Menu',
  orderingOpensAt: '2026-09-29T18:00:00+05:30',
  orderingClosesAt: '2026-09-30T09:00:00+05:30',
  pickupStartsAt: '2026-09-30T12:30:00+05:30',
  pickupEndsAt: '2026-09-30T14:00:00+05:30',
  orderingState: 'open',
  items: [
    { id: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, displayOrder: 1 },
    { id: 'item-veg-meals', name: 'Veg Meals', priceInPaise: 8000, displayOrder: 2 },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/cart']}>
      <Routes>
        <Route path="/app/cart" element={<CustomerCartPage />} />
        <Route path="/explore" element={<div>Explore page</div>} />
        <Route path="/explore/outlets/:outletId/menus/:menuId" element={<div>Menu detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CustomerCartPage', () => {
  beforeEach(() => {
    mockedUseExploreMenu.mockReset();
    mockMenu({ status: 'idle' });
    window.localStorage.clear();
    setCart(createEmptyCart());
  });

  it('shows an empty-cart state with a way back to browse menus', () => {
    renderPage();

    expect(screen.getByText('Your cart is empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Browse menus' }));
    expect(screen.getByText('Explore page')).toBeInTheDocument();
  });

  it('renders each cart line with quantity, unit price, and line total', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [
        { itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2 },
        { itemId: 'item-veg-meals', name: 'Veg Meals', priceInPaise: 8000, quantity: 1 },
      ],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByText('Tuesday Special Menu')).toBeInTheDocument();
    expect(screen.getByTestId('cart-quantity-item-chicken-biriyani')).toHaveTextContent('2');
    expect(screen.getByText('₹120 each · ₹240')).toBeInTheDocument();
    expect(screen.getByTestId('cart-quantity-item-veg-meals')).toHaveTextContent('1');
    expect(screen.getByText('₹80 each · ₹80')).toBeInTheDocument();
  });

  it('renders the subtotal across all lines', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [
        { itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2 },
        { itemId: 'item-veg-meals', name: 'Veg Meals', priceInPaise: 8000, quantity: 1 },
      ],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('₹320')).toBeInTheDocument();
  });

  it('updates totals immediately when a line is removed', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [
        { itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 },
        { itemId: 'item-veg-meals', name: 'Veg Meals', priceInPaise: 8000, quantity: 1 },
      ],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    const rows = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(rows[0]);

    expect(screen.queryByTestId('cart-quantity-item-chicken-biriyani')).not.toBeInTheDocument();
    expect(screen.getByText('₹80')).toBeInTheDocument();
  });

  it('flags a line whose item is no longer on the live published menu, without dropping it from the total', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [{ itemId: 'item-discontinued', name: 'Discontinued Item', priceInPaise: 5000, quantity: 1 }],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByText('No longer available on this menu.')).toBeInTheDocument();
    expect(screen.getByText('₹50')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase quantity for Discontinued Item' })).toBeDisabled();
  });

  it('flags a line whose price has changed on the live menu, while keeping the snapshot price as the total', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [{ itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 11000, quantity: 1 }],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByText('Price on the menu is now ₹120.')).toBeInTheDocument();
    expect(screen.getByText('₹110 each · ₹110')).toBeInTheDocument();
  });

  it('never renders a place-order, pay-now, or checkout button', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [{ itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 }],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.queryByRole('button', { name: /place order/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay now/i })).not.toBeInTheDocument();
    expect(screen.getByText(/checkout isn't available yet/i)).toBeInTheDocument();
  });

  it('navigates back to the menu the cart belongs to', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [{ itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 }],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Return to Menu' }));

    expect(screen.getByText('Menu detail page')).toBeInTheDocument();
  });
});

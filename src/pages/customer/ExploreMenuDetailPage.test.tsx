import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyCart } from '../../features/cart/cart';
import { setCart } from '../../features/cart/store';
import type { ExploreMenuDetail } from '../../features/explore/types';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { ApiError } from '../../lib/api/client';
import { formatDate, formatTime } from '../../utils/date';
import { ExploreMenuDetailPage } from './ExploreMenuDetailPage';

vi.mock('../../features/explore/useExploreMenu');

const mockedUseExploreMenu = vi.mocked(useExploreMenu);

function mockMenu(overrides: Partial<ReturnType<typeof useExploreMenu>>) {
  mockedUseExploreMenu.mockReturnValue({
    status: 'ready',
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
  description: 'A special weekday spread.',
  orderingOpensAt: '2026-09-29T18:00:00+05:30',
  orderingClosesAt: '2026-09-30T09:00:00+05:30',
  pickupStartsAt: '2026-09-30T12:30:00+05:30',
  pickupEndsAt: '2026-09-30T14:00:00+05:30',
  orderingState: 'open',
  items: [
    {
      id: 'item-chicken-biriyani',
      name: 'Chicken Biriyani',
      description: 'Slow-cooked basmati rice with spiced chicken.',
      priceInPaise: 12000,
      displayOrder: 1,
    },
    {
      id: 'item-veg-meals',
      name: 'Veg Meals',
      priceInPaise: 8000,
      displayOrder: 2,
    },
  ],
};

function renderPage(initialPath = '/explore/outlets/outlet-1/menus/menu-1') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/explore/outlets/:outletId" element={<div>Outlet detail page</div>} />
        <Route path="/explore/outlets/:outletId/menus/:menuId" element={<ExploreMenuDetailPage />} />
        <Route path="/app/cart" element={<div>Cart page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExploreMenuDetailPage', () => {
  beforeEach(() => {
    mockedUseExploreMenu.mockReset();
    window.localStorage.clear();
    setCart(createEmptyCart());
  });

  it('shows a loading state while the menu is being fetched', () => {
    mockMenu({ status: 'loading' });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when the menu fails to load', () => {
    const retry = vi.fn();
    const error = new ApiError(404, 'not_found', 'Not found.');
    mockMenu({ status: 'error', error, retry });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Menu not available.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders the menu title, date, description, and ordering state', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Tuesday Special Menu' })).toBeInTheDocument();
    expect(screen.getByText(formatDate(menuDetail.menuDate))).toBeInTheDocument();
    expect(screen.getByText('A special weekday spread.')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('renders the pickup window', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    const expected = `Pickup ${formatTime(menuDetail.pickupStartsAt)} – ${formatTime(menuDetail.pickupEndsAt)}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders the published menu items with formatted prices', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
    expect(screen.getByText('₹120')).toBeInTheDocument();
  });

  it('never renders checkout, payment, or place-order affordances', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.queryByText(/checkout/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/place order/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pay now/i)).not.toBeInTheDocument();
  });

  it('navigates back to the outlet page', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Outlet' }));

    expect(screen.getByText('Outlet detail page')).toBeInTheDocument();
  });

  it('renders quantity controls for each item, starting at 0, with no cart entry point yet', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByTestId('cart-quantity-item-chicken-biriyani')).toHaveTextContent('0');
    expect(screen.getByTestId('cart-quantity-item-veg-meals')).toHaveTextContent('0');
    expect(screen.queryByRole('button', { name: 'View Cart' })).not.toBeInTheDocument();
  });

  it('adding an item shows the cart entry point with the running total, and takes the customer to /app/cart', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' }));

    expect(screen.getByTestId('cart-quantity-item-chicken-biriyani')).toHaveTextContent('2');
    expect(screen.getByText('2 items · ₹240')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View Cart' }));
    expect(screen.getByText('Cart page')).toBeInTheDocument();
  });

  it('decreasing back to 0 removes the item and hides the cart entry point again', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease quantity for Chicken Biriyani' }));

    expect(screen.getByTestId('cart-quantity-item-chicken-biriyani')).toHaveTextContent('0');
    expect(screen.queryByRole('button', { name: 'View Cart' })).not.toBeInTheDocument();
  });

  it('shows a conflict banner and disables adding when the cart already holds a different menu, until cleared', () => {
    setCart({
      context: { outletId: 'outlet-other', menuId: 'menu-other' },
      lines: [{ itemId: 'item-x', name: 'Item X', priceInPaise: 5000, quantity: 1 }],
    });
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByText('Your cart has items from a different menu.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear cart to add items here' }));

    expect(screen.queryByText('Your cart has items from a different menu.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' })).not.toBeDisabled();
  });
});

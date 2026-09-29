import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { createEmptyCart } from '../../features/cart/cart';
import { getCartSnapshot, setCart } from '../../features/cart/store';
import type { ExploreMenuDetail } from '../../features/explore/types';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { createOrder } from '../../features/order/api';
import { CustomerCartPage } from './CustomerCartPage';

vi.mock('../../features/explore/useExploreMenu');
vi.mock('../../features/order/api');

const mockedUseExploreMenu = vi.mocked(useExploreMenu);
const mockedCreateOrder = vi.mocked(createOrder);

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

const outlet = { id: 'outlet-1', name: 'Main Canteen' };
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

const createdOrder = {
  id: 'order-1',
  organizationId: 'org-1',
  outletId: 'outlet-1',
  menuId: 'menu-1',
  status: 'pending_payment' as const,
  paymentStatus: 'pending' as const,
  currency: 'INR' as const,
  subtotalInPaise: 24000,
  totalInPaise: 24000,
  items: [
    { itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000 },
  ],
  createdAt: '2026-09-30T08:00:00+05:30',
  updatedAt: '2026-09-30T08:00:00+05:30',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/cart']}>
      <Routes>
        <Route path="/app/cart" element={<CustomerCartPage />} />
        <Route path="/app/orders/:orderId" element={<div>Confirmation page</div>} />
        <Route path="/explore" element={<div>Explore page</div>} />
        <Route path="/explore/outlets/:outletId/menus/:menuId" element={<div>Menu detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function setCartWithTwoLines() {
  setCart({
    context: { outletId: 'outlet-1', menuId: 'menu-1' },
    lines: [
      { itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2 },
      { itemId: 'item-veg-meals', name: 'Veg Meals', priceInPaise: 8000, quantity: 1 },
    ],
  });
}

describe('CustomerCartPage', () => {
  beforeEach(() => {
    mockedUseExploreMenu.mockReset();
    mockedCreateOrder.mockReset();
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
    setCartWithTwoLines();
    mockMenu({ status: 'ready', outlet, menu: menuDetail });

    renderPage();

    expect(screen.getByText('Tuesday Special Menu')).toBeInTheDocument();
    expect(screen.getByTestId('cart-quantity-item-chicken-biriyani')).toHaveTextContent('2');
    expect(screen.getByText('₹120 each · ₹240')).toBeInTheDocument();
    expect(screen.getByTestId('cart-quantity-item-veg-meals')).toHaveTextContent('1');
    expect(screen.getByText('₹80 each · ₹80')).toBeInTheDocument();
  });

  it('renders the subtotal across all lines', () => {
    setCartWithTwoLines();
    mockMenu({ status: 'ready', outlet, menu: menuDetail });

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
    mockMenu({ status: 'ready', outlet, menu: menuDetail });

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
    mockMenu({ status: 'ready', outlet, menu: menuDetail });

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
    mockMenu({ status: 'ready', outlet, menu: menuDetail });

    renderPage();

    expect(screen.getByText('Price on the menu is now ₹120.')).toBeInTheDocument();
    expect(screen.getByText('₹110 each · ₹110')).toBeInTheDocument();
  });

  it('shows a Review Order step rather than any pay/checkout button on the cart itself', () => {
    setCartWithTwoLines();
    mockMenu({ status: 'ready', outlet, menu: menuDetail });

    renderPage();

    expect(screen.getByRole('button', { name: 'Review Order' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Place Order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /checkout/i })).not.toBeInTheDocument();
  });

  it('navigates back to the menu the cart belongs to', () => {
    setCart({
      context: { outletId: 'outlet-1', menuId: 'menu-1' },
      lines: [{ itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1 }],
    });
    mockMenu({ status: 'ready', outlet, menu: menuDetail });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Return to Menu' }));

    expect(screen.getByText('Menu detail page')).toBeInTheDocument();
  });

  describe('review stage', () => {
    function enterReview() {
      setCartWithTwoLines();
      mockMenu({ status: 'ready', outlet, menu: menuDetail });
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Review Order' }));
    }

    it('shows the review with outlet, menu, items, and subtotal, and enables Place Order when nothing is stale', () => {
      enterReview();

      expect(screen.getByText('Review Order')).toBeInTheDocument();
      expect(screen.getByText('Main Canteen')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Place Order' })).toBeEnabled();
    });

    it('disables Place Order and explains why when the cart is stale', () => {
      setCart({
        context: { outletId: 'outlet-1', menuId: 'menu-1' },
        lines: [{ itemId: 'item-chicken-biriyani', name: 'Chicken Biriyani', priceInPaise: 11000, quantity: 1 }],
      });
      mockMenu({ status: 'ready', outlet, menu: menuDetail });
      renderPage();

      fireEvent.click(screen.getByRole('button', { name: 'Review Order' }));

      expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
      expect(screen.getByText(/price changed to ₹120/)).toBeInTheDocument();
    });

    it('disables Place Order when ordering has closed', () => {
      setCartWithTwoLines();
      mockMenu({ status: 'ready', outlet, menu: { ...menuDetail, orderingState: 'closed' } });
      renderPage();

      fireEvent.click(screen.getByRole('button', { name: 'Review Order' }));

      expect(screen.getByText('Ordering has closed for this menu.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
    });

    it('Back to Cart returns to the cart-editing stage', () => {
      enterReview();

      fireEvent.click(screen.getByRole('button', { name: 'Back to Cart' }));

      expect(screen.getByRole('button', { name: 'Review Order' })).toBeInTheDocument();
    });
  });

  describe('order submission', () => {
    function enterReview() {
      setCartWithTwoLines();
      mockMenu({ status: 'ready', outlet, menu: menuDetail });
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Review Order' }));
    }

    it('creates the order, clears the cart, and navigates to the confirmation page on success', async () => {
      mockedCreateOrder.mockResolvedValue({ order: createdOrder });
      enterReview();

      fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));

      await waitFor(() => expect(screen.getByText('Confirmation page')).toBeInTheDocument());
      expect(getCartSnapshot()).toEqual(createEmptyCart());
    });

    it('sends only outletId, menuId, and itemId/quantity items — never cart prices', async () => {
      mockedCreateOrder.mockResolvedValue({ order: createdOrder });
      enterReview();

      fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));

      await waitFor(() => expect(mockedCreateOrder).toHaveBeenCalledTimes(1));
      const [input] = mockedCreateOrder.mock.calls[0];
      expect(input).toMatchObject({
        outletId: 'outlet-1',
        menuId: 'menu-1',
        items: [
          { itemId: 'item-chicken-biriyani', quantity: 2 },
          { itemId: 'item-veg-meals', quantity: 1 },
        ],
      });
      expect(typeof input.idempotencyKey).toBe('string');
      expect(input.idempotencyKey.length).toBeGreaterThan(0);
    });

    it('shows a loading state and disables the button while the request is in flight', async () => {
      let resolveCreate!: (value: { order: typeof createdOrder }) => void;
      mockedCreateOrder.mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)));
      enterReview();

      fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));

      expect(screen.getByRole('button', { name: 'Placing order…' })).toBeDisabled();

      resolveCreate({ order: createdOrder });
      await waitFor(() => expect(screen.getByText('Confirmation page')).toBeInTheDocument());
    });

    it('reuses the same idempotency key when the same submission is retried', async () => {
      mockedCreateOrder.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Try again.'));
      mockedCreateOrder.mockResolvedValueOnce({ order: createdOrder });
      enterReview();

      fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));
      await waitFor(() => expect(mockedCreateOrder).toHaveBeenCalledTimes(1));
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));
      await waitFor(() => expect(mockedCreateOrder).toHaveBeenCalledTimes(2));

      const firstKey = mockedCreateOrder.mock.calls[0][0].idempotencyKey;
      const secondKey = mockedCreateOrder.mock.calls[1][0].idempotencyKey;
      expect(secondKey).toBe(firstKey);
    });

    it('keeps the cart intact and shows the backend error when order creation fails', async () => {
      mockedCreateOrder.mockRejectedValue(new ApiError(400, 'invalid_argument', 'Ordering has closed for this menu.'));
      enterReview();
      const cartBeforeSubmit = getCartSnapshot();

      fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));

      await screen.findByText('Ordering has closed for this menu.');
      expect(getCartSnapshot()).toEqual(cartBeforeSubmit);
      expect(screen.getByRole('button', { name: 'Place Order' })).toBeInTheDocument();
    });

    it('only clears the cart after the backend confirms success, never before', async () => {
      let resolveCreate!: (value: { order: typeof createdOrder }) => void;
      mockedCreateOrder.mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)));
      enterReview();

      fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));
      expect(getCartSnapshot().lines).toHaveLength(2);

      resolveCreate({ order: createdOrder });
      await waitFor(() => expect(getCartSnapshot()).toEqual(createEmptyCart()));
    });
  });
});

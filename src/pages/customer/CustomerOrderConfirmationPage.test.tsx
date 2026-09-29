import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { getOrder } from '../../features/order/api';
import { CustomerOrderConfirmationPage } from './CustomerOrderConfirmationPage';

vi.mock('../../features/order/api');
vi.mock('../../features/explore/useExploreMenu');

const mockedGetOrder = vi.mocked(getOrder);
const mockedUseExploreMenu = vi.mocked(useExploreMenu);

const order = {
  id: 'order-1',
  organizationId: 'org-1',
  outletId: 'outlet-1',
  menuId: 'menu-1',
  status: 'pending_payment' as const,
  paymentStatus: 'pending' as const,
  currency: 'INR' as const,
  subtotalInPaise: 30000,
  totalInPaise: 30000,
  items: [
    { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2, lineTotalInPaise: 24000 },
    { itemId: 'item-2', name: 'Veg Meals', priceInPaise: 6000, quantity: 1, lineTotalInPaise: 6000 },
  ],
  createdAt: '2026-09-30T08:00:00+05:30',
  updatedAt: '2026-09-30T08:00:00+05:30',
};

function renderPage(orderId = 'order-1') {
  return render(
    <MemoryRouter initialEntries={[`/app/orders/${orderId}`]}>
      <Routes>
        <Route path="/app/orders/:orderId" element={<CustomerOrderConfirmationPage />} />
        <Route path="/explore" element={<div>Explore page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CustomerOrderConfirmationPage', () => {
  beforeEach(() => {
    mockedGetOrder.mockReset();
    mockedUseExploreMenu.mockReset();
    mockedUseExploreMenu.mockReturnValue({
      status: 'idle',
      outlet: null,
      menu: null,
      error: null,
      retry: vi.fn(),
    });
  });

  it('shows a loading state while the order is being fetched', () => {
    mockedGetOrder.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByText('Loading your order…')).toBeInTheDocument();
  });

  it('renders the order ID, status, payment status, item snapshots, subtotal, and total from the backend response', async () => {
    mockedGetOrder.mockResolvedValue({ order });

    renderPage();

    await waitFor(() => expect(screen.getByText('Order #order-1')).toBeInTheDocument());
    expect(screen.getByText('Payment required')).toBeInTheDocument();
    expect(screen.getByText('Payment pending')).toBeInTheDocument();
    expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
    expect(screen.getByText('Qty 2 · ₹120 each')).toBeInTheDocument();
    expect(screen.getByText('₹240')).toBeInTheDocument();
    expect(screen.getByText('Veg Meals')).toBeInTheDocument();
    expect(screen.getByText('₹60')).toBeInTheDocument();
    expect(screen.getByText('₹300')).toBeInTheDocument();
    expect(screen.getByText('₹300 INR')).toBeInTheDocument();
  });

  it('shows a "payment will be added next" message, never implying the order is paid or confirmed', async () => {
    mockedGetOrder.mockResolvedValue({ order });

    renderPage();

    await waitFor(() => expect(screen.getByText(/payment will be added next/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^paid$/i)).not.toBeInTheDocument();
  });

  it('calls getOrder with the orderId from the route', async () => {
    mockedGetOrder.mockResolvedValue({ order });

    renderPage('order-1');

    await waitFor(() => expect(mockedGetOrder).toHaveBeenCalledWith('order-1'));
  });

  it('re-fetches from the backend on a fresh mount, so a page refresh still loads the order', async () => {
    mockedGetOrder.mockResolvedValue({ order });

    const first = renderPage();
    await waitFor(() => expect(screen.getByText('Order #order-1')).toBeInTheDocument());
    first.unmount();

    renderPage();
    await waitFor(() => expect(mockedGetOrder).toHaveBeenCalledTimes(2));
  });

  it('shows an error state with a retry option when the order fails to load', async () => {
    mockedGetOrder.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Order not found.'));
    mockedGetOrder.mockResolvedValueOnce({ order });

    renderPage();

    await waitFor(() => expect(screen.getByText('Order not found.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('Order #order-1')).toBeInTheDocument());
  });
});

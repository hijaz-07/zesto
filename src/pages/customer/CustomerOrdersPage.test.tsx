import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listOrders } from '../../features/order/api';
import type { OrderHistoryPage } from '../../features/order/types';
import { ApiError } from '../../lib/api/client';
import { FakeIntersectionObserver } from '../../test/fakeIntersectionObserver';
import {
  cancelledSummary,
  confirmedSummary,
  manySummaries,
  pendingSummary,
} from '../../test/orderHistoryFixtures';
import { CustomerOrdersPage } from './CustomerOrdersPage';

vi.mock('../../features/order/api');

const mockedListOrders = vi.mocked(listOrders);

function page(orders: OrderHistoryPage['orders'], nextCursor: string | null = null): OrderHistoryPage {
  return { orders, nextCursor };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/orders']}>
      <Routes>
        <Route path="/app/orders" element={<CustomerOrdersPage />} />
        <Route path="/app/orders/:orderId" element={<OrderDetailProbe />} />
        <Route path="/explore" element={<div>Explore page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CustomerOrdersPage', () => {
  beforeEach(() => {
    mockedListOrders.mockReset();
    FakeIntersectionObserver.install();
  });

  afterEach(() => {
    FakeIntersectionObserver.uninstall();
  });

  it('shows the My Orders heading', async () => {
    mockedListOrders.mockResolvedValue(page([confirmedSummary]));

    renderPage();

    expect(screen.getByRole('heading', { name: 'My Orders' })).toBeInTheDocument();
    await screen.findByText('Main Canteen');
  });

  it('shows a loading state while the first page is being fetched', () => {
    mockedListOrders.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading your orders…');
  });

  it('asks the backend for the first page with only a page-size hint — no user identifier, no cursor', async () => {
    mockedListOrders.mockResolvedValue(page([]));

    renderPage();

    await screen.findByText('No orders yet');
    expect(mockedListOrders).toHaveBeenCalledTimes(1);
    expect(mockedListOrders).toHaveBeenCalledWith({ limit: 20 });
  });

  describe('empty state', () => {
    it('shows an empty state for a customer with no orders', async () => {
      mockedListOrders.mockResolvedValue(page([]));

      renderPage();

      expect(await screen.findByText('No orders yet')).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Your orders' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('offers a way to browse menus', async () => {
      mockedListOrders.mockResolvedValue(page([]));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Browse menus' }));

      expect(screen.getByText('Explore page')).toBeInTheDocument();
    });
  });

  describe('order list', () => {
    it('renders every order, in the order the backend returned them (newest first)', async () => {
      mockedListOrders.mockResolvedValue(page([cancelledSummary, pendingSummary, confirmedSummary]));

      renderPage();

      const list = await screen.findByRole('list', { name: 'Your orders' });
      const cards = within(list).getAllByRole('listitem');
      expect(cards).toHaveLength(3);
      expect(cards[0]).toHaveTextContent('North Block Canteen');
      expect(cards[1]).toHaveTextContent('Hostel Café');
      expect(cards[2]).toHaveTextContent('Main Canteen');
    });

    it('shows each order\'s outlet, menu, item summary, total and placed date/time', async () => {
      mockedListOrders.mockResolvedValue(page([confirmedSummary]));

      renderPage();

      const card = (await screen.findAllByRole('listitem'))[0];
      expect(within(card).getByText('Main Canteen')).toBeInTheDocument();
      expect(within(card).getByText(/Tuesday Special Menu/)).toBeInTheDocument();
      expect(within(card).getByText('Chicken Biriyani × 2')).toBeInTheDocument();
      expect(within(card).getByText('Veg Meals × 1')).toBeInTheDocument();
      expect(within(card).getByText('₹300')).toBeInTheDocument();
      expect(within(card).getByText(/^Placed 28 Sep(t)? 2026, 10:30\s?(am|AM)$/)).toBeInTheDocument();
    });

    it('clearly distinguishes payment pending, confirmed/paid, and cancelled orders', async () => {
      mockedListOrders.mockResolvedValue(page([confirmedSummary, pendingSummary, cancelledSummary]));

      renderPage();

      const [confirmed, pending, cancelled] = await screen.findAllByRole('listitem');
      expect(within(confirmed).getByText('Confirmed')).toBeInTheDocument();
      expect(within(confirmed).getByText('Paid')).toBeInTheDocument();
      expect(within(pending).getByText('Payment pending')).toBeInTheDocument();
      expect(within(pending).queryByText('Paid')).not.toBeInTheDocument();
      expect(within(cancelled).getByText('Cancelled')).toBeInTheDocument();
      expect(within(cancelled).queryByText('Payment pending')).not.toBeInTheDocument();
    });

    it('opens the existing /app/orders/:orderId page for the order that was tapped', async () => {
      mockedListOrders.mockResolvedValue(page([confirmedSummary, pendingSummary]));

      renderPage();
      const [, second] = await screen.findAllByRole('listitem');
      fireEvent.click(within(second).getByRole('button'));

      expect(screen.getByText('Order detail for order-2')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows an error state with the failure message when the orders cannot be loaded', async () => {
      mockedListOrders.mockRejectedValue(new ApiError(500, 'internal', 'Something broke on our side.'));

      renderPage();

      expect(await screen.findByText("Couldn't load your orders")).toBeInTheDocument();
      expect(screen.getByText('Something broke on our side.')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByText('No orders yet')).not.toBeInTheDocument();
    });

    it('shows a friendly message when the backend is unavailable (503)', async () => {
      mockedListOrders.mockRejectedValue(new ApiError(503, 'unavailable', 'raw backend message'));

      renderPage();

      expect(
        await screen.findByText('Zesto is temporarily unavailable. Please try again in a moment.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('raw backend message')).not.toBeInTheDocument();
    });

    it('shows a generic message for a network failure', async () => {
      mockedListOrders.mockRejectedValue(new TypeError('Failed to fetch'));

      renderPage();

      expect(
        await screen.findByText('Something went wrong. Please check your connection and try again.'),
      ).toBeInTheDocument();
    });

    it('retries from the error state and then shows the orders', async () => {
      mockedListOrders.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      mockedListOrders.mockResolvedValueOnce(page([confirmedSummary]));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('Main Canteen')).toBeInTheDocument();
      expect(mockedListOrders).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Couldn't load your orders")).not.toBeInTheDocument();
    });
  });

  describe('pagination', () => {
    it('shows no Load more button when the backend reports no further page', async () => {
      mockedListOrders.mockResolvedValue(page(manySummaries(3), null));

      renderPage();

      await screen.findAllByRole('listitem');
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('loads the next page with the backend\'s cursor and appends it below the first', async () => {
      mockedListOrders.mockResolvedValueOnce(page(manySummaries(2, 'a'), 'cursor-1'));
      mockedListOrders.mockResolvedValueOnce(page(manySummaries(2, 'b'), null));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4));
      expect(mockedListOrders).toHaveBeenLastCalledWith({ limit: 20, cursor: 'cursor-1' });
      const names = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
      expect(names).toEqual(['Canteen a-1', 'Canteen a-2', 'Canteen b-1', 'Canteen b-2']);
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('disables the button and shows progress while the next page is loading', async () => {
      mockedListOrders.mockResolvedValueOnce(page(manySummaries(1, 'a'), 'cursor-1'));
      mockedListOrders.mockReturnValueOnce(new Promise(() => {}));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      const button = await screen.findByRole('button', { name: 'Loading…' });
      expect(button).toBeDisabled();
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    it('keeps the loaded orders and offers a retry when loading more fails', async () => {
      mockedListOrders.mockResolvedValueOnce(page(manySummaries(2, 'a'), 'cursor-1'));
      mockedListOrders.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      mockedListOrders.mockResolvedValueOnce(page(manySummaries(1, 'b'), null));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Zesto is temporarily unavailable. Please try again in a moment.',
      );
      expect(screen.getAllByRole('listitem')).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
      expect(mockedListOrders).toHaveBeenLastCalledWith({ limit: 20, cursor: 'cursor-1' });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('returning to the tab', () => {
    // Ionic keeps a tab's page mounted but hidden, so "returning" is the page
    // going from hidden back to visible — not a mount.
    function pageObserver() {
      const [observer] = FakeIntersectionObserver.live();
      return observer;
    }

    it('refreshes the list when the page is shown again, so an order placed since the last visit appears', async () => {
      mockedListOrders.mockResolvedValueOnce(page([confirmedSummary]));
      mockedListOrders.mockResolvedValueOnce(page([pendingSummary, confirmedSummary]));

      renderPage();
      await screen.findByText('Main Canteen');
      expect(screen.queryByText('Hostel Café')).not.toBeInTheDocument();

      act(() => pageObserver().emit(true));
      act(() => pageObserver().emit(false));
      expect(mockedListOrders).toHaveBeenCalledTimes(1);
      act(() => pageObserver().emit(true));

      expect(await screen.findByText('Hostel Café')).toBeInTheDocument();
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(mockedListOrders).toHaveBeenCalledTimes(2);
    });

    it('keeps the list on screen while refreshing, and does not show the loading state', async () => {
      mockedListOrders.mockResolvedValueOnce(page([confirmedSummary]));
      mockedListOrders.mockReturnValueOnce(new Promise(() => {}));

      renderPage();
      await screen.findByText('Main Canteen');

      act(() => pageObserver().emit(true));
      act(() => pageObserver().emit(false));
      act(() => pageObserver().emit(true));

      expect(screen.getByText('Main Canteen')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('does not refetch for the page simply being visible when it first appears', async () => {
      mockedListOrders.mockResolvedValue(page([confirmedSummary]));

      renderPage();
      await screen.findByText('Main Canteen');
      act(() => pageObserver().emit(true));

      expect(mockedListOrders).toHaveBeenCalledTimes(1);
    });

    it('does not double-fetch if the page is shown again while the first load is still in flight', () => {
      mockedListOrders.mockReturnValue(new Promise(() => {}));

      renderPage();
      act(() => pageObserver().emit(false));
      act(() => pageObserver().emit(true));

      expect(mockedListOrders).toHaveBeenCalledTimes(1);
    });
  });
});

/** Stands in for the existing order page, showing which order it was opened for. */
function OrderDetailProbe() {
  const { orderId } = useParams<{ orderId: string }>();
  return <div>Order detail for {orderId}</div>;
}

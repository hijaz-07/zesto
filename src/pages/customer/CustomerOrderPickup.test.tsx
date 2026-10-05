import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../features/auth/useAuth';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { getOrder, getPickupCredential } from '../../features/order/api';
import { ApiError } from '../../lib/api/client';
import { watchPersistence } from '../../test/persistenceGuard';
import {
  completedOrder,
  confirmedOrder,
  pendingOrder,
  pickedUpOrder,
  preparingOrder,
  readyOrder,
} from '../../test/paymentFixtures';
import { CustomerOrderConfirmationPage } from './CustomerOrderConfirmationPage';

/**
 * The customer's pickup experience on the order page: the credential for a
 * READY order (and only then), what the page shows once it has been handed
 * over, that the credential never leaves memory, and the ten-second,
 * visibility-gated refresh that moves a ready order on by itself. The payment
 * flow on the same page is covered in `CustomerOrderConfirmationPage.test.tsx`.
 */

vi.mock('../../features/order/api');
vi.mock('../../features/explore/useExploreMenu');
vi.mock('../../features/auth/useAuth');

const mockedGetOrder = vi.mocked(getOrder);
const mockedGetPickupCredential = vi.mocked(getPickupCredential);
const mockedUseExploreMenu = vi.mocked(useExploreMenu);
const mockedUseAuth = vi.mocked(useAuth);

/** What the backend returns to the order's own customer for a ready order. */
const pickupCredential = { qrPayload: 'ZP1.order-1.AbCdEfGhIjKlMnOpQrStUv', code: 'K7QX-4M2P' };

function renderPage(orderId = 'order-1') {
  return render(
    <MemoryRouter initialEntries={[`/app/orders/${orderId}`]}>
      <Routes>
        <Route path="/app/orders/:orderId" element={<CustomerOrderConfirmationPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function resetMocks() {
  mockedGetOrder.mockReset();
  mockedGetPickupCredential.mockReset();
  mockedGetPickupCredential.mockResolvedValue(pickupCredential);
  mockedUseExploreMenu.mockReset();
  mockedUseExploreMenu.mockReturnValue({ status: 'idle', outlet: null, menu: null, error: null, retry: vi.fn() });
  mockedUseAuth.mockReturnValue({
    user: { userId: 'U-1' },
    status: 'signedIn',
    isAuthenticated: true,
    signOut: vi.fn(async () => {}),
  });
}

describe('CustomerOrderConfirmationPage — pickup', () => {
  beforeEach(resetMocks);

  describe('a ready order', () => {
    it('shows the pickup section: the QR code, the backup code, and an instruction to show them to staff', async () => {
      mockedGetOrder.mockResolvedValue({ order: readyOrder });

      renderPage();

      // The heading is there while the credential loads; the QR code only once it has.
      expect(await screen.findByRole('img', { name: 'Pickup QR code' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Collect your order' })).toBeInTheDocument();
      expect(screen.getByText('K7QX-4M2P')).toBeInTheDocument();
      expect(screen.getByText(/Show the QR code to staff when you collect your order/)).toBeInTheDocument();
      // ...alongside the order's own "ready" status, which is shown exactly once.
      expect(screen.getAllByText('Ready for pickup')).toHaveLength(1);
      expect(screen.getByText('Payment successful. Your order is ready for pickup.')).toBeInTheDocument();
    });

    it("asks the backend for this order's credential, once, and for no other order", async () => {
      mockedGetOrder.mockResolvedValue({ order: readyOrder });

      renderPage('order-1');

      await screen.findByRole('img', { name: 'Pickup QR code' });
      expect(mockedGetPickupCredential.mock.calls).toEqual([['order-1']]);
    });

    it('offers no payment action', async () => {
      mockedGetOrder.mockResolvedValue({ order: readyOrder });

      renderPage();

      await screen.findByRole('img', { name: 'Pickup QR code' });
      expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Payment required')).not.toBeInTheDocument();
    });

    it('does not print the QR payload as text anywhere on the page', async () => {
      mockedGetOrder.mockResolvedValue({ order: readyOrder });

      renderPage();

      await screen.findByRole('img', { name: 'Pickup QR code' });
      expect(document.body.textContent).not.toContain(pickupCredential.qrPayload);
      expect(document.body.textContent).not.toContain('ZP1');
    });

    it('shows a loading state, then the credential', async () => {
      mockedGetOrder.mockResolvedValue({ order: readyOrder });
      mockedGetPickupCredential.mockReturnValue(new Promise(() => {}));

      renderPage();

      expect(await screen.findByText('Loading your pickup code…')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Pickup QR code' })).not.toBeInTheDocument();
    });

    it('shows an error with a retry when the credential cannot be loaded, without breaking the rest of the order', async () => {
      mockedGetOrder.mockResolvedValue({ order: readyOrder });
      mockedGetPickupCredential.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));

      renderPage();

      expect(await screen.findByText("Couldn't load your pickup code")).toBeInTheDocument();
      expect(screen.getByText('Order #order-1')).toBeInTheDocument();
      expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('img', { name: 'Pickup QR code' })).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load your pickup code")).not.toBeInTheDocument();
      expect(mockedGetPickupCredential).toHaveBeenCalledTimes(2);
    });
  });

  describe('states that have no pickup section', () => {
    it.each([
      ['pending_payment', pendingOrder],
      ['confirmed', confirmedOrder],
      ['preparing', preparingOrder],
      ['cancelled', { ...pendingOrder, status: 'cancelled' as const }],
      ['picked_up', pickedUpOrder],
      ['completed', completedOrder],
      ['ready but not paid', { ...readyOrder, paymentStatus: 'pending' as const }],
    ])('a %s order shows no QR, no code and never asks for a credential', async (_label, shown) => {
      mockedGetOrder.mockResolvedValue({ order: shown });

      renderPage();

      await screen.findByText(`Order #${shown.id}`);
      expect(screen.queryByRole('heading', { name: 'Collect your order' })).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Pickup QR code' })).not.toBeInTheDocument();
      expect(screen.queryByText('Pickup code')).not.toBeInTheDocument();
      expect(screen.queryByText('K7QX-4M2P')).not.toBeInTheDocument();
      expect(mockedGetPickupCredential).not.toHaveBeenCalled();
    });
  });

  describe('once the order has been handed over', () => {
    it('shows a picked-up order as picked up, with nothing left to do', async () => {
      mockedGetOrder.mockResolvedValue({ order: pickedUpOrder });

      renderPage();

      await waitFor(() => expect(screen.getByText('Order picked up')).toBeInTheDocument());
      expect(screen.getByText('Picked up')).toBeInTheDocument();
      expect(screen.getByText('Your order has been collected.')).toBeInTheDocument();
      expect(screen.getByText('Paid')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Payment required')).not.toBeInTheDocument();
      expect(screen.queryByText('Pay to confirm your order.')).not.toBeInTheDocument();
    });

    it('shows a completed order as completed, with nothing left to do', async () => {
      mockedGetOrder.mockResolvedValue({ order: completedOrder });

      renderPage();

      await waitFor(() => expect(screen.getByText('Order completed')).toBeInTheDocument());
      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText('Your order is complete.')).toBeInTheDocument();
      expect(screen.getByText('Paid')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
    });
  });

  describe('a status this build does not know', () => {
    it('is shown as words, without crashing and without a pay or pickup action', async () => {
      mockedGetOrder.mockResolvedValue({ order: { ...readyOrder, status: 'out_for_delivery' as never } });

      renderPage();

      expect(await screen.findByText('Out for delivery')).toBeInTheDocument();
      expect(screen.getByText('Order #order-1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Pickup QR code' })).not.toBeInTheDocument();
      expect(mockedGetPickupCredential).not.toHaveBeenCalled();
    });
  });

  describe('the credential stays in memory', () => {
    it('writes nothing to localStorage, sessionStorage, IndexedDB, cookies, history or the URL while showing the credential', async () => {
      const guard = watchPersistence();
      try {
        mockedGetOrder.mockResolvedValue({ order: readyOrder });

        const view = renderPage();
        await screen.findByRole('img', { name: 'Pickup QR code' });

        guard.expectNothingPersisted([pickupCredential.qrPayload, pickupCredential.code, 'K7QX4M2P']);
        view.unmount();
        guard.expectNothingPersisted([pickupCredential.qrPayload, pickupCredential.code, 'K7QX4M2P']);
      } finally {
        guard.restore();
      }
    });

    it('is not on a fresh mount of an order that has since been picked up: nothing is remembered between visits', async () => {
      mockedGetOrder.mockResolvedValue({ order: readyOrder });
      const first = renderPage();
      await screen.findByText('K7QX-4M2P');
      first.unmount();

      mockedGetOrder.mockResolvedValue({ order: pickedUpOrder });
      renderPage();

      await screen.findByText('Your order has been collected.');
      expect(document.body.innerHTML).not.toContain('K7QX');
      expect(document.body.innerHTML).not.toContain(pickupCredential.qrPayload);
    });
  });
});

describe('CustomerOrderConfirmationPage — a ready order moving on by itself', () => {
  const POLL_MS = 10_000;
  let visibility: DocumentVisibilityState = 'visible';

  /** Lets `ms` of fake time pass with the promises the timers start settling as they go. */
  async function pass(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    mockedGetOrder.mockResolvedValue({ order: readyOrder });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderReady() {
    const view = renderPage();
    await pass(0);
    expect(screen.getByRole('img', { name: 'Pickup QR code' })).toBeInTheDocument();
    mockedGetOrder.mockClear();
    return view;
  }

  it('re-reads the order every ten seconds while it is ready, and nothing else changes', async () => {
    await renderReady();

    await pass(POLL_MS);
    await pass(POLL_MS);

    expect(mockedGetOrder).toHaveBeenCalledTimes(2);
    expect(mockedGetOrder).toHaveBeenCalledWith('order-1');
    expect(screen.getByRole('img', { name: 'Pickup QR code' })).toBeInTheDocument();
    // The credential is fetched once, not once per poll.
    expect(mockedGetPickupCredential).toHaveBeenCalledTimes(1);
  });

  it('moves to "Picked up" by itself: the QR and the code disappear, polling stops, and no payment action appears', async () => {
    await renderReady();
    mockedGetOrder.mockResolvedValue({ order: pickedUpOrder });

    await pass(POLL_MS);

    expect(screen.getByText('Your order has been collected.')).toBeInTheDocument();
    expect(screen.getByText('Order picked up')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Pickup QR code' })).not.toBeInTheDocument();
    expect(screen.queryByText('K7QX-4M2P')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Collect your order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('K7QX');

    mockedGetOrder.mockClear();
    await pass(POLL_MS * 10);
    expect(mockedGetOrder).not.toHaveBeenCalled();
  });

  it('moves to "Completed" by itself and stops polling', async () => {
    await renderReady();
    mockedGetOrder.mockResolvedValue({ order: completedOrder });

    await pass(POLL_MS);

    expect(screen.getByText('Your order is complete.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Pickup QR code' })).not.toBeInTheDocument();
    expect(screen.queryByText('K7QX-4M2P')).not.toBeInTheDocument();

    mockedGetOrder.mockClear();
    await pass(POLL_MS * 10);
    expect(mockedGetOrder).not.toHaveBeenCalled();
  });

  it('does not poll while the page is hidden, and re-reads at once when it is shown again', async () => {
    await renderReady();

    act(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(POLL_MS * 6);
    expect(mockedGetOrder).not.toHaveBeenCalled();

    mockedGetOrder.mockResolvedValue({ order: pickedUpOrder });
    await act(async () => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Your order has been collected.')).toBeInTheDocument();
  });

  it('stops polling when the page unmounts, leaving no timer behind', async () => {
    const view = await renderReady();

    view.unmount();
    await pass(POLL_MS * 6);

    expect(mockedGetOrder).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['pending_payment', pendingOrder],
    ['confirmed', confirmedOrder],
    ['preparing', preparingOrder],
    ['picked_up', pickedUpOrder],
    ['completed', completedOrder],
    ['cancelled', { ...pendingOrder, status: 'cancelled' as const }],
  ])('never polls a %s order', async (_label, shown) => {
    mockedGetOrder.mockResolvedValue({ order: shown });
    renderPage();
    await pass(0);
    mockedGetOrder.mockClear();

    await pass(POLL_MS * 6);

    expect(mockedGetOrder).not.toHaveBeenCalled();
  });

  it('keeps showing the ready order and its credential through a failed poll', async () => {
    await renderReady();
    mockedGetOrder.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await pass(POLL_MS);

    expect(screen.getByRole('img', { name: 'Pickup QR code' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await pass(POLL_MS);
    expect(mockedGetOrder).toHaveBeenCalledTimes(2);
  });
});

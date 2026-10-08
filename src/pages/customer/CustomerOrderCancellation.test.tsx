import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../features/auth/useAuth';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { cancelOrder, getOrder } from '../../features/order/api';
import { REFUND_REFRESH_MS } from '../../features/order/useReadyOrderRefresh';
import type { Order } from '../../features/order/types';
import { ApiError } from '../../lib/api/client';
import {
  cancellableConfirmedOrder,
  cancellablePendingOrder,
  cancelledPaidOrder,
  cancelledUnpaidOrder,
  lateConfirmedOrder,
  lockedCompletedOrder,
  lockedPickedUpOrder,
  lockedPreparingOrder,
  lockedReadyOrder,
  refundOf,
} from '../../test/cancellationFixtures';
import { confirmedOrder } from '../../test/paymentFixtures';
import { CustomerOrderConfirmationPage } from './CustomerOrderConfirmationPage';

/**
 * The customer's cancellation and refund experience on the order page: when
 * Cancel is on offer (only when the server says so), the confirmation dialog,
 * what the page shows after a cancellation, how each refund state reads, and how
 * a refusal or an outage is handled. The payment and pickup flows on the same
 * page have their own files.
 */

vi.mock('../../features/order/api');
vi.mock('../../features/explore/useExploreMenu');
vi.mock('../../features/auth/useAuth');

const mockedGetOrder = vi.mocked(getOrder);
const mockedCancelOrder = vi.mocked(cancelOrder);
const mockedUseExploreMenu = vi.mocked(useExploreMenu);
const mockedUseAuth = vi.mocked(useAuth);

function renderPage(orderId = 'order-1') {
  return render(
    <MemoryRouter initialEntries={[`/app/orders/${orderId}`]}>
      <Routes>
        <Route path="/app/orders/:orderId" element={<CustomerOrderConfirmationPage />} />
        <Route path="/contact" element={<div>Contact page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetMocks() {
  mockedGetOrder.mockReset();
  mockedCancelOrder.mockReset();
  mockedUseExploreMenu.mockReset();
  mockedUseExploreMenu.mockReturnValue({ status: 'idle', outlet: null, menu: null, error: null, retry: vi.fn() });
  mockedUseAuth.mockReturnValue({
    user: { userId: 'U-1' },
    status: 'signedIn',
    isAuthenticated: true,
    signOut: vi.fn(async () => {}),
  });
}

async function showOrder(order: Order) {
  mockedGetOrder.mockResolvedValue({ order });
  const view = renderPage();
  await screen.findByText(`Order #${order.id}`);
  return view;
}

async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
  return screen.findByRole('dialog');
}

function confirmCancellation() {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Yes, cancel order|Try again/ }));
}

describe('CustomerOrderConfirmationPage — cancellation', () => {
  beforeEach(resetMocks);

  describe('when Cancel is offered: only as the server says', () => {
    it.each([
      ['pending_payment', cancellablePendingOrder],
      ['confirmed, before the ordering deadline', cancellableConfirmedOrder],
    ])('offers Cancel for a %s order', async (_name, order) => {
      await showOrder(order);

      expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
    });

    it('offers no Cancel for a confirmed order after the deadline, and says why', async () => {
      await showOrder(lateConfirmedOrder);

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
      expect(screen.getByText('The cancellation window for this order has closed.')).toBeInTheDocument();
    });

    it('offers no Cancel while preparing, and explains that preparation has started', async () => {
      await showOrder(lockedPreparingOrder);

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
      expect(
        screen.getByText('Preparation has already started, so this order can no longer be cancelled.'),
      ).toBeInTheDocument();
    });

    it('offers no Cancel once ready, and explains', async () => {
      mockedGetOrder.mockResolvedValue({ order: lockedReadyOrder });
      mockedUseExploreMenu.mockReturnValue({ status: 'idle', outlet: null, menu: null, error: null, retry: vi.fn() });
      renderPage();
      await screen.findByText('Order #order-1');

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
      expect(screen.getByText('This order is ready for pickup, so it can no longer be cancelled.')).toBeInTheDocument();
    });

    it.each([
      ['picked up', lockedPickedUpOrder],
      ['completed', lockedCompletedOrder],
    ])('shows no cancellation action or explanation for a %s order', async (_name, order) => {
      await showOrder(order);

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
      expect(screen.queryByText(/can no longer be cancelled|cancellation window/)).not.toBeInTheDocument();
    });

    it('offers no Cancel when the server gave no hint at all — it never guesses from the status', async () => {
      await showOrder(confirmedOrder);

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    });

    it('offers no Cancel when the server says it can\'t, whatever the status looks like', async () => {
      await showOrder({ ...cancellableConfirmedOrder, cancellation: { state: 'not_cancellable', canCancel: false } });

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    });

    it('never offers Cancel on a collected order even if a (contradictory) hint says it can', async () => {
      await showOrder({ ...lockedPickedUpOrder, cancellation: { state: 'cancellable', canCancel: true } });

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    });

    it('offers no Cancel on an already-cancelled order', async () => {
      await showOrder(cancelledPaidOrder());

      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    });
  });

  describe('the confirmation dialog', () => {
    it('opens a modal dialog, with the safe choice focused, and sends nothing yet', async () => {
      await showOrder(cancellableConfirmedOrder);

      const dialog = await openDialog();

      expect(dialog).toHaveAccessibleName('Cancel this order?');
      expect(within(dialog).getByRole('button', { name: 'Keep order' })).toHaveFocus();
      expect(mockedCancelOrder).not.toHaveBeenCalled();
    });

    it('tells a customer who paid that a full refund goes back to their original payment method, in the background', async () => {
      await showOrder(cancellableConfirmedOrder);

      const dialog = await openDialog();

      expect(dialog).toHaveTextContent('full refund of ₹300 to your original payment method');
      expect(dialog).toHaveTextContent('processed in the background');
    });

    it('tells a customer who has not paid there is nothing to refund', async () => {
      await showOrder(cancellablePendingOrder);

      const dialog = await openDialog();

      expect(dialog).toHaveTextContent("This order hasn't been paid for, so there's nothing to refund.");
      expect(dialog).not.toHaveTextContent('full refund');
    });

    it('"Keep order" closes it without cancelling, and the order is untouched', async () => {
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockedCancelOrder).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
    });

    it('Escape closes it without cancelling', async () => {
      await showOrder(cancellableConfirmedOrder);
      const dialog = await openDialog();

      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockedCancelOrder).not.toHaveBeenCalled();
    });

    it('the reason is optional: cancels with none', async () => {
      mockedCancelOrder.mockResolvedValue({ order: cancelledPaidOrder() });
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();

      await waitFor(() => expect(mockedCancelOrder).toHaveBeenCalledTimes(1));
      expect(mockedCancelOrder).toHaveBeenCalledWith('order-1', undefined);
    });

    it('sends the chosen reason, and nothing else', async () => {
      mockedCancelOrder.mockResolvedValue({ order: cancelledPaidOrder() });
      await showOrder(cancellableConfirmedOrder);
      const dialog = await openDialog();

      fireEvent.change(within(dialog).getByRole('combobox', { name: /Reason/ }), {
        target: { value: 'changed_my_mind' },
      });
      confirmCancellation();

      await waitFor(() => expect(mockedCancelOrder).toHaveBeenCalledTimes(1));
      // The order and the reason: no amount, status, deadline, user or provider detail has anywhere to go.
      expect(mockedCancelOrder.mock.calls[0]).toEqual(['order-1', 'changed_my_mind']);
    });
  });

  describe('a successful cancellation', () => {
    it('a paid order: shows Cancelled, the initiated refund, and no way to cancel again', async () => {
      mockedCancelOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('requested')) });
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();

      expect(await screen.findByRole('heading', { name: 'Order cancelled' })).toBeInTheDocument();
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
      expect(screen.getByText('Your order was cancelled. Your refund has been initiated.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Refund initiated' })).toBeInTheDocument();
      expect(screen.getByText(/Your refund of ₹300 is being processed/)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    });

    it('an unpaid order: shows Cancelled and NO refund of any kind', async () => {
      mockedCancelOrder.mockResolvedValue({ order: cancelledUnpaidOrder });
      await showOrder(cancellablePendingOrder);
      await openDialog();

      confirmCancellation();

      expect(await screen.findByRole('heading', { name: 'Order cancelled' })).toBeInTheDocument();
      expect(screen.getByText('Your order was cancelled.')).toBeInTheDocument();
      expect(screen.queryByText(/refund/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      // And no way to pay for it.
      expect(screen.queryByRole('button', { name: /^Pay/ })).not.toBeInTheDocument();
    });

    it('updates from the cancel response without re-reading the order or reloading', async () => {
      mockedCancelOrder.mockResolvedValue({ order: cancelledPaidOrder() });
      await showOrder(cancellableConfirmedOrder);
      mockedGetOrder.mockClear();
      await openDialog();

      confirmCancellation();

      await screen.findByRole('heading', { name: 'Order cancelled' });
      expect(mockedGetOrder).not.toHaveBeenCalled();
      // The page is still the same order page: navigation context is kept.
      expect(screen.getByText('Order #order-1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue browsing' })).toBeInTheDocument();
    });

    it('shows the items and total the order was placed with', async () => {
      mockedCancelOrder.mockResolvedValue({ order: cancelledPaidOrder() });
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();

      await screen.findByRole('heading', { name: 'Order cancelled' });
      expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
      expect(screen.getByText('₹300 INR')).toBeInTheDocument();
    });
  });

  describe('duplicate click protection', () => {
    it('sends one request however many times Confirm is pressed while it is in flight', async () => {
      const pending = deferred<{ order: Order }>();
      mockedCancelOrder.mockReturnValue(pending.promise);
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();
      const busy = await screen.findByRole('button', { name: 'Cancelling…' });
      fireEvent.click(busy);
      fireEvent.click(busy);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
      // It cannot be dismissed mid-request either.
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await act(async () => {
        pending.resolve({ order: cancelledPaidOrder() });
      });
      expect(await screen.findByRole('heading', { name: 'Order cancelled' })).toBeInTheDocument();
      expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the server refuses (409)', () => {
    it('re-reads the order, closes the dialog and explains that preparation has started', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'This order is already being prepared.'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();
      mockedGetOrder.mockResolvedValue({ order: { ...lockedPreparingOrder, updatedAt: '2026-09-30T08:21:00+05:30' } });

      confirmCancellation();

      expect(
        await screen.findByText('Preparation has already started, so this order can no longer be cancelled.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
      expect(screen.getByText('Preparing')).toBeInTheDocument();
      // Said once, not once as the refusal and again as the explanation.
      expect(screen.getAllByText('Preparation has already started, so this order can no longer be cancelled.')).toHaveLength(1);
      expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
    });

    it('says the window has closed when the deadline passed while the dialog was open', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'Ordering has closed'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();
      mockedGetOrder.mockResolvedValue({ order: { ...lateConfirmedOrder, updatedAt: '2026-09-30T08:21:00+05:30' } });

      confirmCancellation();

      expect(await screen.findByText('The cancellation window for this order has closed.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    });

    it('never shows the backend\'s wording or code', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'payment_state_inconsistent'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();
      mockedGetOrder.mockRejectedValue(new ApiError(503, 'unavailable', 'x'));

      confirmCancellation();

      expect(await screen.findByText('This order can no longer be cancelled.')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('payment_state_inconsistent');
      expect(document.body.textContent).not.toContain('conflict');
    });

    it('shows the cancelled order, not an error, if it turns out to be cancelled already', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'x'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();
      mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder() });

      confirmCancellation();

      expect(await screen.findByRole('heading', { name: 'Order cancelled' })).toBeInTheDocument();
      expect(screen.queryByText(/can no longer be cancelled/)).not.toBeInTheDocument();
    });
  });

  describe('when the request fails in a way worth retrying', () => {
    it('503: keeps the dialog open with a retryable error, and does not retry by itself', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(503, 'unavailable', 'x'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();

      const dialog = screen.getByRole('dialog');
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Zesto is temporarily unavailable. Please try again in a moment.',
      );
      expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
    });

    it('then succeeds when the customer presses Try again — one more request, by their choice', async () => {
      mockedCancelOrder.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'));
      mockedCancelOrder.mockResolvedValueOnce({ order: cancelledPaidOrder() });
      await showOrder(cancellableConfirmedOrder);
      await openDialog();
      confirmCancellation();
      await screen.findByRole('button', { name: 'Try again' });

      confirmCancellation();

      expect(await screen.findByRole('heading', { name: 'Order cancelled' })).toBeInTheDocument();
      expect(mockedCancelOrder).toHaveBeenCalledTimes(2);
    });

    it('a network failure says so, in plain words', async () => {
      mockedCancelOrder.mockRejectedValue(new TypeError('Failed to fetch'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't cancel your order. Please check your connection and try again.",
      );
    });

    it('404: reports the order as unavailable', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(404, 'not_found', 'Order not found.'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();

      expect(await screen.findByRole('alert')).toHaveTextContent('Order not found.');
    });

    it('401: says the session has expired', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(401, 'unauthenticated', 'x'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();

      confirmCancellation();

      expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired. Please sign in again.');
    });

    it('closing the dialog after a failure leaves the order as it was, with Cancel still on offer', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(503, 'unavailable', 'x'));
      await showOrder(cancellableConfirmedOrder);
      await openDialog();
      confirmCancellation();
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
    });
  });
});

describe('CustomerOrderConfirmationPage — the refund', () => {
  beforeEach(resetMocks);

  it.each([
    ['requested', 'Refund initiated'],
    ['pending', 'Refund initiated'],
    ['processed', 'Refund processed'],
    ['failed', 'Refund not completed'],
  ] as const)('a %s refund reads "%s"', async (status, heading) => {
    await showOrder(cancelledPaidOrder(refundOf(status)));

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('a failed refund is calm: the approved sentence, a support link, no retry button', async () => {
    await showOrder(cancelledPaidOrder(refundOf('failed')));

    expect(
      screen.getByText("We couldn't complete your refund automatically. We've been notified."),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry|try again|refund/i })).not.toBeInTheDocument();
  });

  it('a processed refund is not described as "initiated" in the order card', async () => {
    await showOrder(cancelledPaidOrder(refundOf('processed')));

    expect(screen.getByText('Your order was cancelled.')).toBeInTheDocument();
    expect(screen.queryByText(/refund has been initiated/)).not.toBeInTheDocument();
  });

  it('a missing refund summary on a cancelled paid order is handled without inventing a state', async () => {
    await showOrder(cancelledPaidOrder(null));

    expect(screen.getByRole('heading', { name: 'Refund being arranged' })).toBeInTheDocument();
    expect(screen.getByText('Your order was cancelled.')).toBeInTheDocument();
    expect(screen.queryByText(/initiated|processed/i)).not.toBeInTheDocument();
  });

  it('an order cancelled before payment has no refund card', async () => {
    await showOrder(cancelledUnpaidOrder);

    expect(screen.queryByRole('heading', { name: /refund/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/refund/i)).not.toBeInTheDocument();
  });

  it('never shows an identifier, a provider name or an internal status', async () => {
    await showOrder({
      ...cancelledPaidOrder(refundOf('pending')),
      refund: { ...refundOf('pending'), providerRefundId: 'rfnd_secret', refundId: 'order-1-r1' },
    } as Order);

    const text = document.body.textContent ?? '';
    for (const leaked of ['rfnd_secret', 'order-1-r1', 'razorpay', 'requested']) {
      expect(text.toLowerCase()).not.toContain(leaked);
    }
  });
});

describe('CustomerOrderConfirmationPage — cancelled but paid', () => {
  beforeEach(resetMocks);

  // The backend lets a valid capture arrive after a cancellation (and refunds it).
  it('is a cancelled order, never a confirmed one, even though the payment is paid', async () => {
    await showOrder(cancelledPaidOrder(refundOf('requested')));

    expect(screen.getByRole('heading', { name: 'Order cancelled' })).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Order confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText(/Payment successful/)).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
    // The payment itself is still reported truthfully, beside the refund.
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Refund initiated' })).toBeInTheDocument();
  });

  it('offers neither a payment nor a cancellation, nor a pickup code', async () => {
    await showOrder(cancelledPaidOrder(refundOf('requested')));

    expect(screen.queryByRole('button', { name: /^Pay/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Collect your order' })).not.toBeInTheDocument();
  });
});

describe('CustomerOrderConfirmationPage — a refund settling while the page is open', () => {
  let visibility: DocumentVisibilityState = 'visible';

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('moves from initiated to processed by itself, then stops asking', async () => {
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('requested')) });
    renderPage();
    await pass(0);
    expect(screen.getByRole('heading', { name: 'Refund initiated' })).toBeInTheDocument();
    mockedGetOrder.mockClear();
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('processed')) });

    await pass(REFUND_REFRESH_MS);

    expect(screen.getByRole('heading', { name: 'Refund processed' })).toBeInTheDocument();
    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    await pass(REFUND_REFRESH_MS * 10);
    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
  });

  it('moves to the failed state when the refund fails', async () => {
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('pending')) });
    renderPage();
    await pass(0);
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('failed')) });

    await pass(REFUND_REFRESH_MS);

    expect(screen.getByRole('heading', { name: 'Refund not completed' })).toBeInTheDocument();
  });

  it('does not poll at all for an order cancelled before payment', async () => {
    mockedGetOrder.mockResolvedValue({ order: cancelledUnpaidOrder });
    renderPage();
    await pass(0);
    mockedGetOrder.mockClear();

    await pass(REFUND_REFRESH_MS * 10);

    expect(mockedGetOrder).not.toHaveBeenCalled();
  });

  it('keeps polling after the customer cancels in this very page, until the refund settles', async () => {
    mockedGetOrder.mockResolvedValue({ order: cancellableConfirmedOrder });
    mockedCancelOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('requested')) });
    renderPage();
    await pass(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, cancel order' }));
    await pass(0);
    expect(screen.getByRole('heading', { name: 'Refund initiated' })).toBeInTheDocument();
    mockedGetOrder.mockClear();
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('processed')) });

    await pass(REFUND_REFRESH_MS);

    expect(screen.getByRole('heading', { name: 'Refund processed' })).toBeInTheDocument();
  });
});

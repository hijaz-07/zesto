import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { AuthContextValue } from '../../features/auth/types';
import { useAuth } from '../../features/auth/useAuth';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { getOrder } from '../../features/order/api';
import { preparePayment, verifyPayment } from '../../features/payment/api';
import { loadRazorpayCheckout, RazorpayScriptError } from '../../features/payment/razorpayScript';
import {
  checkoutCallback,
  confirmedOrder,
  FakeRazorpay,
  pendingOrder,
  preparedPayment,
  succeededPayment,
} from '../../test/paymentFixtures';
import { CustomerOrderConfirmationPage } from './CustomerOrderConfirmationPage';

vi.mock('../../features/order/api');
vi.mock('../../features/explore/useExploreMenu');
vi.mock('../../features/auth/useAuth');
vi.mock('../../features/payment/api', async (importOriginal) => ({
  // Keep the real `isPaymentConfirmed`: the page's trust decision depends on it.
  ...(await importOriginal<typeof import('../../features/payment/api')>()),
  preparePayment: vi.fn(),
  verifyPayment: vi.fn(),
}));
vi.mock('../../features/payment/razorpayScript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/payment/razorpayScript')>()),
  loadRazorpayCheckout: vi.fn(),
}));

const mockedGetOrder = vi.mocked(getOrder);
const mockedUseExploreMenu = vi.mocked(useExploreMenu);
const mockedUseAuth = vi.mocked(useAuth);
const mockedPreparePayment = vi.mocked(preparePayment);
const mockedVerifyPayment = vi.mocked(verifyPayment);
const mockedLoadRazorpayCheckout = vi.mocked(loadRazorpayCheckout);

const order = pendingOrder;

function signedInAs(user: AuthContextValue['user']): AuthContextValue {
  return { user, status: 'signedIn', isAuthenticated: true, signOut: vi.fn(async () => {}) };
}

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

function resetMocks() {
  FakeRazorpay.reset();
  mockedGetOrder.mockReset();
  mockedUseExploreMenu.mockReset();
  mockedUseExploreMenu.mockReturnValue({
    status: 'idle',
    outlet: null,
    menu: null,
    error: null,
    retry: vi.fn(),
  });
  mockedPreparePayment.mockReset();
  mockedVerifyPayment.mockReset();
  mockedLoadRazorpayCheckout.mockReset();
  mockedUseAuth.mockReturnValue(signedInAs({ userId: 'U-1' }));
  mockedLoadRazorpayCheckout.mockResolvedValue(FakeRazorpay);
  mockedPreparePayment.mockResolvedValue({ payment: preparedPayment });
  mockedVerifyPayment.mockResolvedValue({ order: confirmedOrder, payment: succeededPayment });
}

describe('CustomerOrderConfirmationPage', () => {
  beforeEach(resetMocks);

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

  // Supersedes the earlier "payment will be added next" placeholder test: payment
  // now exists, so a pending order shows a Pay action — but it must still never
  // imply the order is paid or confirmed before the server says so.
  it('before payment, shows "Payment required" and a Pay button, never implying the order is paid or confirmed', async () => {
    mockedGetOrder.mockResolvedValue({ order });

    renderPage();

    await waitFor(() => expect(screen.getByText('Payment required')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Pay ₹300' })).toBeEnabled();
    expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^paid$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pickup|collect|qr/i)).not.toBeInTheDocument();
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

async function renderPendingOrder() {
  mockedGetOrder.mockResolvedValue({ order });
  const view = renderPage();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pay ₹300' })).toBeInTheDocument());
  return view;
}

function clickPay() {
  fireEvent.click(screen.getByRole('button', { name: 'Pay ₹300' }));
}

async function openCheckout() {
  clickPay();
  await waitFor(() => expect(FakeRazorpay.instances).toHaveLength(1));
}

describe('CustomerOrderConfirmationPage — payment', () => {
  beforeEach(resetMocks);

  it('prepares the payment with only the order ID, then opens Checkout with the backend values — not the displayed total', async () => {
    // A backend amount deliberately different from what the page displays.
    mockedPreparePayment.mockResolvedValue({ payment: { ...preparedPayment, amountInPaise: 31000 } });
    await renderPendingOrder();

    await openCheckout();

    expect(mockedPreparePayment).toHaveBeenCalledTimes(1);
    expect(mockedPreparePayment).toHaveBeenCalledWith('order-1');
    expect(FakeRazorpay.last.options).toMatchObject({
      key: 'rzp_test_FakePublicKeyId',
      amount: 31000,
      currency: 'INR',
      order_id: 'order_FakeProviderOrder1',
      name: 'Zesto',
      description: 'Pre-order · 3 items',
    });
    expect(FakeRazorpay.last.open).toHaveBeenCalledTimes(1);
  });

  it("prefills Checkout with the signed-in customer's existing, customer-safe details", async () => {
    mockedUseAuth.mockReturnValue(
      signedInAs({ userId: 'U-1', name: 'Asha Nair', email: 'asha@example.com', phone: '+911234567890' }),
    );
    await renderPendingOrder();

    await openCheckout();

    expect(FakeRazorpay.last.options.prefill).toEqual({
      name: 'Asha Nair',
      email: 'asha@example.com',
      contact: '+911234567890',
    });
  });

  it('does not depend on optional profile data: a user with no name, email, or phone can still pay', async () => {
    mockedUseAuth.mockReturnValue(signedInAs({ userId: 'U-1' }));
    await renderPendingOrder();

    await openCheckout();

    expect(FakeRazorpay.last.options).not.toHaveProperty('prefill');
  });

  it('disables the action while the payment is being prepared, and ignores repeated clicks', async () => {
    mockedPreparePayment.mockReturnValue(new Promise(() => {}));
    await renderPendingOrder();

    clickPay();

    const busyButton = await screen.findByRole('button', { name: 'Preparing payment…' });
    expect(busyButton).toBeDisabled();
    fireEvent.click(busyButton);
    fireEvent.click(busyButton);
    expect(mockedPreparePayment).toHaveBeenCalledTimes(1);
  });

  it('keeps the action disabled while Checkout is open', async () => {
    await renderPendingOrder();

    await openCheckout();

    expect(await screen.findByRole('button', { name: 'Waiting for payment…' })).toBeDisabled();
  });

  it('on Checkout success, sends only the three callback values for verification, then shows the confirmed order from the server', async () => {
    await renderPendingOrder();
    await openCheckout();

    act(() => FakeRazorpay.last.succeed());

    await waitFor(() => expect(screen.getByText('Order confirmed')).toBeInTheDocument());
    expect(mockedVerifyPayment).toHaveBeenCalledTimes(1);
    expect(mockedVerifyPayment).toHaveBeenCalledWith('order-1', checkoutCallback);
    expect(screen.getByText('Payment successful. Your order is confirmed.')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    // The server's order: id, item snapshots, quantities, subtotal, total, currency.
    expect(screen.getByText('Order #order-1')).toBeInTheDocument();
    expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
    expect(screen.getByText('Qty 2 · ₹120 each')).toBeInTheDocument();
    expect(screen.getByText('Veg Meals')).toBeInTheDocument();
    expect(screen.getByText('₹300')).toBeInTheDocument();
    expect(screen.getByText('₹300 INR')).toBeInTheDocument();
  });

  it('renders the totals from the server verification response, not from the previously loaded order', async () => {
    mockedVerifyPayment.mockResolvedValue({
      order: {
        ...confirmedOrder,
        items: [{ itemId: 'item-9', name: 'Server Item', priceInPaise: 5000, quantity: 1, lineTotalInPaise: 5000 }],
        subtotalInPaise: 5000,
        totalInPaise: 5000,
      },
      payment: succeededPayment,
    });
    await renderPendingOrder();
    await openCheckout();

    act(() => FakeRazorpay.last.succeed());

    await waitFor(() => expect(screen.getByText('Server Item')).toBeInTheDocument());
    expect(screen.getByText('₹50 INR')).toBeInTheDocument();
    expect(screen.queryByText('Chicken Biriyani')).not.toBeInTheDocument();
  });

  it('hides the Pay action and shows no payment error once the order is confirmed', async () => {
    await renderPendingOrder();
    await openCheckout();

    act(() => FakeRazorpay.last.succeed());

    await waitFor(() => expect(screen.getByText('Order confirmed')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Payment required')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("is not confirmed merely because Checkout's browser callback fired: it waits for the server", async () => {
    mockedVerifyPayment.mockReturnValue(new Promise(() => {}));
    await renderPendingOrder();
    await openCheckout();

    act(() => FakeRazorpay.last.succeed());

    expect(await screen.findByRole('button', { name: 'Verifying payment…' })).toBeDisabled();
    expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(screen.getByText('Payment required')).toBeInTheDocument();
  });

  it('does not show success when the server verification is rejected', async () => {
    mockedVerifyPayment.mockRejectedValue(
      new ApiError(400, 'invalid_argument', 'The payment signature could not be verified.'),
    );
    await renderPendingOrder();
    await openCheckout();

    act(() => FakeRazorpay.last.succeed());

    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't verify it yet");
    expect(screen.getByRole('alert')).toHaveTextContent('The payment signature could not be verified.');
    expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(screen.getByText('Payment required')).toBeInTheDocument();
  });

  it('does not show success when the server answers but does not confirm the payment', async () => {
    mockedVerifyPayment.mockResolvedValue({
      order,
      payment: { ...succeededPayment, status: 'pending' },
    });
    await renderPendingOrder();
    await openCheckout();

    act(() => FakeRazorpay.last.succeed());

    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't verify it yet");
    expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });

  describe('when Checkout succeeds but the verification endpoint cannot be reached', () => {
    async function reachVerifyFailure() {
      mockedVerifyPayment.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await renderPendingOrder();
      await openCheckout();
      act(() => FakeRazorpay.last.succeed());
      await screen.findByText("Payment received by checkout. We couldn't verify it yet.");
    }

    it('shows a clear not-yet-verified state, never "confirmed"', async () => {
      await reachVerifyFailure();

      expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Paid')).not.toBeInTheDocument();
      expect(screen.getByText('Payment required')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry verification' })).toBeEnabled();
    });

    it('offers no way to start a second payment', async () => {
      await reachVerifyFailure();

      expect(screen.queryByRole('button', { name: 'Pay ₹300' })).not.toBeInTheDocument();
    });

    it('retrying re-verifies the same payment and then confirms, without creating another order or payment', async () => {
      await reachVerifyFailure();

      fireEvent.click(screen.getByRole('button', { name: 'Retry verification' }));

      await waitFor(() => expect(screen.getByText('Order confirmed')).toBeInTheDocument());
      expect(mockedVerifyPayment).toHaveBeenCalledTimes(2);
      expect(mockedVerifyPayment).toHaveBeenLastCalledWith('order-1', checkoutCallback);
      expect(mockedPreparePayment).toHaveBeenCalledTimes(1);
      expect(FakeRazorpay.instances).toHaveLength(1);
    });
  });

  describe('when the customer closes Checkout', () => {
    it('keeps the order pending, shows a non-success message, and re-enables Pay', async () => {
      await renderPendingOrder();
      await openCheckout();

      act(() => FakeRazorpay.last.dismiss());

      expect(await screen.findByText('Payment not completed')).toBeInTheDocument();
      expect(screen.getByText('Payment required')).toBeInTheDocument();
      expect(screen.getByText('Payment pending')).toBeInTheDocument();
      expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();
      expect(mockedVerifyPayment).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Pay ₹300' })).toBeEnabled();
    });

    it('allows a retry that opens Checkout again for the same order', async () => {
      await renderPendingOrder();
      await openCheckout();
      act(() => FakeRazorpay.last.dismiss());
      await screen.findByText('Payment not completed');

      clickPay();

      await waitFor(() => expect(FakeRazorpay.instances).toHaveLength(2));
      expect(mockedPreparePayment).toHaveBeenCalledTimes(2);
      expect(mockedPreparePayment).toHaveBeenLastCalledWith('order-1');
      expect(screen.queryByText('Payment not completed')).not.toBeInTheDocument();
    });
  });

  it('on a Checkout-reported failure, shows a non-success message, confirms nothing, and allows a retry', async () => {
    await renderPendingOrder();
    await openCheckout();

    act(() => {
      FakeRazorpay.last.fail('Your payment was declined by the bank.');
      FakeRazorpay.last.dismiss();
    });

    expect(await screen.findByText("Payment didn't go through")).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Your payment was declined by the bank.');
    expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();
    expect(mockedVerifyPayment).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pay ₹300' })).toBeEnabled();
  });

  it('on a preparation failure, preserves the pending order, shows the error, and allows a retry', async () => {
    mockedPreparePayment.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'provider down'));
    await renderPendingOrder();

    clickPay();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't start your payment");
    expect(screen.getByRole('alert')).toHaveTextContent('Payments are temporarily unavailable.');
    expect(screen.getByText('Payment required')).toBeInTheDocument();
    expect(FakeRazorpay.instances).toHaveLength(0);

    clickPay();

    await waitFor(() => expect(FakeRazorpay.instances).toHaveLength(1));
    expect(mockedPreparePayment).toHaveBeenCalledTimes(2);
  });

  it('when the Checkout script cannot load, does not crash, keeps the order pending, and allows a retry', async () => {
    mockedLoadRazorpayCheckout.mockRejectedValueOnce(new RazorpayScriptError('load_failed', 'blocked'));
    await renderPendingOrder();

    clickPay();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't open the payment window");
    expect(screen.getByText('Order #order-1')).toBeInTheDocument();
    expect(screen.getByText('Payment required')).toBeInTheDocument();
    expect(screen.queryByText(/order confirmed/i)).not.toBeInTheDocument();

    clickPay();

    await waitFor(() => expect(FakeRazorpay.instances).toHaveLength(1));
  });

  it('shows no Pay action for an already confirmed, paid order', async () => {
    mockedGetOrder.mockResolvedValue({ order: confirmedOrder });

    renderPage();

    await waitFor(() => expect(screen.getByText('Order confirmed')).toBeInTheDocument());
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
    expect(mockedPreparePayment).not.toHaveBeenCalled();
  });

  it('stays confirmed after a refresh, because it re-reads the confirmed order from the backend', async () => {
    const first = await renderPendingOrder();
    await openCheckout();
    act(() => FakeRazorpay.last.succeed());
    await waitFor(() => expect(screen.getByText('Order confirmed')).toBeInTheDocument());

    // Simulate a hard refresh: the page is gone, and loads afresh from the backend.
    first.unmount();
    mockedGetOrder.mockResolvedValue({ order: confirmedOrder });
    renderPage();

    await waitFor(() => expect(screen.getByText('Order confirmed')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
  });

  it('shows no Pay action for a cancelled order', async () => {
    mockedGetOrder.mockResolvedValue({ order: { ...order, status: 'cancelled' } });

    renderPage();

    await waitFor(() => expect(screen.getByText('Cancelled')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Payment required')).not.toBeInTheDocument();
  });

  it('never renders anything secret-shaped in any payment state', async () => {
    await renderPendingOrder();
    await openCheckout();
    act(() => FakeRazorpay.last.succeed());
    await waitFor(() => expect(screen.getByText('Order confirmed')).toBeInTheDocument());

    const text = document.body.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('secret');
    expect(text).not.toContain('rzp_');
    expect(text).not.toContain('signature');
  });
});

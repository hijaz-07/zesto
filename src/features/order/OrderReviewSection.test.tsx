import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Cart } from '../cart/types';
import { OrderReviewSection } from './OrderReviewSection';
import type { CartStalenessResult } from './staleness';

const cart: Cart = {
  context: { outletId: 'outlet-1', menuId: 'menu-1' },
  lines: [
    { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 2 },
    { itemId: 'item-2', name: 'Veg Meals', priceInPaise: 8000, quantity: 1 },
  ],
};

const clean: CartStalenessResult = { ready: true, issues: [] };

function renderSection(overrides: Partial<React.ComponentProps<typeof OrderReviewSection>> = {}) {
  const onBack = vi.fn();
  const onPlaceOrder = vi.fn();
  render(
    <OrderReviewSection
      outletName="Main Canteen"
      menuTitle="Tuesday Special Menu"
      cart={cart}
      staleness={clean}
      submitting={false}
      submitError={null}
      onBack={onBack}
      onPlaceOrder={onPlaceOrder}
      {...overrides}
    />,
  );
  return { onBack, onPlaceOrder };
}

describe('OrderReviewSection', () => {
  it('shows the outlet, menu, cart lines with quantity/price, and subtotal', () => {
    renderSection();

    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
    expect(screen.getByText('Tuesday Special Menu')).toBeInTheDocument();
    expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
    expect(screen.getByText('Qty 2 · ₹120 each')).toBeInTheDocument();
    expect(screen.getByText('₹240')).toBeInTheDocument();
    expect(screen.getByText('Veg Meals')).toBeInTheDocument();
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('₹320')).toBeInTheDocument();
  });

  it('enables Place Order when there are no staleness issues', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'Place Order' })).toBeEnabled();
  });

  it('shows a stale-item warning and disables Place Order', () => {
    renderSection({
      staleness: {
        ready: true,
        issues: [{ type: 'item_unavailable', itemId: 'item-1', name: 'Chicken Biriyani' }],
      },
    });

    expect(screen.getByText('Chicken Biriyani is no longer available on this menu.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
  });

  it('shows a price-change warning and disables Place Order', () => {
    renderSection({
      staleness: {
        ready: true,
        issues: [
          {
            type: 'price_changed',
            itemId: 'item-1',
            name: 'Chicken Biriyani',
            oldPriceInPaise: 12000,
            newPriceInPaise: 13000,
          },
        ],
      },
    });

    expect(screen.getByText('Chicken Biriyani price changed to ₹130 (was ₹120 in your cart).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
  });

  it('shows an ordering-closed warning and disables Place Order', () => {
    renderSection({ staleness: { ready: true, issues: [{ type: 'ordering_closed' }] } });

    expect(screen.getByText('Ordering has closed for this menu.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
  });

  it('shows an ordering-not-open warning and disables Place Order', () => {
    renderSection({ staleness: { ready: true, issues: [{ type: 'ordering_not_open' }] } });

    expect(screen.getByText('Ordering has not opened yet for this menu.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
  });

  it('shows a menu-unavailable warning and disables Place Order', () => {
    renderSection({ staleness: { ready: true, issues: [{ type: 'menu_unavailable' }] } });

    expect(screen.getByText('This menu is no longer available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
  });

  it('disables Place Order while the live menu is still being checked, with no issues yet reported', () => {
    renderSection({ staleness: { ready: false, issues: [] } });

    expect(screen.getByText('Checking the latest menu…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place Order' })).toBeDisabled();
  });

  it('disables both buttons while submitting, and relabels Place Order', () => {
    renderSection({ submitting: true });

    expect(screen.getByRole('button', { name: 'Placing order…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to Cart' })).toBeDisabled();
  });

  it('shows a submit error message', () => {
    renderSection({ submitError: 'Ordering has closed for this menu.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Ordering has closed for this menu.');
  });

  it('calls onPlaceOrder / onBack when their buttons are clicked', () => {
    const { onBack, onPlaceOrder } = renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Place Order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Cart' }));

    expect(onPlaceOrder).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('never labels the submit button Pay Now, Paid, Confirm Payment, or Checkout', () => {
    renderSection();

    expect(screen.queryByRole('button', { name: /pay now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^paid$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm payment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /checkout/i })).not.toBeInTheDocument();
    expect(screen.getByText(/payment isn't collected yet/i)).toBeInTheDocument();
  });
});

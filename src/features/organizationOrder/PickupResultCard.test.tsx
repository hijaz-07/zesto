import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { completedOrgOrder, longOrgOrder, pickedUpOrgOrder } from '../../test/organizationOrderFixtures';
import { PickupResultCard } from './PickupResultCard';
import type { OrganizationOrderSummary } from './types';
import type { PickupResult } from './usePickupRedeem';

function result(overrides: Partial<PickupResult> = {}): PickupResult {
  return { order: pickedUpOrgOrder, completing: false, completionError: null, ...overrides };
}

function renderCard(shown: PickupResult = result()) {
  const onComplete = vi.fn();
  const onDone = vi.fn();
  const view = render(<PickupResultCard result={shown} onComplete={onComplete} onDone={onDone} />);
  return { ...view, onComplete, onDone };
}

describe('PickupResultCard', () => {
  describe('after a pickup', () => {
    it('says the pickup is recorded and the order is to be handed over now', () => {
      renderCard();

      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.getByText('Picked up')).toBeInTheDocument();
      expect(screen.getByText('Pickup recorded. Hand the order over now.')).toBeInTheDocument();
    });

    it('shows the minimum needed to recognise the order: its id, its outlet and what was ordered', () => {
      renderCard();

      expect(screen.getByText('Order #order-picked-up-7')).toBeInTheDocument();
      expect(screen.getByText('Main Canteen')).toBeInTheDocument();
      expect(screen.getByText('Chicken Biriyani × 2')).toBeInTheDocument();
      expect(screen.getByText('Veg Meals × 1')).toBeInTheDocument();
      expect(screen.getByText('3 items')).toBeInTheDocument();
    });

    it('counts a single item in the singular, and spells out lines beyond the first ten as "+N more"', () => {
      const { rerender } = renderCard(result({ order: { ...pickedUpOrgOrder, itemCount: 1, items: [{ name: 'Tea', quantity: 1 }] } }));
      expect(screen.getByText('1 item')).toBeInTheDocument();

      rerender(
        <PickupResultCard
          result={result({ order: { ...longOrgOrder, id: 'order-long', status: 'picked_up' } })}
          onComplete={vi.fn()}
          onDone={vi.fn()}
        />,
      );
      expect(screen.getByText('+3 more')).toBeInTheDocument();
      expect(screen.getByText('26 items')).toBeInTheDocument();
    });

    it('leaves the outlet out, without a gap or a guess, when it no longer exists', () => {
      renderCard(result({ order: { ...pickedUpOrgOrder, outlet: undefined } }));

      expect(screen.queryByText('Main Canteen')).not.toBeInTheDocument();
      expect(screen.getByText('Order #order-picked-up-7')).toBeInTheDocument();
    });

    it('offers "Mark completed" and "Next pickup"', () => {
      renderCard();

      expect(screen.getByRole('button', { name: 'Mark completed' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Next pickup' })).toBeEnabled();
    });

    it('"Mark completed" reports exactly this order', () => {
      const { onComplete } = renderCard();

      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith('order-picked-up-7');
    });

    it('"Next pickup" clears the screen for the next customer', () => {
      const { onDone } = renderCard();

      fireEvent.click(screen.getByRole('button', { name: 'Next pickup' }));

      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe('while completing', () => {
    it('disables both buttons and says what is happening, so it cannot be sent twice or dismissed mid-request', () => {
      const { onComplete, onDone } = renderCard(result({ completing: true }));

      const busy = screen.getByRole('button', { name: 'Completing…' });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('button', { name: 'Next pickup' })).toBeDisabled();
      fireEvent.click(busy);
      fireEvent.click(screen.getByRole('button', { name: 'Next pickup' }));
      expect(onComplete).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  describe('after a failed completion', () => {
    it('shows why as an alert, and keeps "Mark completed" available to try again', () => {
      const { onComplete } = renderCard(result({ completionError: "Couldn't reach Zesto. Please check your connection and try again." }));

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reach Zesto.");
      fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('once completed', () => {
    it('says so and offers no completion action — only "Next pickup"', () => {
      renderCard(result({ order: { ...completedOrgOrder, id: 'order-picked-up-7' } }));

      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText('This order is complete.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Mark completed|Completing/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/hand the order over/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next pickup' })).toBeEnabled();
    });
  });

  describe('privacy', () => {
    it('never renders customer identity, provider data, audit fields or a credential, even if a row carried them', () => {
      const leaky = {
        ...pickedUpOrgOrder,
        userId: 'U-secret-customer',
        customerEmail: 'asha@example.com',
        customerPhone: '+911234567890',
        descopeId: 'U2abcDESCOPE',
        providerPaymentId: 'pay_FakePaymentId1',
        razorpayOrderId: 'order_FakeProviderOrder1',
        pickedUpBy: 'U-secret-staff',
        pickedUpAt: '2026-09-28T11:00:00+05:30',
        qrPayload: 'ZP1.order-picked-up-7.AbCdEfGhIjKlMnOpQrStUv',
        code: 'K7QX-4M2P',
      } as OrganizationOrderSummary;

      const { container } = renderCard(result({ order: leaky }));

      const text = container.textContent ?? '';
      for (const secret of [
        'U-secret-customer', 'asha@example.com', '+911234567890', 'U2abcDESCOPE', 'pay_FakePaymentId1',
        'order_FakeProviderOrder1', 'U-secret-staff', 'ZP1', 'K7QX',
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(container.innerHTML).not.toContain('U-secret');
    });

    it('does not show money: the handover needs the order and its items, not what was paid', () => {
      renderCard();

      expect(screen.queryByText(/₹/)).not.toBeInTheDocument();
      expect(screen.queryByText(/paid/i)).not.toBeInTheDocument();
    });
  });
});

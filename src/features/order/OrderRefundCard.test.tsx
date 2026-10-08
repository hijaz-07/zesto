import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelledPaidOrder,
  cancelledUnpaidOrder,
  cancellableConfirmedOrder,
  refundOf,
} from '../../test/cancellationFixtures';
import { showsRefundCard } from './cancellationCopy';
import { OrderRefundCard } from './OrderRefundCard';
import type { Order } from './types';

function renderCard(order: Order) {
  return render(
    <MemoryRouter>
      <OrderRefundCard order={order} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OrderRefundCard', () => {
  describe('refund initiated (requested or pending)', () => {
    it.each(['requested', 'pending'] as const)('says the refund is initiated and in progress when it is %s', (status) => {
      renderCard(cancelledPaidOrder(refundOf(status)));

      expect(screen.getByRole('heading', { name: 'Refund initiated' })).toBeInTheDocument();
      expect(screen.getByText('In progress')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Your refund of ₹300 is being processed and may take a few business days to appear in your account.',
        ),
      ).toBeInTheDocument();
    });

    it('is a polite status region, and never promises an exact time', () => {
      renderCard(cancelledPaidOrder(refundOf('pending')));

      const region = screen.getByRole('status');
      expect(region).toHaveAccessibleName('Refund initiated');
      expect(region.textContent).not.toMatch(/within \d|by tomorrow|\d+ (hours|days)/i);
    });

    it('shows when it was initiated', () => {
      renderCard(cancelledPaidOrder(refundOf('requested')));

      expect(screen.getByText(/^Initiated /)).toBeInTheDocument();
    });
  });

  describe('refund processed', () => {
    it('says it is processed, the amount, and gives safe timing guidance', () => {
      renderCard(cancelledPaidOrder(refundOf('processed')));

      expect(screen.getByRole('heading', { name: 'Refund processed' })).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText('₹300 has been refunded to your original payment method.')).toBeInTheDocument();
      expect(
        screen.getByText('Depending on your bank, it can take a few business days to show in your account.'),
      ).toBeInTheDocument();
      expect(screen.getByText(/^Processed /)).toBeInTheDocument();
    });

    it('does not claim a date when the server gave none', () => {
      renderCard(cancelledPaidOrder(refundOf('processed', { completedAt: undefined })));

      expect(screen.getByRole('heading', { name: 'Refund processed' })).toBeInTheDocument();
      expect(screen.queryByText(/^Processed /)).not.toBeInTheDocument();
    });
  });

  describe('refund failed', () => {
    it('is a calm alert, with the approved sentence and a way to get help, and no retry button', () => {
      vi.stubEnv('VITE_PUBLIC_SUPPORT_EMAIL', '');
      renderCard(cancelledPaidOrder(refundOf('failed')));

      const alert = screen.getByRole('alert');
      expect(alert).toHaveAccessibleName('Refund not completed');
      expect(screen.getByText('Not completed')).toBeInTheDocument();
      expect(
        screen.getByText("We couldn't complete your refund automatically. We've been notified."),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/contact');
    });

    it('uses the configured support email when there is one', () => {
      vi.stubEnv('VITE_PUBLIC_SUPPORT_EMAIL', 'help@example.test');

      renderCard(cancelledPaidOrder(refundOf('failed')));

      expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', 'mailto:help@example.test');
    });
  });

  describe('missing or malformed refund', () => {
    it('a cancelled paid order with no refund summary says it is being arranged, and invents no state', () => {
      renderCard(cancelledPaidOrder(null));

      expect(screen.getByRole('heading', { name: 'Refund being arranged' })).toBeInTheDocument();
      expect(screen.getByText("We're arranging your refund. Check back shortly for an update.")).toBeInTheDocument();
      expect(screen.queryByText(/processed|initiated|not completed/i)).not.toBeInTheDocument();
    });

    it('shows no card for an order cancelled before it was paid', () => {
      const { container } = renderCard(cancelledUnpaidOrder);

      expect(container).toBeEmptyDOMElement();
      expect(showsRefundCard(cancelledUnpaidOrder)).toBe(false);
    });

    it('shows no card for an order that is not cancelled, even a paid one', () => {
      const { container } = renderCard(cancellableConfirmedOrder);

      expect(container).toBeEmptyDOMElement();
    });
  });

  it('never shows an identifier or an internal status name', () => {
    const order = {
      ...cancelledPaidOrder(refundOf('pending')),
      refund: { ...refundOf('pending'), providerRefundId: 'rfnd_secret', refundId: 'order-1-r1' },
    } as Order;

    const { container } = renderCard(order);

    for (const text of ['rfnd_secret', 'order-1-r1', 'requested', 'pending', 'razorpay']) {
      expect(container.textContent?.toLowerCase()).not.toContain(text);
    }
  });
});

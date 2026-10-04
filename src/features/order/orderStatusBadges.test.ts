import { describe, expect, it } from 'vitest';
import { orderStatusBadges } from './orderStatusBadges';
import { isPaymentConfirmedStatus, ORDER_STATUSES, type OrderStatus } from './types';

describe('orderStatusBadges', () => {
  it('shows a pending-payment order as "Payment pending" (warning), with no "Paid" badge', () => {
    expect(orderStatusBadges({ status: 'pending_payment', paymentStatus: 'pending' })).toEqual([
      { label: 'Payment pending', tone: 'warning' },
    ]);
  });

  it('shows a confirmed, paid order as "Confirmed" and "Paid" (both success)', () => {
    expect(orderStatusBadges({ status: 'confirmed', paymentStatus: 'paid' })).toEqual([
      { label: 'Confirmed', tone: 'success' },
      { label: 'Paid', tone: 'success' },
    ]);
  });

  it('shows a cancelled order as "Cancelled" (danger), never as "Payment pending"', () => {
    const badges = orderStatusBadges({ status: 'cancelled', paymentStatus: 'pending' });

    expect(badges).toEqual([{ label: 'Cancelled', tone: 'danger' }]);
    expect(badges.map((badge) => badge.label)).not.toContain('Payment pending');
  });

  it('gives each of the three original states a different primary tone', () => {
    const tones = (['pending_payment', 'confirmed', 'cancelled'] as const).map(
      (status) => orderStatusBadges({ status, paymentStatus: 'pending' })[0].tone,
    );

    expect(new Set(tones).size).toBe(3);
  });

  it('shows a preparing order as "Preparing" (warning: in progress) alongside "Paid"', () => {
    expect(orderStatusBadges({ status: 'preparing', paymentStatus: 'paid' })).toEqual([
      { label: 'Preparing', tone: 'warning' },
      { label: 'Paid', tone: 'success' },
    ]);
  });

  it('shows a ready order as "Ready" (success) alongside "Paid"', () => {
    expect(orderStatusBadges({ status: 'ready', paymentStatus: 'paid' })).toEqual([
      { label: 'Ready', tone: 'success' },
      { label: 'Paid', tone: 'success' },
    ]);
  });

  it('gives every status the backend can send a badge with a label', () => {
    for (const status of ORDER_STATUSES) {
      const [badge] = orderStatusBadges({ status, paymentStatus: 'pending' });

      expect(badge.label).not.toBe('');
      expect(badge.label).not.toBe('Unknown');
    }
  });

  it('shows a status this build does not know as words, instead of crashing the list', () => {
    // A state the backend added after this bundle was built.
    const future = { status: 'picked_up' as OrderStatus, paymentStatus: 'paid' as const };

    expect(orderStatusBadges(future)).toEqual([
      { label: 'Picked up', tone: 'neutral' },
      { label: 'Paid', tone: 'success' },
    ]);
  });
});

describe('isPaymentConfirmedStatus', () => {
  it.each(['confirmed', 'preparing', 'ready'] as const)('is true for %s: payment has confirmed the order', (status) => {
    expect(isPaymentConfirmedStatus(status)).toBe(true);
  });

  it.each(['pending_payment', 'cancelled'] as const)('is false for %s', (status) => {
    expect(isPaymentConfirmedStatus(status)).toBe(false);
  });

  it('covers every status: each is either payment-confirmed or one of the two that are not', () => {
    const notConfirmed = ORDER_STATUSES.filter((status) => !isPaymentConfirmedStatus(status));

    expect(notConfirmed).toEqual(['pending_payment', 'cancelled']);
  });
});

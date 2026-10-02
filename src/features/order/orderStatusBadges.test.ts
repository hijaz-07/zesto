import { describe, expect, it } from 'vitest';
import { orderStatusBadges } from './orderStatusBadges';

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

  it('gives each of the three states a different primary tone', () => {
    const tones = (['pending_payment', 'confirmed', 'cancelled'] as const).map(
      (status) => orderStatusBadges({ status, paymentStatus: 'pending' })[0].tone,
    );

    expect(new Set(tones).size).toBe(3);
  });
});

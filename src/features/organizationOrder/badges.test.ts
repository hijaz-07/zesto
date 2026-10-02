import { describe, expect, it } from 'vitest';
import { orderStatusBadges } from '../order/orderStatusBadges';
import type { OrderPaymentStatus, OrderStatus } from '../order/types';
import { organizationOrderPaymentBadge, organizationOrderStatusBadge } from './badges';

describe('organizationOrderStatusBadge', () => {
  it.each([
    ['pending_payment', 'pending', 'Payment pending', 'warning'],
    ['confirmed', 'paid', 'Confirmed', 'success'],
    ['cancelled', 'pending', 'Cancelled', 'danger'],
  ] as const)('maps %s to "%s" label/tone', (status, paymentStatus, label, tone) => {
    expect(organizationOrderStatusBadge({ status, paymentStatus })).toEqual({ label, tone });
  });

  it("is always the label and tone the customer's own list shows for the same order", () => {
    const statuses: OrderStatus[] = ['pending_payment', 'confirmed', 'cancelled'];
    const payments: OrderPaymentStatus[] = ['pending', 'paid'];
    for (const status of statuses) {
      for (const paymentStatus of payments) {
        const order = { status, paymentStatus };
        expect(organizationOrderStatusBadge(order)).toEqual(orderStatusBadges(order)[0]);
      }
    }
  });
});

describe('organizationOrderPaymentBadge', () => {
  it('shows Paid (success) whenever the backend says the order is paid', () => {
    expect(organizationOrderPaymentBadge({ status: 'confirmed', paymentStatus: 'paid' })).toEqual({
      label: 'Paid',
      tone: 'success',
    });
  });

  it('still shows Paid for a cancelled order that was paid: staff must notice it', () => {
    expect(organizationOrderPaymentBadge({ status: 'cancelled', paymentStatus: 'paid' })).toEqual({
      label: 'Paid',
      tone: 'success',
    });
  });

  it('shows Pending (warning) while payment is still awaited', () => {
    expect(organizationOrderPaymentBadge({ status: 'pending_payment', paymentStatus: 'pending' })).toEqual({
      label: 'Pending',
      tone: 'warning',
    });
  });

  it('shows Unpaid (neutral), not Pending, for a cancelled order whose payment never arrived', () => {
    expect(organizationOrderPaymentBadge({ status: 'cancelled', paymentStatus: 'pending' })).toEqual({
      label: 'Unpaid',
      tone: 'neutral',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderPaymentStatus, type OrderStatus } from '../order/types';
import { canFulfillOrders, canHandOverOrders, isAwaitingPickup, nextFulfillmentAction } from './fulfillment';

describe('nextFulfillmentAction', () => {
  it('offers "Start preparing" (no confirmation) on a paid, confirmed order', () => {
    expect(nextFulfillmentAction({ status: 'confirmed', paymentStatus: 'paid' })).toEqual({
      action: 'start-preparing',
      label: 'Start preparing',
      pendingLabel: 'Starting…',
      confirmation: null,
    });
  });

  it('offers "Mark ready" on a paid, preparing order, and asks first because it cannot be undone', () => {
    const spec = nextFulfillmentAction({ status: 'preparing', paymentStatus: 'paid' });

    expect(spec).toMatchObject({ action: 'mark-ready', label: 'Mark ready', pendingLabel: 'Marking ready…' });
    expect(spec?.confirmation).toEqual({
      question: 'Mark this order ready?',
      detail: "The customer will see it as ready for pickup. This can't be undone.",
      confirmLabel: 'Yes, mark ready',
    });
  });

  it('offers "Mark completed" (no confirmation) on a paid, picked-up order', () => {
    expect(nextFulfillmentAction({ status: 'picked_up', paymentStatus: 'paid' })).toEqual({
      action: 'complete',
      label: 'Mark completed',
      pendingLabel: 'Completing…',
      confirmation: null,
    });
  });

  it.each(['pending_payment', 'ready', 'completed', 'cancelled'] as const)('offers nothing on a %s order', (status) => {
    expect(nextFulfillmentAction({ status, paymentStatus: 'paid' })).toBeNull();
    expect(nextFulfillmentAction({ status, paymentStatus: 'pending' })).toBeNull();
  });

  it.each(['confirmed', 'preparing', 'picked_up'] as const)('offers nothing on a %s order that is not paid', (status) => {
    expect(nextFulfillmentAction({ status, paymentStatus: 'pending' })).toBeNull();
  });

  it('never offers the handover itself: no status, however paid, gets a pickup button on a row', () => {
    for (const status of ORDER_STATUSES) {
      const spec = nextFulfillmentAction({ status, paymentStatus: 'paid' });

      expect(spec?.action as string | undefined).not.toBe('pickup');
      expect(spec?.action as string | undefined).not.toBe('picked_up');
    }
  });

  it('never offers more than one step, and only ever forward: no status offers going back or sideways', () => {
    const statuses: readonly OrderStatus[] = ORDER_STATUSES;
    const payments: OrderPaymentStatus[] = ['pending', 'paid'];
    const offered = statuses.flatMap((status) =>
      payments.map((paymentStatus) => nextFulfillmentAction({ status, paymentStatus })?.action ?? null),
    );

    expect(offered.filter((action) => action !== null).sort()).toEqual(['complete', 'mark-ready', 'start-preparing']);
  });
});

describe('isAwaitingPickup', () => {
  it('is true only for a ready, paid order', () => {
    expect(isAwaitingPickup({ status: 'ready', paymentStatus: 'paid' })).toBe(true);
    expect(isAwaitingPickup({ status: 'ready', paymentStatus: 'pending' })).toBe(false);
  });

  it.each(['pending_payment', 'confirmed', 'preparing', 'picked_up', 'completed', 'cancelled'] as const)(
    'is false for a %s order',
    (status) => {
      expect(isAwaitingPickup({ status, paymentStatus: 'paid' })).toBe(false);
    },
  );
});

describe('canHandOverOrders', () => {
  it.each(['owner', 'manager', 'staff'] as const)('is true for an %s', (role) => {
    expect(canHandOverOrders(role)).toBe(true);
  });

  it('is false for anything that is not one of the three roles (a tampered or future value)', () => {
    expect(canHandOverOrders('superadmin' as never)).toBe(false);
    expect(canHandOverOrders('' as never)).toBe(false);
    expect(canHandOverOrders(undefined as never)).toBe(false);
  });
});

describe('canFulfillOrders', () => {
  it.each(['owner', 'manager', 'staff'] as const)('is true for an %s', (role) => {
    expect(canFulfillOrders(role)).toBe(true);
  });

  it('is false for anything that is not one of the three roles (a tampered or future value)', () => {
    expect(canFulfillOrders('superadmin' as never)).toBe(false);
    expect(canFulfillOrders(undefined as never)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  cancelledPaidOrgOrder,
  cancelledOrgOrder,
  completedOrgOrder,
  confirmedOrgOrder,
  customerCancelledUnpaidOrgOrder,
  pendingOrgOrder,
  pickedUpOrgOrder,
  preparingOrgOrder,
  readyOrgOrder,
} from '../../test/organizationOrderFixtures';
import {
  ORGANIZATION_CANCELLATION_REASONS,
  ORGANIZATION_CANCELLATION_REASON_LABEL,
  cancelledByText,
  canCancelOrders,
  canRecoverRefunds,
  isOrderCancellable,
  organizationRefundView,
} from './cancellation';

describe('canCancelOrders / canRecoverRefunds', () => {
  it('allows owner and manager, and not staff', () => {
    expect(canCancelOrders('owner')).toBe(true);
    expect(canCancelOrders('manager')).toBe(true);
    expect(canCancelOrders('staff')).toBe(false);
    expect(canRecoverRefunds('owner')).toBe(true);
    expect(canRecoverRefunds('manager')).toBe(true);
    expect(canRecoverRefunds('staff')).toBe(false);
  });
});

describe('isOrderCancellable', () => {
  it.each([
    [pendingOrgOrder, true],
    [confirmedOrgOrder, true],
    [preparingOrgOrder, true],
    [readyOrgOrder, true],
    [pickedUpOrgOrder, false],
    [completedOrgOrder, false],
    [cancelledOrgOrder, false],
  ])('%#: %s', (order, expected) => {
    expect(isOrderCancellable(order)).toBe(expected);
  });
});

describe('approved reasons', () => {
  it('are exactly the six the backend accepts, each with an operator label', () => {
    expect([...ORGANIZATION_CANCELLATION_REASONS]).toEqual([
      'item_unavailable',
      'outlet_closed',
      'cannot_fulfil_in_time',
      'duplicate_order',
      'customer_requested',
      'other',
    ]);
    for (const reason of ORGANIZATION_CANCELLATION_REASONS) {
      expect(ORGANIZATION_CANCELLATION_REASON_LABEL[reason]).toBeTruthy();
    }
  });
});

describe('organizationRefundView', () => {
  it('is none for an order that was not cancelled', () => {
    expect(organizationRefundView(confirmedOrgOrder)).toBeNull();
  });

  it('is none for an order cancelled before it was paid', () => {
    expect(organizationRefundView(cancelledOrgOrder)).toBeNull();
    expect(organizationRefundView(customerCancelledUnpaidOrgOrder)).toBeNull();
  });

  it.each([
    ['in_progress', 'pending', 'Refund pending', 'warning', false],
    ['refunded', 'processed', 'Refund processed', 'success', false],
    ['attention_required', 'failed', 'Refund failed — attention required', 'danger', true],
    ['partially_refunded', 'partial', 'Partly refunded — attention required', 'danger', true],
  ] as const)('maps %s to %s', (state, kind, label, tone, needsAttention) => {
    expect(organizationRefundView(cancelledPaidOrgOrder({ state, refundedInPaise: 0 }))).toEqual({
      kind,
      label,
      tone,
      needsAttention,
    });
  });

  it('says the status is unavailable — never a guess — for a cancelled paid order with no refund block', () => {
    expect(organizationRefundView(cancelledPaidOrgOrder(null))).toEqual({
      kind: 'unavailable',
      label: 'Refund status unavailable',
      tone: 'neutral',
      needsAttention: false,
    });
  });
});

describe('cancelledByText', () => {
  it('names who cancelled, only for a cancelled order with a recorded cancellation', () => {
    expect(cancelledByText(cancelledPaidOrgOrder())).toBe('Cancelled by your team');
    expect(cancelledByText(customerCancelledUnpaidOrgOrder)).toBe('Cancelled by the customer');
    expect(cancelledByText(cancelledOrgOrder)).toBeNull();
    expect(cancelledByText(confirmedOrgOrder)).toBeNull();
  });
});

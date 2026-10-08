import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OrganizationMemberRole } from '../../domain/types';
import {
  cancelledOrgOrder,
  cancelledPaidOrgOrder,
  completedOrgOrder,
  confirmedOrgOrder,
  pendingOrgOrder,
  pickedUpOrgOrder,
  preparingOrgOrder,
  readyOrgOrder,
} from '../../test/organizationOrderFixtures';
import { OrganizationOrderActions } from './OrganizationOrderActions';
import type { OrganizationOrderSummary } from './types';

function renderActions(
  order: OrganizationOrderSummary,
  role: OrganizationMemberRole,
  extra: { pending?: boolean; error?: string | null } = {},
) {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  const onRetryRefund = vi.fn();
  render(
    <OrganizationOrderActions
      order={order}
      role={role}
      pending={extra.pending ?? false}
      error={extra.error ?? null}
      onRun={onRun}
      onCancel={onCancel}
      onRetryRefund={onRetryRefund}
    />,
  );
  return { onRun, onCancel, onRetryRefund };
}

const cancelButton = () => screen.queryByRole('button', { name: /^Cancel order / });
const retryButton = () => screen.queryByRole('button', { name: /^Retry refund/ });

describe('OrganizationOrderActions — Cancel order', () => {
  it.each(['owner', 'manager'] as const)('is offered to an %s, and asks to open the dialog for that order', (role) => {
    const { onCancel, onRun } = renderActions(confirmedOrgOrder, role);

    const button = screen.getByRole('button', { name: 'Cancel order order-confirmed-1' });
    expect(button).toHaveClass('min-h-11');
    fireEvent.click(button);

    expect(onCancel).toHaveBeenCalledWith('order-confirmed-1');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('is never offered to staff, who keep the fulfilment actions', () => {
    renderActions(confirmedOrgOrder, 'staff');

    expect(cancelButton()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start preparing/ })).toBeInTheDocument();
  });

  it.each([
    ['pending payment', pendingOrgOrder],
    ['confirmed', confirmedOrgOrder],
    ['preparing', preparingOrgOrder],
    ['ready', readyOrgOrder],
  ])('is offered for a %s order', (_name, order) => {
    renderActions(order, 'owner');

    expect(cancelButton()).toBeInTheDocument();
  });

  it.each([
    ['picked up', pickedUpOrgOrder],
    ['completed', completedOrgOrder],
    ['cancelled', cancelledOrgOrder],
  ])('is not offered for a %s order', (_name, order) => {
    renderActions(order, 'owner');

    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('sits beside the fulfilment action without a stray placeholder, and keeps "Awaiting pickup" for a ready order', () => {
    renderActions(readyOrgOrder, 'manager');

    expect(screen.getByText('Awaiting pickup')).toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('is disabled while a request for the order is in flight', () => {
    renderActions(confirmedOrgOrder, 'owner', { pending: true });

    expect(cancelButton()).toBeDisabled();
  });

  it('shows a row error for an order with a cancel button', () => {
    renderActions(pendingOrgOrder, 'owner', { error: 'This order has changed since you opened it.' });

    expect(screen.getByRole('alert')).toHaveTextContent('has changed');
  });

  it('shows staff a dash, not an empty cell, where there is nothing for them to do', () => {
    renderActions(pendingOrgOrder, 'staff');

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('OrganizationOrderActions — refund recovery', () => {
  const failed = cancelledPaidOrgOrder({ state: 'attention_required', refundedInPaise: 0 });

  it.each(['owner', 'manager'] as const)(
    'offers an %s a working Retry refund control for a failed refund, which asks to retry that order only',
    (role) => {
      const { onRetryRefund, onRun, onCancel } = renderActions(failed, role);

      const retry = screen.getByRole('button', { name: `Retry refund, order ${failed.id}` });
      expect(retry).toBeEnabled();
      expect(retry).not.toHaveAttribute('aria-disabled');
      expect(retry).toHaveClass('min-h-11');
      fireEvent.click(retry);

      expect(onRetryRefund).toHaveBeenCalledTimes(1);
      expect(onRetryRefund).toHaveBeenCalledWith(failed.id);
      expect(onRun).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    },
  );

  it('disables the retry while a request for the order is in flight', () => {
    const { onRetryRefund } = renderActions(failed, 'owner', { pending: true });

    const retry = retryButton() as HTMLElement;
    expect(retry).toBeDisabled();
    fireEvent.click(retry);

    expect(onRetryRefund).not.toHaveBeenCalled();
  });

  it('shows staff no retry and no reference to one', () => {
    const { onRetryRefund } = renderActions(failed, 'staff');

    expect(retryButton()).not.toBeInTheDocument();
    expect(screen.queryByText(/retry/i)).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(onRetryRefund).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', cancelledPaidOrgOrder({ state: 'in_progress', refundedInPaise: 0 })],
    ['processed', cancelledPaidOrgOrder({ state: 'refunded', refundedInPaise: 30000 })],
    ['unavailable', cancelledPaidOrgOrder(null)],
  ])('shows no retry for a %s refund', (_name, order) => {
    renderActions(order, 'owner');

    expect(retryButton()).not.toBeInTheDocument();
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('surfaces a row error on a cancelled order, so a refused cancellation is never silent', () => {
    renderActions(cancelledPaidOrgOrder(), 'owner', { error: 'This order has changed since you opened it.' });

    expect(screen.getByRole('alert')).toHaveTextContent('has changed');
  });
});

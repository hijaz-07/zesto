import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  cancelledOrgOrder,
  cancelledPaidOrgOrder,
  confirmedOrgOrder,
  customerCancelledUnpaidOrgOrder,
} from '../../test/organizationOrderFixtures';
import { OrderCancellationStatus } from './OrderCancellationStatus';
import { OrganizationOrdersTable } from './OrganizationOrdersTable';
import type { OrganizationOrderSummary } from './types';

function renderStatus(order: OrganizationOrderSummary) {
  return render(<OrderCancellationStatus order={order} />);
}

describe('OrderCancellationStatus', () => {
  it('renders nothing for an order that was not cancelled', () => {
    const { container } = renderStatus(confirmedOrgOrder);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a cancelled order with neither a recorded cancellation nor money to refund', () => {
    const { container } = renderStatus(cancelledOrgOrder);

    expect(container).toBeEmptyDOMElement();
  });

  it('says who cancelled and when, for an unpaid order with no refund', () => {
    renderStatus(customerCancelledUnpaidOrgOrder);

    expect(screen.getByText(/^Cancelled by the customer · /)).toBeInTheDocument();
    expect(screen.queryByText(/refund/i)).not.toBeInTheDocument();
  });

  it.each([
    [{ state: 'in_progress', refundedInPaise: 0 }, 'Refund pending'],
    [{ state: 'refunded', refundedInPaise: 30000 }, 'Refund processed'],
    [{ state: 'attention_required', refundedInPaise: 0 }, 'Refund failed — attention required'],
  ] as const)('shows the refund state %# in words', (refund, label) => {
    renderStatus(cancelledPaidOrgOrder(refund));

    expect(screen.getByText('Cancelled by your team', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows the amount refunded only once it is processed', () => {
    const { unmount } = renderStatus(cancelledPaidOrgOrder({ state: 'refunded', refundedInPaise: 30000 }));
    expect(screen.getByText('₹300 refunded')).toBeInTheDocument();
    unmount();

    renderStatus(cancelledPaidOrgOrder({ state: 'in_progress', refundedInPaise: 0 }));
    expect(screen.queryByText(/refunded$/)).not.toBeInTheDocument();
  });

  it('says plainly that the refund status is unavailable when a paid cancelled order has no refund block', () => {
    renderStatus(cancelledPaidOrgOrder(null));

    expect(screen.getByText('Refund status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Refund processed')).not.toBeInTheDocument();
    expect(screen.queryByText('Refund pending')).not.toBeInTheDocument();
  });

  it('never shows a provider id, a raw status or an internal field', () => {
    const order = {
      ...cancelledPaidOrgOrder({ state: 'attention_required', refundedInPaise: 0 }),
      providerRefundId: 'rfnd_secret',
      cancelledBy: 'U-internal',
    } as OrganizationOrderSummary;

    const { container } = renderStatus(order);

    expect(container.textContent).not.toMatch(/rfnd_|pay_|U-internal|attention_required|in_progress/);
  });
});

describe('OrganizationOrdersTable — cancelled rows', () => {
  it('shows the cancellation and refund state in the Status cell, to a read-only table too', () => {
    render(<OrganizationOrdersTable orders={[cancelledPaidOrgOrder({ state: 'attention_required', refundedInPaise: 0 })]} />);

    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveTextContent('Cancelled');
    expect(row).toHaveTextContent('Cancelled by your team');
    expect(row).toHaveTextContent('Refund failed — attention required');
    expect(row).toHaveTextContent('Paid');
  });
});

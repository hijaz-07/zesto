import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  cancelledOrgOrder,
  confirmedOrgOrder,
  pendingOrgOrder,
  preparingOrgOrder,
  readyOrgOrder,
} from '../../test/organizationOrderFixtures';
import { OrderFulfillmentActions } from './OrderFulfillmentActions';
import type { OrganizationOrderSummary } from './types';

function renderActions(
  order: OrganizationOrderSummary,
  { pending = false, error = null }: { pending?: boolean; error?: string | null } = {},
) {
  const onRun = vi.fn();
  render(<OrderFulfillmentActions order={order} pending={pending} error={error} onRun={onRun} />);
  return onRun;
}

describe('OrderFulfillmentActions', () => {
  describe('a confirmed, paid order', () => {
    it('offers "Start preparing"', () => {
      renderActions(confirmedOrgOrder);

      expect(screen.getByRole('button', { name: /^Start preparing, order order-confirmed-1$/ })).toBeEnabled();
      expect(screen.getByRole('button')).toHaveTextContent('Start preparing');
    });

    it('acts on a single press, with no confirmation step', () => {
      const onRun = renderActions(confirmedOrgOrder);

      fireEvent.click(screen.getByRole('button', { name: /Start preparing/ }));

      expect(onRun).toHaveBeenCalledTimes(1);
      expect(onRun).toHaveBeenCalledWith('order-confirmed-1', 'start-preparing');
      expect(screen.queryByText(/can't be undone/)).not.toBeInTheDocument();
    });

    it('offers no "Mark ready" yet', () => {
      renderActions(confirmedOrgOrder);

      expect(screen.queryByRole('button', { name: /Mark ready/ })).not.toBeInTheDocument();
    });
  });

  describe('a preparing order', () => {
    it('offers "Mark ready", and nothing else', () => {
      renderActions(preparingOrgOrder);

      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(screen.getByRole('button', { name: /^Mark ready, order order-preparing-5$/ })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /Start preparing/ })).not.toBeInTheDocument();
    });

    it('asks for confirmation first, and sends nothing until it is given', () => {
      const onRun = renderActions(preparingOrgOrder);

      fireEvent.click(screen.getByRole('button', { name: /Mark ready/ }));

      const group = screen.getByRole('group', { name: /Confirm: Mark ready/ });
      expect(within(group).getByText('Mark this order ready?')).toBeInTheDocument();
      expect(within(group).getByText("The customer will see it as ready for pickup. This can't be undone.")).toBeInTheDocument();
      expect(onRun).not.toHaveBeenCalled();
    });

    it('sends the action only when the confirmation is accepted', () => {
      const onRun = renderActions(preparingOrgOrder);
      fireEvent.click(screen.getByRole('button', { name: /Mark ready/ }));

      fireEvent.click(screen.getByRole('button', { name: 'Yes, mark ready' }));

      expect(onRun).toHaveBeenCalledTimes(1);
      expect(onRun).toHaveBeenCalledWith('order-preparing-5', 'mark-ready');
    });

    it('sends nothing and goes back to the single button when the confirmation is cancelled', () => {
      const onRun = renderActions(preparingOrgOrder);
      fireEvent.click(screen.getByRole('button', { name: /Mark ready/ }));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onRun).not.toHaveBeenCalled();
      expect(screen.queryByRole('group')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
    });
  });

  describe.each([
    ['ready', readyOrgOrder],
    ['pending_payment', pendingOrgOrder],
    ['cancelled', cancelledOrgOrder],
    ['confirmed but not paid', { ...confirmedOrgOrder, paymentStatus: 'pending' as const }],
    ['preparing but not paid', { ...preparingOrgOrder, paymentStatus: 'pending' as const }],
  ])('a %s order', (_label, order) => {
    it('offers no button at all', () => {
      renderActions(order);

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('while the request is in flight', () => {
    it('disables "Start preparing" and says what is happening', () => {
      const onRun = renderActions(confirmedOrgOrder, { pending: true });

      const button = screen.getByRole('button', { name: /Starting…/ });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(button);
      expect(onRun).not.toHaveBeenCalled();
    });

    it('disables "Mark ready" itself too', () => {
      renderActions(preparingOrgOrder, { pending: true });

      expect(screen.getByRole('button', { name: /Marking ready…/ })).toBeDisabled();
    });

    it('disables both confirmation buttons, so it can be neither repeated nor cancelled mid-request', () => {
      const onRun = vi.fn();
      const { rerender } = render(
        <OrderFulfillmentActions order={preparingOrgOrder} pending={false} error={null} onRun={onRun} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Mark ready/ }));

      rerender(<OrderFulfillmentActions order={preparingOrgOrder} pending error={null} onRun={onRun} />);

      expect(screen.getByRole('button', { name: 'Marking ready…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
  });

  describe('after a failure', () => {
    it('shows the message as an alert beside the button, which stays available to try again', () => {
      const onRun = renderActions(confirmedOrgOrder, { error: 'Zesto is temporarily unavailable.' });

      expect(screen.getByRole('alert')).toHaveTextContent('Zesto is temporarily unavailable.');
      fireEvent.click(screen.getByRole('button', { name: /Start preparing/ }));
      expect(onRun).toHaveBeenCalledTimes(1);
    });

    it('keeps the message inside an open confirmation, and the confirmation open', () => {
      const onRun = vi.fn();
      const { rerender } = render(
        <OrderFulfillmentActions order={preparingOrgOrder} pending={false} error={null} onRun={onRun} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Mark ready/ }));

      rerender(<OrderFulfillmentActions order={preparingOrgOrder} pending={false} error="Try again." onRun={onRun} />);

      const group = screen.getByRole('group', { name: /Confirm: Mark ready/ });
      expect(within(group).getByRole('alert')).toHaveTextContent('Try again.');
      expect(within(group).getByRole('button', { name: 'Yes, mark ready' })).toBeEnabled();
    });

    it('shows the message even when the refreshed order has no further action (no button, no dash read aloud)', () => {
      renderActions(readyOrgOrder, { error: 'This order has changed since you loaded it. The list has been refreshed.' });

      expect(screen.getByRole('alert')).toHaveTextContent('This order has changed since you loaded it.');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  it('leaves the confirmation behind when the order moves on underneath it', () => {
    const onRun = vi.fn();
    const { rerender } = render(
      <OrderFulfillmentActions order={preparingOrgOrder} pending={false} error={null} onRun={onRun} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Mark ready/ }));

    rerender(<OrderFulfillmentActions order={readyOrgOrder} pending={false} error={null} onRun={onRun} />);

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

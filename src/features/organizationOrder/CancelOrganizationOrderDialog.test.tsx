import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmedOrgOrder,
  longOrgOrder,
  pendingOrgOrder,
  preparingOrgOrder,
  readyOrgOrder,
} from '../../test/organizationOrderFixtures';
import { CancelOrganizationOrderDialog } from './CancelOrganizationOrderDialog';
import { ORGANIZATION_CANCELLATION_REASONS } from './cancellation';
import type { OrganizationOrderSummary } from './types';

function renderDialog(
  props: Partial<{
    order: OrganizationOrderSummary | null;
    pending: boolean;
    errorMessage: string | null;
  }> = {},
) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <CancelOrganizationOrderDialog
      order={props.order === undefined ? confirmedOrgOrder : props.order}
      pending={props.pending ?? false}
      errorMessage={props.errorMessage ?? null}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  return { ...view, onConfirm, onClose };
}

const reasonSelect = () => screen.getByRole('combobox', { name: /Reason/ }) as HTMLSelectElement;
const choose = (reason: string) => fireEvent.change(reasonSelect(), { target: { value: reason } });

describe('CancelOrganizationOrderDialog', () => {
  it('renders nothing without an order', () => {
    renderDialog({ order: null });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a modal dialog named for the decision, with the order as context', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: 'Cancel this order?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('#order-confirmed-1')).toBeInTheDocument();
    expect(within(dialog).getByText('Main Canteen')).toBeInTheDocument();
    expect(within(dialog).getByText('Chicken Biriyani × 2')).toBeInTheDocument();
    expect(within(dialog).getByText('Veg Meals × 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Total ₹300')).toBeInTheDocument();
    expect(within(dialog).getByText('Current status')).toBeInTheDocument();
    expect(within(dialog).getByText('Confirmed')).toBeInTheDocument();
  });

  it('counts item lines beyond those listed', () => {
    renderDialog({ order: longOrgOrder });

    expect(screen.getByText('+3 more')).toBeInTheDocument();
  });

  it('warns that cancelling is permanent and tells the customer, for any order', () => {
    renderDialog();

    expect(screen.getByText("Cancelling is permanent and can't be undone.")).toBeInTheDocument();
    expect(screen.getByText('The customer will be notified.')).toBeInTheDocument();
  });

  it('tells the operator a paid order is fully refunded, without provider details or an amount in flight', () => {
    renderDialog({ order: confirmedOrgOrder });

    expect(screen.getByText('The customer will receive a full refund of the eligible amount.')).toBeInTheDocument();
    expect(screen.queryByText(/razorpay|provider|UPI|card/i)).not.toBeInTheDocument();
  });

  it('says there is nothing to refund for an unpaid order', () => {
    renderDialog({ order: pendingOrgOrder });

    expect(screen.queryByText(/full refund of the eligible amount/)).not.toBeInTheDocument();
    expect(screen.getByText(/hasn.t been paid for, so there.s nothing to refund/)).toBeInTheDocument();
    expect(screen.getByText('Payment pending')).toBeInTheDocument();
  });

  it.each([
    [preparingOrgOrder, 'Preparation has already started on this order.'],
    [readyOrgOrder, 'This order is already marked ready for pickup.'],
  ])('notes where the order stands when work has begun (%#)', (order, note) => {
    renderDialog({ order });

    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('offers exactly the approved reasons, in a required, labelled selector with no free text', () => {
    renderDialog();

    const select = reasonSelect();
    expect(select).toBeRequired();
    const options = within(select).getAllByRole('option');
    expect(options).toHaveLength(ORGANIZATION_CANCELLATION_REASONS.length + 1);
    expect(options.slice(1).map((option) => (option as HTMLOptionElement).value)).toEqual([
      ...ORGANIZATION_CANCELLATION_REASONS,
    ]);
    expect(select).toHaveValue('');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not confirm without a reason: says so, moves focus to the selector, and sends nothing', () => {
    const { onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel order' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a reason to cancel this order.');
    expect(reasonSelect()).toHaveFocus();
    expect(reasonSelect()).toHaveAttribute('aria-invalid', 'true');
    expect(reasonSelect()).toHaveAccessibleDescription('Choose a reason to cancel this order.');
  });

  it('confirms with the chosen reason, and clears the missing-reason message once one is chosen', () => {
    const { onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel order' }));
    choose('outlet_closed');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel order' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('outlet_closed');
  });

  it.each(ORGANIZATION_CANCELLATION_REASONS)('can confirm with the %s reason', (reason) => {
    const { onConfirm } = renderDialog();

    choose(reason);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel order' }));

    expect(onConfirm).toHaveBeenCalledWith(reason);
  });

  it('puts focus on the safe choice, "Keep order", and closes from it', () => {
    const { onClose, onConfirm } = renderDialog();

    expect(screen.getByRole('button', { name: 'Keep order' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes on Escape and on a tap outside, but not on a tap inside', () => {
    const { onClose } = renderDialog();
    const dialog = screen.getByRole('dialog');

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps Tab inside the dialog, wrapping from the last control to the first and back', () => {
    renderDialog();
    const confirm = screen.getByRole('button', { name: 'Yes, cancel order' });

    // DOM order, which is also the visual order: reason selector, Keep order, then confirm.
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(reasonSelect()).toHaveFocus();

    fireEvent.keyDown(reasonSelect(), { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it('returns focus to where it came from when it closes', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { unmount } = renderDialog();
    expect(screen.getByRole('button', { name: 'Keep order' })).toHaveFocus();
    unmount();

    expect(opener).toHaveFocus();
    opener.remove();
  });

  describe('while a request is in flight', () => {
    it('says it is cancelling, ignores presses, cannot be dismissed and freezes the selector', () => {
      const { onConfirm, onClose } = renderDialog({ pending: true });

      const confirm = screen.getByRole('button', { name: 'Cancelling…' });
      expect(confirm).toHaveAttribute('aria-busy', 'true');
      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(confirm);
      fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      fireEvent.mouseDown((screen.getByRole('dialog').parentElement) as HTMLElement);

      expect(onConfirm).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(reasonSelect()).toBeDisabled();
    });
  });

  it('shows a failure as an alert, keeps the chosen reason, and offers to try again', () => {
    const { rerender, onConfirm, onClose } = renderDialog();
    choose('duplicate_order');

    rerender(
      <CancelOrganizationOrderDialog
        order={confirmedOrgOrder}
        pending={false}
        errorMessage="Zesto is temporarily unavailable. The order was not cancelled. Please try again in a moment."
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(reasonSelect()).toHaveValue('duplicate_order');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onConfirm).toHaveBeenCalledWith('duplicate_order');
  });

  it('follows the order it is given: a refreshed status shows without reopening', () => {
    const { rerender, onConfirm, onClose } = renderDialog({ order: confirmedOrgOrder });
    expect(screen.getByText('Confirmed')).toBeInTheDocument();

    rerender(
      <CancelOrganizationOrderDialog
        order={{ ...preparingOrgOrder, id: confirmedOrgOrder.id }}
        pending={false}
        errorMessage={null}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Preparing')).toBeInTheDocument();
    expect(screen.getByText('Preparation has already started on this order.')).toBeInTheDocument();
  });

  it('has 44px-high controls', () => {
    renderDialog();

    for (const control of [
      reasonSelect(),
      screen.getByRole('button', { name: 'Keep order' }),
      screen.getByRole('button', { name: 'Yes, cancel order' }),
    ]) {
      expect(control).toHaveClass('min-h-11');
    }
  });
});

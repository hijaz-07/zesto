import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CancelOrderDialog, type CancelOrderDialogProps } from './CancelOrderDialog';

function Harness(props: Partial<CancelOrderDialogProps> & { onConfirm?: CancelOrderDialogProps['onConfirm'] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open cancel dialog</button>
      <CancelOrderDialog
        open={open}
        paidInPaise={30000}
        pending={false}
        errorMessage={null}
        onConfirm={vi.fn()}
        onClose={() => setOpen(false)}
        {...props}
      />
    </>
  );
}

function openDialog() {
  const trigger = screen.getByRole('button', { name: 'Open cancel dialog' });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole('dialog') };
}

describe('CancelOrderDialog', () => {
  it('renders nothing while closed', () => {
    render(<CancelOrderDialog open={false} paidInPaise={null} pending={false} errorMessage={null} onConfirm={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('accessible structure', () => {
    it('is a modal dialog named by its title and described by what will happen', () => {
      render(<Harness />);

      const { dialog } = openDialog();

      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAccessibleName('Cancel this order?');
      expect(dialog).toHaveAccessibleDescription(/This will cancel your order\. It can't be undone\./);
      expect(dialog).toHaveAccessibleDescription(/full refund of ₹300 to your original payment method/);
      expect(dialog).toHaveAccessibleDescription(/may take a few business days/);
    });

    it('is rendered into the document body, not inside the page that opened it', () => {
      const { container } = render(<Harness />);

      const { dialog } = openDialog();

      expect(container).not.toContainElement(dialog);
      expect(document.body).toContainElement(dialog);
    });

    it('labels the reason selector, and says it is optional', () => {
      render(<Harness />);
      const { dialog } = openDialog();

      const select = within(dialog).getByRole('combobox', { name: /Reason/ });
      expect(select).toHaveAccessibleName('Reason (optional)');
      expect(select).toHaveValue('');
    });

    it('offers exactly the five approved reasons and an explicit "prefer not to say"', () => {
      render(<Harness />);
      const { dialog } = openDialog();

      const options = within(within(dialog).getByRole('combobox')).getAllByRole('option');

      expect(options.map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
        ['', 'Prefer not to say'],
        ['changed_my_mind', 'I changed my mind'],
        ['ordered_by_mistake', 'I ordered by mistake'],
        ['wrong_items_or_quantity', 'Wrong items or quantity'],
        ['wrong_pickup_time', 'Wrong pickup time'],
        ['other', 'Other'],
      ]);
    });

    it('has no free-text input', () => {
      render(<Harness />);
      const { dialog } = openDialog();

      expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
      expect(dialog.querySelector('textarea, input[type="text"]')).toBeNull();
    });

    it('gives its buttons a comfortable touch target', () => {
      render(<Harness />);
      const { dialog } = openDialog();

      for (const button of within(dialog).getAllByRole('button')) {
        expect(button.className).toContain('min-h-11');
      }
      expect(within(dialog).getByRole('combobox').className).toContain('min-h-11');
    });
  });

  describe('what it says about money', () => {
    it('says a refund applies, with the amount and destination, for a paid order', () => {
      render(<Harness paidInPaise={24000} />);
      const { dialog } = openDialog();

      expect(within(dialog).getByText(/full refund of ₹240 to your original payment method/)).toBeInTheDocument();
      expect(within(dialog).getByText(/processed in the background/)).toBeInTheDocument();
    });

    it('promises no refund for an order that was not paid for', () => {
      render(<Harness paidInPaise={null} />);
      const { dialog } = openDialog();

      expect(within(dialog).getByText("This order hasn't been paid for, so there's nothing to refund.")).toBeInTheDocument();
      expect(dialog.textContent).not.toMatch(/refund of|processed in the background/i);
    });
  });

  describe('focus', () => {
    it('moves focus into the dialog onto the safe choice, "Keep order"', () => {
      render(<Harness />);

      const { dialog } = openDialog();

      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      expect(screen.getByRole('button', { name: 'Keep order' })).toHaveFocus();
    });

    it('keeps Tab inside the dialog, wrapping from the last control to the first and back', () => {
      render(<Harness />);
      const { dialog } = openDialog();
      const keep = within(dialog).getByRole('button', { name: 'Keep order' });
      const confirm = within(dialog).getByRole('button', { name: 'Yes, cancel order' });
      const select = within(dialog).getByRole('combobox');
      // DOM order, which is also the visual order: reason selector, Keep order, then confirm.
      expect([select, keep, confirm].every((el) => dialog.contains(el))).toBe(true);

      confirm.focus();
      fireEvent.keyDown(confirm, { key: 'Tab' });
      expect(select).toHaveFocus();

      fireEvent.keyDown(select, { key: 'Tab', shiftKey: true });
      expect(confirm).toHaveFocus();
    });

    it('returns focus to the control that opened it when it closes', () => {
      render(<Harness />);
      const { trigger } = openDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  describe('keyboard and dismissal', () => {
    it('closes on Escape', () => {
      render(<Harness />);
      const { dialog } = openDialog();

      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes when the backdrop is tapped, but not when the dialog itself is', () => {
      render(<Harness />);
      const { dialog } = openDialog();

      fireEvent.mouseDown(dialog);
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.mouseDown(dialog.parentElement as HTMLElement);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('confirms from the keyboard: Enter or Space on the focused confirm button', () => {
      const onConfirm = vi.fn();
      render(<Harness onConfirm={onConfirm} />);
      openDialog();
      const confirm = screen.getByRole('button', { name: 'Yes, cancel order' });

      confirm.focus();
      // A native button turns Enter/Space into a click; user-event is not installed, so the click is the unit.
      fireEvent.click(confirm);

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  describe('reason', () => {
    it('confirms with no reason by default', () => {
      const onConfirm = vi.fn();
      render(<Harness onConfirm={onConfirm} />);
      openDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel order' }));

      expect(onConfirm).toHaveBeenCalledWith(undefined);
    });

    it('confirms with the chosen reason', () => {
      const onConfirm = vi.fn();
      render(<Harness onConfirm={onConfirm} />);
      openDialog();

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wrong_pickup_time' } });
      fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel order' }));

      expect(onConfirm).toHaveBeenCalledWith('wrong_pickup_time');
    });

    it('starts again with no reason chosen when it is reopened', () => {
      render(<Harness />);
      openDialog();
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } });
      fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));

      openDialog();

      expect(screen.getByRole('combobox')).toHaveValue('');
    });
  });

  describe('while the request is in flight', () => {
    it('cannot be dismissed or confirmed again, says it is working, and keeps focus inside', () => {
      const onConfirm = vi.fn();
      const onClose = vi.fn();
      render(
        <CancelOrderDialog open paidInPaise={30000} pending errorMessage={null} onConfirm={onConfirm} onClose={onClose} />,
      );
      const dialog = screen.getByRole('dialog');
      const confirm = within(dialog).getByRole('button', { name: 'Cancelling…' });

      expect(confirm).toHaveAttribute('aria-busy', 'true');
      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(confirm);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep order' }));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      fireEvent.mouseDown(dialog.parentElement as HTMLElement);

      expect(onConfirm).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      // The buttons are not `disabled`, so focus is never dropped out of the dialog.
      expect(confirm).not.toBeDisabled();
    });
  });

  describe('a failed attempt', () => {
    it('shows the error as an alert inside the dialog and offers to try again', () => {
      const onConfirm = vi.fn();
      render(
        <CancelOrderDialog
          open
          paidInPaise={30000}
          pending={false}
          errorMessage="Zesto is temporarily unavailable. Please try again in a moment."
          onConfirm={onConfirm}
          onClose={vi.fn()}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent('Zesto is temporarily unavailable. Please try again in a moment.');
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationMemberRole } from '../../domain/types';
import {
  cancelOrganizationOrder,
  listOrganizationOrders,
  retryOrganizationRefund,
  runFulfillmentAction,
} from '../../features/organizationOrder/api';
import type { OrganizationOrdersPage as OrdersPage, OrganizationOrderSummary } from '../../features/organizationOrder/types';
import { getOutlets } from '../../features/outlet/api';
import { ApiError } from '../../lib/api/client';
import { FakeIntersectionObserver } from '../../test/fakeIntersectionObserver';
import {
  cancelledPaidOrgOrder,
  completedOrgOrder,
  confirmedOrgOrder,
  customerCancelledUnpaidOrgOrder,
  orgOutlets,
  pendingOrgOrder,
  pickedUpOrgOrder,
  preparingOrgOrder,
  readyOrgOrder,
} from '../../test/organizationOrderFixtures';
import { OrganizationOrdersPage } from './OrganizationOrdersPage';

vi.mock('../../features/organizationOrder/api');
vi.mock('../../features/outlet/api');

const mockedList = vi.mocked(listOrganizationOrders);
const mockedCancel = vi.mocked(cancelOrganizationOrder);
const mockedRunAction = vi.mocked(runFulfillmentAction);
const mockedRetryRefund = vi.mocked(retryOrganizationRefund);
const mockedGetOutlets = vi.mocked(getOutlets);

const page = (orders: OrganizationOrderSummary[]): OrdersPage => ({ orders, nextCursor: null });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage(role: OrganizationMemberRole = 'owner', organizationId = 'org-1') {
  return render(
    <MemoryRouter initialEntries={['/org/orders']}>
      <OrganizationOrdersPage organizationId={organizationId} role={role} />
    </MemoryRouter>,
  );
}

function rowOf(orderId: string): HTMLElement {
  // Scoped to the table: an open dialog repeats the order id.
  const row = within(screen.getByRole('table')).getByText(`#${orderId}`).closest('tr');
  if (!row) {
    throw new Error(`no row for ${orderId}`);
  }
  return row;
}

const dialog = () => screen.getByRole('dialog', { name: 'Cancel this order?' });
const reasonSelect = () => within(dialog()).getByRole('combobox', { name: /Reason/ });

async function openDialog(orderId = 'order-confirmed-1') {
  fireEvent.click(await screen.findByRole('button', { name: `Cancel order ${orderId}` }));
  return dialog();
}

function confirmWith(reason: string) {
  fireEvent.change(reasonSelect(), { target: { value: reason } });
  fireEvent.click(within(dialog()).getByRole('button', { name: /Yes, cancel order|Try again/ }));
}

/** What the backend answers when `order-confirmed-1` is cancelled by the organization. */
const cancelledRow = cancelledPaidOrgOrder(undefined, { id: 'order-confirmed-1' });

describe('OrganizationOrdersPage — cancellation', () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedCancel.mockReset();
    mockedRunAction.mockReset();
    mockedRetryRefund.mockReset();
    mockedGetOutlets.mockReset();
    mockedGetOutlets.mockResolvedValue({ outlets: orgOutlets });
    FakeIntersectionObserver.install();
  });

  afterEach(() => {
    FakeIntersectionObserver.uninstall();
  });

  describe('who is offered the action', () => {
    it.each(['owner', 'manager'] as const)('offers an %s Cancel order on every cancellable row, and only those', async (role) => {
      mockedList.mockResolvedValue(
        page([
          pendingOrgOrder,
          confirmedOrgOrder,
          preparingOrgOrder,
          readyOrgOrder,
          pickedUpOrgOrder,
          completedOrgOrder,
          customerCancelledUnpaidOrgOrder,
        ]),
      );

      renderPage(role);
      await screen.findByRole('table');

      for (const id of ['order-pending-2', 'order-confirmed-1', 'order-preparing-5', 'order-ready-6']) {
        expect(within(rowOf(id)).getByRole('button', { name: `Cancel order ${id}` })).toBeInTheDocument();
      }
      for (const id of ['order-picked-up-7', 'order-completed-8', 'order-cancelled-unpaid-10']) {
        expect(within(rowOf(id)).queryByRole('button', { name: /Cancel order/ })).not.toBeInTheDocument();
      }
    });

    it('gives staff no cancellation control anywhere, but still the fulfilment actions', async () => {
      mockedList.mockResolvedValue(page([pendingOrgOrder, confirmedOrgOrder, preparingOrgOrder, readyOrgOrder]));

      renderPage('staff');
      await screen.findByRole('table');

      expect(screen.queryByRole('button', { name: /Cancel order/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Start preparing/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
    });
  });

  describe('the dialog', () => {
    it('opens for the chosen order with its context, and sends nothing until confirmed', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder, preparingOrgOrder]));
      renderPage();

      const opened = await openDialog('order-preparing-5');

      expect(within(opened).getByText('#order-preparing-5')).toBeInTheDocument();
      expect(within(opened).getByText('Preparation has already started on this order.')).toBeInTheDocument();
      expect(mockedCancel).not.toHaveBeenCalled();
    });

    it('"Keep order" closes it without a request and gives focus back to the Cancel order button', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      renderPage();
      const trigger = await screen.findByRole('button', { name: 'Cancel order order-confirmed-1' });
      trigger.focus();
      fireEvent.click(trigger);

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Keep order' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockedCancel).not.toHaveBeenCalled();
      expect(trigger).toHaveFocus();
    });
  });

  describe('cancelling', () => {
    it('sends the organization, order and chosen reason once, then shows the order as cancelled without reloading', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      mockedCancel.mockResolvedValue(cancelledRow);
      renderPage('manager', 'org-9');

      await openDialog();
      confirmWith('item_unavailable');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockedCancel).toHaveBeenCalledTimes(1);
      expect(mockedCancel).toHaveBeenCalledWith('org-9', 'order-confirmed-1', 'item_unavailable');
      const row = rowOf('order-confirmed-1');
      expect(within(row).getByText('Cancelled')).toBeInTheDocument();
      expect(row).toHaveTextContent('Cancelled by your team');
      expect(within(row).getByText('Refund pending')).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: /Cancel order|Start preparing/ })).not.toBeInTheDocument();
      expect(mockedList).toHaveBeenCalledTimes(1);
    });

    it('announces the result in a status message that takes focus, since the button that opened the dialog is gone', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      mockedCancel.mockResolvedValue(cancelledRow);
      renderPage();

      await openDialog();
      confirmWith('other');

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('Order #order-confirmed-1 was cancelled.');
      expect(status).toHaveFocus();
    });

    it('cancels an unpaid order, which has no refund to show', async () => {
      mockedList.mockResolvedValue(page([pendingOrgOrder]));
      mockedCancel.mockResolvedValue({ ...customerCancelledUnpaidOrgOrder, id: 'order-pending-2' });
      renderPage();

      const opened = await openDialog('order-pending-2');
      expect(within(opened).queryByText(/full refund of the eligible amount/)).not.toBeInTheDocument();
      confirmWith('duplicate_order');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(within(rowOf('order-pending-2')).getByText('Cancelled')).toBeInTheDocument();
      expect(within(rowOf('order-pending-2')).queryByText(/refund/i)).not.toBeInTheDocument();
    });

    it('does not send a request without a reason', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      renderPage();

      await openDialog();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Yes, cancel order' }));

      expect(mockedCancel).not.toHaveBeenCalled();
      expect(within(dialog()).getByRole('alert')).toHaveTextContent('Choose a reason');
    });

    it('sends one request for repeated presses, keeps the dialog open and busy meanwhile, and cannot be dismissed', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      const request = deferred<OrganizationOrderSummary>();
      mockedCancel.mockReturnValue(request.promise);
      renderPage();

      await openDialog();
      confirmWith('outlet_closed');
      const busy = await within(dialog()).findByRole('button', { name: 'Cancelling…' });
      fireEvent.click(busy);
      fireEvent.click(busy);
      fireEvent.keyDown(dialog(), { key: 'Escape' });

      expect(mockedCancel).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(within(rowOf('order-confirmed-1')).getByRole('button', { name: /Cancel order/ })).toBeDisabled();

      request.resolve(cancelledRow);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockedCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the backend refuses or fails', () => {
    it('on a 409 (it moved on): closes the dialog, re-reads the list, shows the real state and does NOT claim success', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedCancel.mockRejectedValue(new ApiError(409, 'conflict', 'raw'));
      // Someone else already handed it over.
      mockedList.mockResolvedValueOnce(page([{ ...pickedUpOrgOrder, id: 'order-confirmed-1' }]));
      renderPage();

      await openDialog();
      confirmWith('other');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(within(rowOf('order-confirmed-1')).getByText('Picked up')).toBeInTheDocument());
      const alert = within(rowOf('order-confirmed-1')).getByRole('alert');
      expect(alert).toHaveTextContent('can no longer be cancelled');
      expect(alert).toHaveTextContent('The list has been refreshed.');
      expect(screen.queryByText(/was cancelled\./)).not.toBeInTheDocument();
      expect(within(rowOf('order-confirmed-1')).queryByText('Cancelled')).not.toBeInTheDocument();
      expect(mockedCancel).toHaveBeenCalledTimes(1);
    });

    it('on a 409 where another manager cancelled it first: shows it cancelled, with the refund the other cancellation started', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedCancel.mockRejectedValue(new ApiError(409, 'conflict', 'raw'));
      mockedList.mockResolvedValueOnce(page([cancelledRow]));
      renderPage();

      await openDialog();
      confirmWith('other');

      await waitFor(() => expect(within(rowOf('order-confirmed-1')).getByText('Cancelled')).toBeInTheDocument());
      expect(within(rowOf('order-confirmed-1')).getByText('Refund pending')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('on a 403: says the member may not cancel, in a permission-safe message, and refreshes', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      mockedCancel.mockRejectedValue(new ApiError(403, 'permission_denied', 'internal role detail'));
      renderPage();

      await openDialog();
      confirmWith('other');

      const alert = await within(rowOf('order-confirmed-1')).findByRole('alert');
      expect(alert).toHaveTextContent("You don't have permission to cancel orders.");
      expect(document.body).not.toHaveTextContent('internal role detail');
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    });

    it('on a 404: says the order could not be found and refreshes', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedCancel.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
      mockedList.mockResolvedValueOnce(page([]));
      renderPage();

      await openDialog();
      confirmWith('other');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
      expect(await screen.findByText('No orders yet')).toBeInTheDocument();
    });

    it('on a 503: keeps the dialog and the chosen reason, says nothing was cancelled, does not repeat on its own, and a deliberate retry works', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      mockedCancel.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      mockedCancel.mockResolvedValueOnce(cancelledRow);
      renderPage();

      await openDialog();
      confirmWith('cannot_fulfil_in_time');

      expect(await within(dialog()).findByRole('alert')).toHaveTextContent('The order was not cancelled');
      expect(reasonSelect()).toHaveValue('cannot_fulfil_in_time');
      expect(mockedCancel).toHaveBeenCalledTimes(1);
      expect(mockedList).toHaveBeenCalledTimes(1);

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockedCancel).toHaveBeenCalledTimes(2);
      expect(mockedCancel).toHaveBeenLastCalledWith('org-1', 'order-confirmed-1', 'cannot_fulfil_in_time');
      expect(within(rowOf('order-confirmed-1')).getByText('Cancelled')).toBeInTheDocument();
    });

    it('on a lost connection: stays open, says the outcome is unknown, and re-reads the list without repeating the cancellation', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      mockedCancel.mockRejectedValue(new TypeError('Failed to fetch'));
      renderPage();

      await openDialog();
      confirmWith('other');

      expect(await within(dialog()).findByRole('alert')).toHaveTextContent('may or may not have been cancelled');
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
      expect(mockedCancel).toHaveBeenCalledTimes(1);
    });

    it('when the lost answer turns out to have cancelled it: the re-read closes the dialog and shows it cancelled', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedCancel.mockRejectedValue(new TypeError('Failed to fetch'));
      mockedList.mockResolvedValueOnce(page([cancelledRow]));
      renderPage();

      await openDialog();
      confirmWith('other');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(within(rowOf('order-confirmed-1')).getByText('Cancelled')).toBeInTheDocument();
      expect(screen.queryByText(/was cancelled\./)).not.toBeInTheDocument();
    });
  });

  describe('concurrent changes while the dialog is open', () => {
    it('closes the dialog and says so when a refresh shows the order can no longer be cancelled', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockResolvedValueOnce(page([{ ...pickedUpOrgOrder, id: 'order-confirmed-1' }]));
      renderPage();
      await openDialog();

      // Behind the dialog, the page is refreshed (a Refresh press / coming back to the tab).
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('status')).toHaveTextContent(
        'Order #order-confirmed-1 changed while you were deciding, so it can no longer be cancelled.',
      );
      expect(within(rowOf('order-confirmed-1')).getByText('Picked up')).toBeInTheDocument();
      expect(mockedCancel).not.toHaveBeenCalled();
    });

    it('closes quietly, with the row showing Cancelled, when another manager cancelled it meanwhile', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockResolvedValueOnce(page([cancelledRow]));
      renderPage();
      await openDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(within(rowOf('order-confirmed-1')).getByText('Cancelled')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('updates the dialog in place when the order moves to a state that can still be cancelled', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockResolvedValueOnce(page([{ ...preparingOrgOrder, id: 'order-confirmed-1' }]));
      renderPage();
      await openDialog();
      fireEvent.change(reasonSelect(), { target: { value: 'outlet_closed' } });

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      expect(await within(dialog()).findByText('Preparation has already started on this order.')).toBeInTheDocument();
      expect(within(dialog()).getByText('Preparing')).toBeInTheDocument();
      expect(reasonSelect()).toHaveValue('outlet_closed');
    });

    it('shows a refund moving to processed when the list is refreshed', async () => {
      mockedList.mockResolvedValueOnce(page([cancelledPaidOrgOrder({ state: 'in_progress', refundedInPaise: 0 })]));
      mockedList.mockResolvedValueOnce(page([cancelledPaidOrgOrder({ state: 'refunded', refundedInPaise: 30000 })]));
      renderPage();
      expect(await screen.findByText('Refund pending')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      expect(await screen.findByText('Refund processed')).toBeInTheDocument();
      expect(screen.queryByText('Refund pending')).not.toBeInTheDocument();
      expect(screen.getByText('₹300 refunded')).toBeInTheDocument();
    });
  });

  describe('refund state on the rows', () => {
    const failed = cancelledPaidOrgOrder({ state: 'attention_required', refundedInPaise: 0 });

    it.each(['owner', 'manager'] as const)('shows an %s the failed refund and a Retry refund control that retries only that order', async (role) => {
      mockedList.mockResolvedValue(page([failed]));
      mockedRetryRefund.mockResolvedValue({ ...failed, refund: { state: 'in_progress', refundedInPaise: 0 } });

      renderPage(role);

      const row = (await screen.findByText(`#${failed.id}`)).closest('tr') as HTMLElement;
      expect(within(row).getByText('Refund failed — attention required')).toBeInTheDocument();
      fireEvent.click(within(row).getByRole('button', { name: `Retry refund, order ${failed.id}` }));

      expect(await within(rowOf(failed.id)).findByText('Refund pending')).toBeInTheDocument();
      expect(mockedRetryRefund).toHaveBeenCalledTimes(1);
      expect(mockedRetryRefund).toHaveBeenCalledWith('org-1', failed.id);
      expect(mockedCancel).not.toHaveBeenCalled();
      expect(mockedRunAction).not.toHaveBeenCalled();
      // The retry control is gone with the failure, and the outcome is announced.
      expect(screen.queryByRole('button', { name: /Retry refund/ })).not.toBeInTheDocument();
      expect(screen.getByText(`A new refund was started for order #${failed.id}.`)).toBeInTheDocument();
    });

    it('sends one request for repeated presses of Retry refund', async () => {
      mockedList.mockResolvedValue(page([failed]));
      const request = deferred<OrganizationOrderSummary>();
      mockedRetryRefund.mockReturnValue(request.promise);
      renderPage();

      const retry = await screen.findByRole('button', { name: `Retry refund, order ${failed.id}` });
      fireEvent.click(retry);
      fireEvent.click(retry);

      await waitFor(() => expect(retry).toBeDisabled());
      expect(mockedRetryRefund).toHaveBeenCalledTimes(1);
      request.resolve({ ...failed, refund: { state: 'in_progress', refundedInPaise: 0 } });
      expect(await within(rowOf(failed.id)).findByText('Refund pending')).toBeInTheDocument();
    });

    it('on a 409 (already retried elsewhere): says so, re-reads the list and shows the real state, without claiming success', async () => {
      mockedList.mockResolvedValueOnce(page([failed]));
      mockedList.mockResolvedValue(page([{ ...failed, refund: { state: 'in_progress', refundedInPaise: 0 } }]));
      mockedRetryRefund.mockRejectedValue(new ApiError(409, 'conflict', 'internal wording'));
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: `Retry refund, order ${failed.id}` }));

      expect(await within(rowOf(failed.id)).findByText('Refund pending')).toBeInTheDocument();
      expect(screen.getByText(/can't be retried right now/)).toBeInTheDocument();
      expect(screen.queryByText(/A new refund was started/)).not.toBeInTheDocument();
      expect(screen.queryByText(/internal wording/)).not.toBeInTheDocument();
    });

    it('on a 503: says the refund was not retried and keeps the control for a deliberate second try', async () => {
      mockedList.mockResolvedValue(page([failed]));
      mockedRetryRefund.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      mockedRetryRefund.mockResolvedValueOnce({ ...failed, refund: { state: 'in_progress', refundedInPaise: 0 } });
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: `Retry refund, order ${failed.id}` }));

      expect(await screen.findByText(/The refund was not retried/)).toBeInTheDocument();
      expect(mockedRetryRefund).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: `Retry refund, order ${failed.id}` }));
      expect(await within(rowOf(failed.id)).findByText('Refund pending')).toBeInTheDocument();
      expect(mockedRetryRefund).toHaveBeenCalledTimes(2);
    });

    it('shows staff the failed refund state, but no retry and no cancellation', async () => {
      mockedList.mockResolvedValue(page([failed, confirmedOrgOrder]));

      renderPage('staff');

      expect(await screen.findByText('Refund failed — attention required')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Retry refund/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Cancel order/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/retry/i)).not.toBeInTheDocument();
      expect(mockedRetryRefund).not.toHaveBeenCalled();
    });

    it('shows a malformed refund block as "status unavailable", never as a state', async () => {
      // The api layer drops a malformed block; the page then sees a cancelled paid order with none.
      mockedList.mockResolvedValue(page([cancelledPaidOrgOrder(null)]));

      renderPage();

      expect(await screen.findByText('Refund status unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Refund processed')).not.toBeInTheDocument();
    });
  });

  describe('privacy', () => {
    it('shows no provider identifier, internal status name or audit field, however the row arrives', async () => {
      const noisy = {
        ...cancelledPaidOrgOrder({ state: 'attention_required', refundedInPaise: 0 }),
        providerRefundId: 'rfnd_ABC123',
        providerPaymentId: 'pay_XYZ789',
        webhookEventId: 'evt_555',
        cancelledBy: 'U-secret-actor',
        cancellationReason: 'item_unavailable',
        userId: 'U-customer',
      } as OrganizationOrderSummary;
      mockedList.mockResolvedValue(page([noisy]));

      renderPage();
      await screen.findByRole('table');

      const text = document.body.textContent ?? '';
      for (const forbidden of ['rfnd_', 'pay_XYZ', 'evt_555', 'U-secret-actor', 'U-customer', 'attention_required', 'item_unavailable']) {
        expect(text).not.toContain(forbidden);
      }
    });

    it('only ever asks for, and cancels within, the organization it was given', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));
      mockedCancel.mockResolvedValue(cancelledRow);
      renderPage('owner', 'org-7');

      await openDialog();
      confirmWith('other');

      await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith('org-7', 'order-confirmed-1', 'other'));
      expect(mockedList).toHaveBeenCalledWith('org-7', expect.anything());
    });
  });
});

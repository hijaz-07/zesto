import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOutlets } from '../../features/outlet/api';
import type { OrganizationMemberRole } from '../../domain/types';
import { listOrganizationOrders, runFulfillmentAction } from '../../features/organizationOrder/api';
import type {
  OrganizationOrdersPage as OrdersPage,
  OrganizationOrderSummary,
} from '../../features/organizationOrder/types';
import { ApiError } from '../../lib/api/client';
import { FakeIntersectionObserver } from '../../test/fakeIntersectionObserver';
import {
  cancelledOrgOrder,
  completedOrgOrder,
  confirmedOrgOrder,
  longOrgOrder,
  manyOrgOrders,
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
const mockedRunAction = vi.mocked(runFulfillmentAction);
const mockedGetOutlets = vi.mocked(getOutlets);

function page(orders: OrdersPage['orders'], nextCursor: string | null = null): OrdersPage {
  return { orders, nextCursor };
}

/** A promise the test settles by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Any button but 'Cancel order': an owner or manager also gets that one, and these assertions are about fulfilment actions. */
const NOT_CANCEL = /^(?!Cancel order)/;

function renderPage(organizationId = 'org-1', role: OrganizationMemberRole = 'owner') {
  return render(
    <MemoryRouter initialEntries={['/org/orders']}>
      <OrganizationOrdersPage organizationId={organizationId} role={role} />
    </MemoryRouter>,
  );
}

/** The table row of the order with this id. */
function rowOf(orderId: string): HTMLElement {
  const row = screen.getByText(`#${orderId}`).closest('tr');
  if (!row) {
    throw new Error(`no row for ${orderId}`);
  }
  return row;
}

function filter() {
  return screen.getByRole('combobox', { name: 'Outlet' }) as HTMLSelectElement;
}

/** The body rows of the orders table (the header row is excluded). */
function bodyRows() {
  return screen.getAllByRole('row').slice(1);
}

describe('OrganizationOrdersPage', () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRunAction.mockReset();
    mockedGetOutlets.mockReset();
    mockedGetOutlets.mockResolvedValue({ outlets: orgOutlets });
    FakeIntersectionObserver.install();
  });

  afterEach(() => {
    FakeIntersectionObserver.uninstall();
  });

  it('shows the Orders heading', async () => {
    mockedList.mockResolvedValue(page([confirmedOrgOrder]));

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeInTheDocument();
    await screen.findByRole('table');
  });

  it('shows a loading state while the first page is being fetched', () => {
    mockedList.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading orders…');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('asks the backend for the first page of the given organization, with only a page-size hint', async () => {
    mockedList.mockResolvedValue(page([]));

    renderPage('org-7');

    await screen.findByText('No orders yet');
    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList).toHaveBeenCalledWith('org-7', { outletId: undefined, limit: 20 });
  });

  describe('empty state', () => {
    it('shows an empty state for an organization with no orders', async () => {
      mockedList.mockResolvedValue(page([]));

      renderPage();

      expect(await screen.findByText('No orders yet')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });
  });

  describe('error states', () => {
    it('shows the failure with a Try again that loads the page', async () => {
      mockedList.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

      renderPage();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't load orders");
      expect(alert).toHaveTextContent('Zesto is temporarily unavailable. Please try again in a moment.');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('table')).toBeInTheDocument();
      expect(mockedList).toHaveBeenCalledTimes(2);
    });

    it('shows a network failure as a generic, retryable message', async () => {
      mockedList.mockRejectedValue(new TypeError('Failed to fetch'));

      renderPage();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong. Please check your connection and try again.');
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('shows a 403 as an access problem, with no table and nothing to retry', async () => {
      mockedList.mockRejectedValue(new ApiError(403, 'permission_denied', 'You do not have access to this organization.'));

      renderPage();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("You don't have access to these orders");
      expect(alert).toHaveTextContent("You don't have access to this organization's orders.");
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(mockedList).toHaveBeenCalledTimes(1);
    });

    it('shows an expired session as such', async () => {
      mockedList.mockRejectedValue(new ApiError(401, 'unauthenticated', 'x'));

      renderPage();

      expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired. Please sign in again.');
    });
  });

  describe('orders table', () => {
    it('renders every order, in the order the backend returned them (newest first)', async () => {
      mockedList.mockResolvedValue(page([cancelledOrgOrder, pendingOrgOrder, confirmedOrgOrder]));

      renderPage();

      await screen.findByRole('table');
      const rows = bodyRows();
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent('#order-cancelled-3');
      expect(rows[1]).toHaveTextContent('#order-pending-2');
      expect(rows[2]).toHaveTextContent('#order-confirmed-1');
    });

    it('shows each order\'s outlet, menu, item summary, total, payment and status', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));

      renderPage();

      await screen.findByRole('table');
      const cells = within(bodyRows()[0]).getAllByRole('cell');
      expect(cells[1]).toHaveTextContent('Main Canteen');
      expect(cells[2]).toHaveTextContent('Tuesday Special Menu');
      expect(within(cells[4]).getByText('Chicken Biriyani × 2')).toBeInTheDocument();
      expect(cells[5]).toHaveTextContent('₹300');
      expect(cells[6]).toHaveTextContent('Paid');
      expect(cells[7]).toHaveTextContent('Confirmed');
    });

    it('shows pending_payment, confirmed and cancelled orders alike, each with its own badges', async () => {
      mockedList.mockResolvedValue(page([pendingOrgOrder, confirmedOrgOrder, cancelledOrgOrder]));

      renderPage();

      await screen.findByRole('table');
      const badgesOf = (row: HTMLElement) => {
        const cells = within(row).getAllByRole('cell');
        return [cells[6].textContent, cells[7].textContent];
      };
      const rows = bodyRows();
      expect(badgesOf(rows[0])).toEqual(['Pending', 'Payment pending']);
      expect(badgesOf(rows[1])).toEqual(['Paid', 'Confirmed']);
      expect(badgesOf(rows[2])).toEqual(['Unpaid', 'Cancelled']);
    });

    it('summarizes an order with more lines than fit', async () => {
      mockedList.mockResolvedValue(page([longOrgOrder]));

      renderPage();

      await screen.findByRole('table');
      const items = within(bodyRows()[0]).getAllByRole('cell')[4];
      expect(within(items).getByText('Dish 10 × 2')).toBeInTheDocument();
      expect(within(items).getByText('+3 more')).toBeInTheDocument();
    });

    it('shows no customer identity columns', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));

      renderPage();

      await screen.findByRole('table');
      for (const name of [/customer/i, /phone/i, /e-?mail/i, /user/i]) {
        expect(screen.queryByRole('columnheader', { name })).not.toBeInTheDocument();
      }
    });
  });

  describe('outlet filter', () => {
    it('starts on All outlets and lists the organization\'s outlets — including a deactivated one', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));

      renderPage();

      await waitFor(() => expect(filter()).not.toBeDisabled());
      expect(filter().value).toBe('');
      expect(within(filter()).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'All outlets',
        'Main Canteen',
        'Hostel Café',
        'Old Annex (inactive)',
      ]);
    });

    it('is disabled while the outlets load, and the orders do not wait for it', async () => {
      mockedGetOutlets.mockReturnValue(new Promise(() => {}));
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));

      renderPage();

      expect(filter()).toBeDisabled();
      expect(await screen.findByRole('table')).toBeInTheDocument();
    });

    it('still lists orders, with the filter unavailable, when the outlets cannot be loaded', async () => {
      mockedGetOutlets.mockRejectedValue(new ApiError(503, 'unavailable', 'down'));
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));

      renderPage();

      expect(await screen.findByRole('table')).toBeInTheDocument();
      await waitFor(() => expect(mockedGetOutlets).toHaveBeenCalled());
      expect(filter()).toBeDisabled();
    });

    it('requests only the chosen outlet and shows loading, not the previous rows, while it loads', async () => {
      let resolveFiltered!: (value: OrdersPage) => void;
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder, pendingOrgOrder]));
      mockedList.mockReturnValueOnce(new Promise((resolve) => {
        resolveFiltered = resolve;
      }));

      renderPage();
      await screen.findByRole('table');
      await waitFor(() => expect(filter()).not.toBeDisabled());

      fireEvent.change(filter(), { target: { value: 'outlet-2' } });

      expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: 'outlet-2', limit: 20 });
      expect(screen.getByRole('status')).toHaveTextContent('Loading orders…');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();

      await act(async () => resolveFiltered(page([pendingOrgOrder])));

      expect(bodyRows()).toHaveLength(1);
      expect(bodyRows()[0]).toHaveTextContent('#order-pending-2');
      expect(filter().value).toBe('outlet-2');
    });

    it('can select a deactivated outlet to read its history', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockResolvedValueOnce(page([cancelledOrgOrder]));

      renderPage();
      await screen.findByRole('table');
      await waitFor(() => expect(filter()).not.toBeDisabled());
      fireEvent.change(filter(), { target: { value: 'outlet-3' } });

      expect(await screen.findByText('#order-cancelled-3')).toBeInTheDocument();
      expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: 'outlet-3', limit: 20 });
    });

    it('goes back to every outlet when All outlets is chosen again, with no outlet in the request', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockResolvedValueOnce(page([pendingOrgOrder]));
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder, pendingOrgOrder]));

      renderPage();
      await screen.findByRole('table');
      await waitFor(() => expect(filter()).not.toBeDisabled());
      fireEvent.change(filter(), { target: { value: 'outlet-2' } });
      await screen.findByText('#order-pending-2');
      fireEvent.change(filter(), { target: { value: '' } });

      await waitFor(() => expect(bodyRows()).toHaveLength(2));
      expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20 });
    });

    it('says so, and offers to show every outlet, when the chosen outlet has no orders', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockResolvedValueOnce(page([]));
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

      renderPage();
      await screen.findByRole('table');
      await waitFor(() => expect(filter()).not.toBeDisabled());
      fireEvent.change(filter(), { target: { value: 'outlet-2' } });

      expect(await screen.findByText('No orders for this outlet')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show all outlets' }));

      expect(await screen.findByRole('table')).toBeInTheDocument();
      expect(filter().value).toBe('');
      expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20 });
    });

    it('carries the chosen outlet into Load more and Refresh', async () => {
      mockedList.mockResolvedValueOnce(page([]));
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(1, 'b'), null));
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));

      renderPage();
      await screen.findByText('No orders yet');
      await waitFor(() => expect(filter()).not.toBeDisabled());
      fireEvent.change(filter(), { target: { value: 'outlet-1' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(bodyRows()).toHaveLength(3));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(4));

      expect(mockedList).toHaveBeenNthCalledWith(3, 'org-1', { outletId: 'outlet-1', limit: 20, cursor: 'cursor-1' });
      expect(mockedList).toHaveBeenNthCalledWith(4, 'org-1', { outletId: 'outlet-1', limit: 20 });
    });
  });

  describe('pagination', () => {
    it('shows Load more only when the backend reports another page', async () => {
      mockedList.mockResolvedValue(page(manyOrgOrders(3), null));

      renderPage();

      await screen.findByRole('table');
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('loads the next page with the backend\'s cursor and appends it', async () => {
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'b'), null));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      await waitFor(() => expect(bodyRows()).toHaveLength(4));
      expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20, cursor: 'cursor-1' });
      expect(bodyRows().map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
        '#a-1',
        '#a-2',
        '#b-1',
        '#b-2',
      ]);
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('disables the button while a page is loading, so a second tap cannot fetch it twice', async () => {
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(1, 'a'), 'cursor-1'));
      mockedList.mockReturnValueOnce(new Promise(() => {}));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      const loading = await screen.findByRole('button', { name: 'Loading…' });
      expect(loading).toBeDisabled();
      expect(loading).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(loading);
      expect(mockedList).toHaveBeenCalledTimes(2);
    });

    it('keeps the rows already loaded when a later page fails, and offers Try again', async () => {
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
      mockedList.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(1, 'b'), null));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Zesto is temporarily unavailable.');
      expect(bodyRows()).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(bodyRows()).toHaveLength(3));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    describe('when access is lost while the page is open (Load more is refused with a 403)', () => {
      const forbidden = new ApiError(403, 'permission_denied', 'You do not have access to this organization.');

      it('replaces the visible orders with the access-denied state: no stale rows, cursor or Load more remain', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder, pendingOrgOrder], 'cursor-1'));
        mockedList.mockRejectedValueOnce(forbidden);

        renderPage();

        // 1. Orders are initially visible, with another page on offer.
        await screen.findByRole('table');
        expect(bodyRows()).toHaveLength(2);
        expect(screen.getByText('#order-confirmed-1')).toBeInTheDocument();
        expect(screen.getByText('#order-pending-2')).toBeInTheDocument();

        // 2. Load more returns 403.
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

        // 4. The access-denied state appears — the same one an initial 403 shows.
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("You don't have access to these orders");
        expect(alert).toHaveTextContent("You don't have access to this organization's orders.");
        // 3 + 6. The existing rows are gone and no order cell remains.
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.queryAllByRole('row')).toHaveLength(0);
        expect(screen.queryAllByRole('cell')).toHaveLength(0);
        expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
        expect(screen.queryByText('#order-confirmed-1')).not.toBeInTheDocument();
        expect(screen.queryByText('#order-pending-2')).not.toBeInTheDocument();
        expect(screen.queryByText('Chicken Biriyani × 2')).not.toBeInTheDocument();
        // 5. The Load more state is reset: no button (spinner or retry), and no inline error under a list.
        expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Loading…' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('alert')).toHaveLength(1);
        // Nothing was asked for beyond the one page and the refused one.
        expect(mockedList).toHaveBeenCalledTimes(2);
        expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20, cursor: 'cursor-1' });
      });

      it('clears every page loaded so far when a later Load more is the refused one', async () => {
        mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
        mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'b'), 'cursor-2'));
        mockedList.mockRejectedValueOnce(forbidden);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
        await waitFor(() => expect(bodyRows()).toHaveLength(4));
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

        expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to these orders");
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.queryByText('#a-1')).not.toBeInTheDocument();
        expect(screen.queryByText('#b-2')).not.toBeInTheDocument();
      });

      it('still lets Refresh ask again, and shows the orders once access is back', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder], 'cursor-1'));
        mockedList.mockRejectedValueOnce(forbidden);
        mockedList.mockResolvedValueOnce(page([pendingOrgOrder], null));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
        // First the denied state, with the old rows gone...
        expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to these orders");
        expect(screen.queryByText('#order-confirmed-1')).not.toBeInTheDocument();

        // ...then Refresh asks again and recovers.
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('#order-pending-2')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
      });
    });

    it.each([
      ['a 500', new ApiError(500, 'internal', 'Something broke on our side.'), 'Something broke on our side.'],
      ['a 401', new ApiError(401, 'unauthenticated', 'x'), 'Your session has expired. Please sign in again.'],
      ['a 404', new ApiError(404, 'not_found', 'x'), "That outlet couldn't be found."],
      ['a network failure', new TypeError('Failed to fetch'), 'Something went wrong. Please check your connection and try again.'],
    ])('leaves %s on Load more as it was: the rows stay, with the error and Try again', async (_label, failure, message) => {
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
      mockedList.mockRejectedValueOnce(failure);
      mockedList.mockResolvedValueOnce(page(manyOrgOrders(1, 'b'), null));

      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(bodyRows()).toHaveLength(2);
      expect(screen.queryByText("You don't have access to these orders")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(bodyRows()).toHaveLength(3));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('refresh', () => {
    it('re-fetches the first page when Refresh is pressed, keeping the list until the new one lands', async () => {
      let resolveFresh!: (value: OrdersPage) => void;
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockReturnValueOnce(new Promise((resolve) => {
        resolveFresh = resolve;
      }));

      renderPage();
      await screen.findByRole('table');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      const refreshing = await screen.findByRole('button', { name: 'Refreshing…' });
      expect(refreshing).toBeDisabled();
      expect(bodyRows()).toHaveLength(1);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      await act(async () => resolveFresh(page([pendingOrgOrder, confirmedOrgOrder])));

      expect(bodyRows()).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
      expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20 });
    });

    it('keeps the list and says the refresh failed', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));

      renderPage();
      await screen.findByRole('table');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't refresh. Showing the orders loaded earlier.");
      expect(bodyRows()).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    });

    describe('when access is lost while the page is open (the refresh is refused with a 403)', () => {
      const forbidden = new ApiError(403, 'permission_denied', 'You do not have access to this organization.');

      it('replaces the visible orders with the access-denied state: no stale rows remain', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder, pendingOrgOrder], 'cursor-1'));
        mockedList.mockRejectedValueOnce(forbidden);

        renderPage();

        // 1. Orders are initially visible.
        await screen.findByRole('table');
        expect(bodyRows()).toHaveLength(2);
        expect(screen.getByText('#order-confirmed-1')).toBeInTheDocument();
        expect(screen.getByText('#order-pending-2')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();

        // 2. Refresh returns 403.
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        // 4. The access-denied state appears — the same one an initial 403 shows.
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("You don't have access to these orders");
        expect(alert).toHaveTextContent("You don't have access to this organization's orders.");
        // 3 + 5. The previous rows are gone and nothing stale remains.
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.queryAllByRole('row')).toHaveLength(0);
        expect(screen.queryByText('#order-confirmed-1')).not.toBeInTheDocument();
        expect(screen.queryByText('#order-pending-2')).not.toBeInTheDocument();
        expect(screen.queryByText('Chicken Biriyani × 2')).not.toBeInTheDocument();
        // (Not matched by outlet name: "Main Canteen" is also an <option> in the still-present outlet filter.)
        expect(screen.queryAllByRole('cell')).toHaveLength(0);
        expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
        // Pagination is reset too, and the small "couldn't refresh" alert is not used for this case.
        expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Couldn't refresh/)).not.toBeInTheDocument();
        // The existing 403 design has no retry.
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        expect(mockedList).toHaveBeenCalledTimes(2);
      });

      it('does the same when the refresh is the one triggered by coming back to the page', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder], null));
        mockedList.mockRejectedValueOnce(forbidden);

        renderPage();
        await screen.findByRole('table');
        const observer = FakeIntersectionObserver.live()[0];
        act(() => observer.emit(false));
        act(() => observer.emit(true));

        expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to these orders");
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.queryByText('#order-confirmed-1')).not.toBeInTheDocument();
      });

      it('still lets Refresh ask again, and shows the orders once access is back', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder], null));
        mockedList.mockRejectedValueOnce(forbidden);
        mockedList.mockResolvedValueOnce(page([pendingOrgOrder], null));

        renderPage();
        await screen.findByRole('table');
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await screen.findByRole('alert');

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('#order-pending-2')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      it('leaves the other failures as they were: a 500 on refresh keeps the rows and says it could not refresh', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder], null));
        mockedList.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));

        renderPage();
        await screen.findByRole('table');
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't refresh. Showing the orders loaded earlier.");
        expect(bodyRows()).toHaveLength(1);
        expect(screen.getByText('#order-confirmed-1')).toBeInTheDocument();
      });

      it('leaves a network failure on refresh as it was: the rows stay', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder], null));
        mockedList.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        renderPage();
        await screen.findByRole('table');
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't refresh. Showing the orders loaded earlier.");
        expect(bodyRows()).toHaveLength(1);
      });
    });

    it('is not available while the first page is still loading', () => {
      mockedList.mockReturnValue(new Promise(() => {}));

      renderPage();

      expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    });

    it('refreshes when the page becomes visible again, but not when it was visible from the start', async () => {
      mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
      mockedList.mockResolvedValueOnce(page([pendingOrgOrder, confirmedOrgOrder]));

      renderPage();
      await screen.findByRole('table');
      const observer = FakeIntersectionObserver.live()[0];

      act(() => observer.emit(true));
      expect(mockedList).toHaveBeenCalledTimes(1);

      act(() => observer.emit(false));
      act(() => observer.emit(true));

      await waitFor(() => expect(bodyRows()).toHaveLength(2));
      expect(mockedList).toHaveBeenCalledTimes(2);
      expect(mockedList).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20 });
    });

    it('fetches nothing on its own: no polling, no listener — one request until asked again', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));

      renderPage();
      await screen.findByRole('table');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(mockedList).toHaveBeenCalledTimes(1);
    });

    it('stops observing visibility when the page goes away', async () => {
      mockedList.mockResolvedValue(page([confirmedOrgOrder]));

      const { unmount } = renderPage();
      await screen.findByRole('table');
      expect(FakeIntersectionObserver.live()).toHaveLength(1);

      unmount();

      expect(FakeIntersectionObserver.live()).toHaveLength(0);
    });
  });

  describe('fulfillment actions', () => {
    /** A promise the test settles by hand, to hold a request in flight. */
    function pendingAction() {
      let resolve!: (order: OrganizationOrderSummary) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<OrganizationOrderSummary>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      mockedRunAction.mockReturnValueOnce(promise);
      return { resolve, reject };
    }

    // What the backend answers when `order-confirmed-1` is started: the same order, now preparing.
    const startedOrder: OrganizationOrderSummary = { ...preparingOrgOrder, id: confirmedOrgOrder.id };

    describe('which rows offer a button', () => {
      it('offers "Start preparing" on a confirmed order and "Mark ready" on a preparing one, and nothing else', async () => {
        mockedList.mockResolvedValue(
          page([confirmedOrgOrder, preparingOrgOrder, readyOrgOrder, pendingOrgOrder, cancelledOrgOrder]),
        );

        renderPage();
        await screen.findByRole('table');

        expect(within(rowOf('order-confirmed-1')).getByRole('button', { name: /Start preparing/ })).toBeInTheDocument();
        expect(within(rowOf('order-preparing-5')).getByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
        for (const id of ['order-ready-6', 'order-pending-2', 'order-cancelled-3']) {
          expect(within(rowOf(id)).queryByRole('button', { name: NOT_CANCEL })).not.toBeInTheDocument();
        }
        expect(screen.getAllByRole('button', { name: /Start preparing|Mark ready/ })).toHaveLength(2);
      });

      it.each(['owner', 'manager', 'staff'] as const)('shows the Action column to an %s', async (role) => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder]));

        renderPage('org-1', role);
        await screen.findByRole('table');

        expect(screen.getByRole('columnheader', { name: 'Action' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Start preparing/ })).toBeInTheDocument();
      });

      it('shows no Action column and no buttons to a role it does not know (the backend still decides)', async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder, preparingOrgOrder]));

        renderPage('org-1', 'visitor' as unknown as OrganizationMemberRole);
        await screen.findByRole('table');

        expect(screen.queryByRole('columnheader', { name: 'Action' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Start preparing|Mark ready/ })).not.toBeInTheDocument();
        expect(screen.getAllByRole('columnheader')).toHaveLength(8);
      });

      it('shows no buttons while loading, or when access to the orders is denied', async () => {
        mockedList.mockRejectedValue(new ApiError(403, 'permission_denied', 'No.'));

        renderPage();

        await screen.findByRole('alert');
        expect(screen.queryByRole('button', { name: /Start preparing|Mark ready/ })).not.toBeInTheDocument();
      });
    });

    describe('Start preparing', () => {
      it('asks the backend for exactly that order and action, and nothing else', async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder]));
        mockedRunAction.mockResolvedValue(startedOrder);

        renderPage('org-9');
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        await waitFor(() => expect(mockedRunAction).toHaveBeenCalledTimes(1));
        expect(mockedRunAction).toHaveBeenCalledWith('org-9', 'order-confirmed-1', 'start-preparing');
      });

      it('disables the button while the request is pending, and ignores a second press', async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder]));
        const action = pendingAction();

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        const busy = await screen.findByRole('button', { name: /Starting…/ });
        expect(busy).toBeDisabled();
        fireEvent.click(busy);
        expect(mockedRunAction).toHaveBeenCalledTimes(1);

        action.resolve(startedOrder);
        await screen.findByRole('button', { name: /Mark ready/ });
      });

      it("updates the row from the backend's answer: it becomes Preparing and offers Mark ready, without re-listing", async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder, pendingOrgOrder]));
        mockedRunAction.mockResolvedValue(startedOrder);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        await waitFor(() => expect(within(rowOf('order-confirmed-1')).getByText('Preparing')).toBeInTheDocument());
        expect(within(rowOf('order-confirmed-1')).getByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
        expect(within(rowOf('order-pending-2')).getByText('Payment pending')).toBeInTheDocument();
        expect(mockedList).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      it('treats an already-done repeat (the backend answering 200 with the same state) like any success', async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder]));
        mockedRunAction.mockResolvedValue(startedOrder);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        expect(await screen.findByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
        expect(within(rowOf('order-confirmed-1')).getByText('Preparing')).toBeInTheDocument();
      });
    });

    describe('Mark ready', () => {
      const alreadyPreparing = page([preparingOrgOrder]);

      it('does not ask the backend until the confirmation is accepted', async () => {
        mockedList.mockResolvedValue(alreadyPreparing);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Mark ready/ }));

        expect(screen.getByText('Mark this order ready?')).toBeInTheDocument();
        expect(screen.getByText("The customer will see it as ready for pickup. This can't be undone.")).toBeInTheDocument();
        expect(mockedRunAction).not.toHaveBeenCalled();
      });

      it('sends nothing if the confirmation is cancelled', async () => {
        mockedList.mockResolvedValue(alreadyPreparing);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Mark ready/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(mockedRunAction).not.toHaveBeenCalled();
        expect(screen.queryByText('Mark this order ready?')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
      });

      it('asks the backend once confirmed, disables the buttons meanwhile, then shows the order as Ready with no action', async () => {
        mockedList.mockResolvedValue(alreadyPreparing);
        const action = pendingAction();

        renderPage('org-9');
        fireEvent.click(await screen.findByRole('button', { name: /Mark ready/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Yes, mark ready' }));

        expect(mockedRunAction).toHaveBeenCalledWith('org-9', 'order-preparing-5', 'mark-ready');
        expect(await screen.findByRole('button', { name: 'Marking ready…' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

        action.resolve({ ...readyOrgOrder, id: 'order-preparing-5' });

        await waitFor(() => expect(within(rowOf('order-preparing-5')).getByText('Ready')).toBeInTheDocument());
        expect(within(rowOf('order-preparing-5')).queryByRole('button', { name: NOT_CANCEL })).not.toBeInTheDocument();
        expect(screen.queryByText('Mark this order ready?')).not.toBeInTheDocument();
      });
    });

    describe('pickup and completion on the rows', () => {
      const pickedUp = page([pickedUpOrgOrder]);
      const completedRow = { ...completedOrgOrder, id: 'order-picked-up-7' };

      it('says "Awaiting pickup" on a ready order, offers "Mark completed" on a picked-up one and nothing on a completed one', async () => {
        mockedList.mockResolvedValue(
          page([confirmedOrgOrder, preparingOrgOrder, readyOrgOrder, pickedUpOrgOrder, completedOrgOrder]),
        );

        renderPage();
        await screen.findByRole('table');

        expect(within(rowOf('order-ready-6')).getByText('Awaiting pickup')).toBeInTheDocument();
        expect(within(rowOf('order-ready-6')).queryByRole('button', { name: NOT_CANCEL })).not.toBeInTheDocument();
        expect(within(rowOf('order-picked-up-7')).getByRole('button', { name: /Mark completed/ })).toBeInTheDocument();
        expect(within(rowOf('order-completed-8')).queryByRole('button')).not.toBeInTheDocument();
        expect(within(rowOf('order-completed-8')).queryByText('Awaiting pickup')).not.toBeInTheDocument();
        // The earlier steps are untouched, and nothing else gained a button.
        expect(within(rowOf('order-confirmed-1')).getByRole('button', { name: /Start preparing/ })).toBeInTheDocument();
        expect(within(rowOf('order-preparing-5')).getByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Start preparing|Mark ready|Mark completed/ })).toHaveLength(3);
      });

      it('shows each new status as its own badge', async () => {
        mockedList.mockResolvedValue(page([readyOrgOrder, pickedUpOrgOrder, completedOrgOrder]));

        renderPage();
        await screen.findByRole('table');

        expect(within(rowOf('order-picked-up-7')).getByText('Picked up')).toBeInTheDocument();
        expect(within(rowOf('order-completed-8')).getByText('Completed')).toBeInTheDocument();
      });

      it('"Mark completed" asks the backend for exactly that order and the complete action, with no confirmation', async () => {
        mockedList.mockResolvedValue(pickedUp);
        mockedRunAction.mockResolvedValue(completedRow);

        renderPage('org-9');
        fireEvent.click(await screen.findByRole('button', { name: /Mark completed/ }));

        await waitFor(() => expect(mockedRunAction).toHaveBeenCalledTimes(1));
        expect(mockedRunAction).toHaveBeenCalledWith('org-9', 'order-picked-up-7', 'complete');
        expect(screen.queryByRole('group')).not.toBeInTheDocument();
      });

      it("updates the row from the backend's answer: it becomes Completed with no action, without re-listing", async () => {
        mockedList.mockResolvedValue(pickedUp);
        mockedRunAction.mockResolvedValue(completedRow);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Mark completed/ }));

        await waitFor(() => expect(within(rowOf('order-picked-up-7')).getByText('Completed')).toBeInTheDocument());
        expect(within(rowOf('order-picked-up-7')).queryByRole('button')).not.toBeInTheDocument();
        expect(mockedList).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      it('disables the button while the request is pending, and ignores a second press', async () => {
        mockedList.mockResolvedValue(pickedUp);
        const action = pendingAction();

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Mark completed/ }));

        const busy = await screen.findByRole('button', { name: /Completing…/ });
        expect(busy).toBeDisabled();
        fireEvent.click(busy);
        expect(mockedRunAction).toHaveBeenCalledTimes(1);

        action.resolve(completedRow);
        await waitFor(() => expect(within(rowOf('order-picked-up-7')).getByText('Completed')).toBeInTheDocument());
      });

      it('on a 409 (someone completed it first): says so, and re-reads the list so the row shows the real state', async () => {
        mockedList.mockResolvedValueOnce(pickedUp);
        mockedRunAction.mockRejectedValue(new ApiError(409, 'conflict', 'x'));
        mockedList.mockResolvedValueOnce(page([completedRow]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Mark completed/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('This order has changed since you loaded it.');
        await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(within(rowOf('order-picked-up-7')).getByText('Completed')).toBeInTheDocument());
        expect(within(rowOf('order-picked-up-7')).queryByRole('button')).not.toBeInTheDocument();
      });

      it('on a 503: keeps the row and the button available to try again, without re-listing', async () => {
        mockedList.mockResolvedValue(pickedUp);
        mockedRunAction.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
        mockedRunAction.mockResolvedValueOnce(completedRow);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Mark completed/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Zesto is temporarily unavailable.');
        expect(mockedList).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: /Mark completed/ }));
        await waitFor(() => expect(within(rowOf('order-picked-up-7')).getByText('Completed')).toBeInTheDocument());
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      it('never offers the handover from a row: no button anywhere hands a ready order over', async () => {
        mockedList.mockResolvedValue(page([readyOrgOrder]));

        renderPage();
        await screen.findByRole('table');

        expect(screen.queryByRole('button', { name: /pick|hand|collect|redeem/i })).not.toBeInTheDocument();
        expect(mockedRunAction).not.toHaveBeenCalled();
      });
    });

    describe('when the backend refuses', () => {
      it('on a 409 (the order moved on): says so, and re-reads the list so the row shows the real state', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(new ApiError(409, 'conflict', 'This order is ready, so it can\'t be moved to preparing.'));
        // Someone else already took it all the way to ready.
        mockedList.mockResolvedValueOnce(page([{ ...readyOrgOrder, id: 'order-confirmed-1' }]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('This order has changed since you loaded it. The list has been refreshed.');
        await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(within(rowOf('order-confirmed-1')).getByText('Ready')).toBeInTheDocument());
        expect(within(rowOf('order-confirmed-1')).queryByRole('button', { name: NOT_CANCEL })).not.toBeInTheDocument();
      });

      it("on a 409 from Mark ready: closes the confirmation and shows the order's real state", async () => {
        mockedList.mockResolvedValueOnce(page([preparingOrgOrder]));
        mockedRunAction.mockRejectedValue(new ApiError(409, 'conflict', 'x'));
        mockedList.mockResolvedValueOnce(page([readyOrgOrder].map((order) => ({ ...order, id: 'order-preparing-5' }))));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Mark ready/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Yes, mark ready' }));

        await waitFor(() => expect(within(rowOf('order-preparing-5')).getByText('Ready')).toBeInTheDocument());
        expect(screen.queryByText('Mark this order ready?')).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('This order has changed since you loaded it.');
      });

      it('on a 404: says the order could not be found and re-reads the list', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(new ApiError(404, 'not_found', 'Order not found.'));
        mockedList.mockResolvedValueOnce(page([]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        await screen.findByText('No orders yet');
        expect(mockedList).toHaveBeenCalledTimes(2);
      });

      it('on a 403: re-reads the list, and when access is really gone shows the access-denied state with no rows or buttons', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder, preparingOrgOrder]));
        mockedRunAction.mockRejectedValue(new ApiError(403, 'permission_denied', 'You do not have access to this organization.'));
        mockedList.mockRejectedValueOnce(new ApiError(403, 'permission_denied', 'You do not have access to this organization.'));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("You don't have access to these orders");
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.queryByText('#order-confirmed-1')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Start preparing|Mark ready/ })).not.toBeInTheDocument();
        expect(mockedList).toHaveBeenCalledTimes(2);
      });

      it('on a 403 when the list is still readable: keeps the rows, and says the person cannot change this order', async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(new ApiError(403, 'permission_denied', 'x'));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to change this order.");
        expect(screen.getByText('#order-confirmed-1')).toBeInTheDocument();
        expect(within(rowOf('order-confirmed-1')).getByText('Confirmed')).toBeInTheDocument();
      });

      it('on a 503: shows the message, does not re-list, leaves the row as it was, and lets the person try again', async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'));
        mockedRunAction.mockResolvedValueOnce(startedOrder);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Zesto is temporarily unavailable.');
        expect(mockedList).toHaveBeenCalledTimes(1);
        expect(within(rowOf('order-confirmed-1')).getByText('Confirmed')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Start preparing/ }));

        await waitFor(() => expect(within(rowOf('order-confirmed-1')).getByText('Preparing')).toBeInTheDocument());
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(mockedRunAction).toHaveBeenCalledTimes(2);
      });

      it('on a network failure: shows a generic message and keeps the button', async () => {
        mockedList.mockResolvedValue(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(new TypeError('Failed to fetch'));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
        expect(screen.getByRole('button', { name: /Start preparing/ })).toBeEnabled();
      });
    });

    describe('Refresh and the authoritative state', () => {
      it("shows the backend's state after Refresh, even where it disagrees with what an action showed", async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockResolvedValue(startedOrder);
        // By the time of the refresh someone has finished the order.
        mockedList.mockResolvedValueOnce(page([{ ...readyOrgOrder, id: 'order-confirmed-1' }]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        await screen.findByRole('button', { name: /Mark ready/ });
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(within(rowOf('order-confirmed-1')).getByText('Ready')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Start preparing|Mark ready/ })).not.toBeInTheDocument();
      });

      it('keeps working across a Refresh that fails: the updated row stays, and its next action is still offered', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockResolvedValue(startedOrder);
        mockedList.mockRejectedValueOnce(new ApiError(500, 'internal', 'Something broke on our side.'));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        await screen.findByRole('button', { name: /Mark ready/ });
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText(/Couldn't refresh/)).toBeInTheDocument();
        expect(within(rowOf('order-confirmed-1')).getByText('Preparing')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Mark ready/ })).toBeInTheDocument();
      });
    });

    describe('a refused action\'s message, once the list is read again', () => {
      const conflict = new ApiError(409, 'conflict', 'x');
      const unavailable = new ApiError(503, 'unavailable', 'x');
      const forbidden = new ApiError(403, 'permission_denied', 'x');
      const rowAlert = (orderId: string) => within(rowOf(orderId)).getByRole('alert');

      it('stays beside the row the refused action itself re-read, but goes when a later Refresh succeeds', async () => {
        const laterRefresh = deferred<OrdersPage>();
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(conflict);
        mockedList.mockResolvedValueOnce(page([{ ...readyOrgOrder, id: 'order-confirmed-1' }]));
        mockedList.mockReturnValueOnce(laterRefresh.promise);

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));

        // The re-read the 409 asked for has landed — and its explanation is still there.
        await waitFor(() => expect(within(rowOf('order-confirmed-1')).getByText('Ready')).toBeInTheDocument());
        expect(rowAlert('order-confirmed-1')).toHaveTextContent('This order has changed since you loaded it.');

        // Pressing Refresh alone does not clear it: only a refresh that succeeds does.
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeInTheDocument();
        expect(rowAlert('order-confirmed-1')).toHaveTextContent('This order has changed since you loaded it.');

        await act(async () => laterRefresh.resolve(page([{ ...readyOrgOrder, id: 'order-confirmed-1' }])));

        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(within(rowOf('order-confirmed-1')).getByText('Ready')).toBeInTheDocument();
      });

      it('goes when access is restored after the refused action turned out to be real access loss', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(forbidden);
        mockedList.mockRejectedValueOnce(forbidden);
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to these orders");

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByRole('button', { name: /Start preparing/ })).toBeEnabled();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByText("You don't have access to change this order.")).not.toBeInTheDocument();
        expect(within(rowOf('order-confirmed-1')).getByText('Confirmed')).toBeInTheDocument();
      });

      it('goes when the list is read again after access was lost and restored by coming back to the page', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(forbidden);
        mockedList.mockRejectedValueOnce(forbidden);
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        await screen.findByText("You don't have access to these orders");
        const observer = FakeIntersectionObserver.live()[0];
        act(() => observer.emit(false));
        act(() => observer.emit(true));

        expect(await screen.findByRole('button', { name: /Start preparing/ })).toBeEnabled();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      it('survives a refresh that fails, and goes when the next one succeeds', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(unavailable);
        mockedList.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        await screen.findByText('Zesto is temporarily unavailable. Please try again in a moment.');

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await screen.findByText(/Couldn't refresh/);
        expect(rowAlert('order-confirmed-1')).toHaveTextContent('Zesto is temporarily unavailable.');

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        expect(screen.getByRole('button', { name: /Start preparing/ })).toBeEnabled();
      });

      it('goes when the page is refreshed by coming back to it', async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(unavailable);
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        await screen.findByRole('alert');
        const observer = FakeIntersectionObserver.live()[0];
        act(() => observer.emit(false));
        act(() => observer.emit(true));

        await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      });

      it("is not shown again by a later visit to the outlet it was raised under", async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(unavailable);
        mockedList.mockResolvedValueOnce(page([pendingOrgOrder]));
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        await screen.findByRole('alert');
        await waitFor(() => expect(filter()).not.toBeDisabled());

        fireEvent.change(filter(), { target: { value: 'outlet-2' } });
        await screen.findByText('#order-pending-2');
        fireEvent.change(filter(), { target: { value: '' } });

        expect(await screen.findByRole('button', { name: /Start preparing/ })).toBeEnabled();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      it("shows a second refusal through the re-read it asked for, after the first one's message was cleared", async () => {
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedRunAction.mockRejectedValue(conflict);
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));
        mockedList.mockResolvedValueOnce(page([confirmedOrgOrder]));

        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: /Start preparing/ }));
        await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
        await screen.findByRole('alert');

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(3));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Start preparing/ }));
        await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(4));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());

        expect(rowAlert('order-confirmed-1')).toHaveTextContent('This order has changed since you loaded it.');
      });
    });
  });
});

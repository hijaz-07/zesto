import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOutlets } from '../../features/outlet/api';
import { listOrganizationOrders } from '../../features/organizationOrder/api';
import type { OrganizationOrdersPage as OrdersPage } from '../../features/organizationOrder/types';
import { ApiError } from '../../lib/api/client';
import { FakeIntersectionObserver } from '../../test/fakeIntersectionObserver';
import {
  cancelledOrgOrder,
  confirmedOrgOrder,
  longOrgOrder,
  manyOrgOrders,
  orgOutlets,
  pendingOrgOrder,
} from '../../test/organizationOrderFixtures';
import { OrganizationOrdersPage } from './OrganizationOrdersPage';

vi.mock('../../features/organizationOrder/api');
vi.mock('../../features/outlet/api');

const mockedList = vi.mocked(listOrganizationOrders);
const mockedGetOutlets = vi.mocked(getOutlets);

function page(orders: OrdersPage['orders'], nextCursor: string | null = null): OrdersPage {
  return { orders, nextCursor };
}

function renderPage(organizationId = 'org-1') {
  return render(
    <MemoryRouter initialEntries={['/org/orders']}>
      <OrganizationOrdersPage organizationId={organizationId} />
    </MemoryRouter>,
  );
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
});

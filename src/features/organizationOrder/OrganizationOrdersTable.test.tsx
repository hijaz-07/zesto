import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  cancelledOrgOrder,
  confirmedOrgOrder,
  longOrgOrder,
  pendingOrgOrder,
} from '../../test/organizationOrderFixtures';
import { OrganizationOrdersTable } from './OrganizationOrdersTable';
import type { OrganizationOrderSummary } from './types';

function renderTable(orders: OrganizationOrderSummary[]) {
  return render(<OrganizationOrdersTable orders={orders} />);
}

/** The body rows (the header row is excluded). */
function bodyRows() {
  return screen.getAllByRole('row').slice(1);
}

describe('OrganizationOrdersTable', () => {
  it('is a table named for what it lists, with exactly the eight agreed columns, in order', () => {
    renderTable([confirmedOrgOrder]);

    expect(screen.getByRole('table', { name: 'Orders, newest first' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Order ID',
      'Outlet',
      'Menu',
      'Placed',
      'Items',
      'Total',
      'Payment',
      'Status',
    ]);
  });

  it('has no column for customer identity', () => {
    renderTable([confirmedOrgOrder]);

    for (const name of [/customer/i, /name/i, /phone/i, /mobile/i, /e-?mail/i, /user/i]) {
      expect(screen.queryByRole('columnheader', { name })).not.toBeInTheDocument();
    }
  });

  it('renders one row per order, in the order given (newest first)', () => {
    renderTable([cancelledOrgOrder, pendingOrgOrder, confirmedOrgOrder]);

    const rows = bodyRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('#order-cancelled-3');
    expect(rows[1]).toHaveTextContent('#order-pending-2');
    expect(rows[2]).toHaveTextContent('#order-confirmed-1');
  });

  it('shows an order\'s id, outlet, menu, placed time, item lines, total and badges', () => {
    renderTable([confirmedOrgOrder]);

    const cells = within(bodyRows()[0]).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('#order-confirmed-1');
    expect(cells[1]).toHaveTextContent('Main Canteen');
    expect(cells[2]).toHaveTextContent('Tuesday Special Menu');
    expect(cells[2]).toHaveTextContent(/29 Sep(t)? 2026/);
    expect(cells[3]).toHaveTextContent(/28 Sep(t)? 2026, 10:30\s?(am|AM)/);
    expect(within(cells[4]).getByText('Chicken Biriyani × 2')).toBeInTheDocument();
    expect(within(cells[4]).getByText('Veg Meals × 1')).toBeInTheDocument();
    expect(cells[4]).toHaveTextContent('3 items');
    expect(cells[5]).toHaveTextContent('₹300');
    expect(cells[6]).toHaveTextContent('Paid');
    expect(cells[7]).toHaveTextContent('Confirmed');
  });

  it('shows a single portion as "1 item"', () => {
    renderTable([pendingOrgOrder]);

    expect(within(bodyRows()[0]).getAllByRole('cell')[4]).toHaveTextContent('1 item');
  });

  it('shows the payment and status badges for a pending order', () => {
    renderTable([pendingOrgOrder]);

    const cells = within(bodyRows()[0]).getAllByRole('cell');
    expect(cells[6]).toHaveTextContent('Pending');
    expect(cells[7]).toHaveTextContent('Payment pending');
  });

  it('shows the payment and status badges for a cancelled, unpaid order', () => {
    renderTable([cancelledOrgOrder]);

    const cells = within(bodyRows()[0]).getAllByRole('cell');
    expect(cells[6]).toHaveTextContent('Unpaid');
    expect(cells[7]).toHaveTextContent('Cancelled');
  });

  it('still shows Paid on a cancelled order that was paid', () => {
    renderTable([{ ...cancelledOrgOrder, paymentStatus: 'paid' }]);

    const cells = within(bodyRows()[0]).getAllByRole('cell');
    expect(cells[6]).toHaveTextContent('Paid');
    expect(cells[7]).toHaveTextContent('Cancelled');
  });

  it('lists the ten item lines it is given and says how many more there are', () => {
    renderTable([longOrgOrder]);

    const items = within(bodyRows()[0]).getAllByRole('cell')[4];
    expect(within(items).getAllByRole('listitem')).toHaveLength(11);
    expect(within(items).getByText('Dish 1 × 2')).toBeInTheDocument();
    expect(within(items).getByText('Dish 10 × 2')).toBeInTheDocument();
    expect(within(items).getByText('+3 more')).toBeInTheDocument();
    expect(items).toHaveTextContent('26 items');
  });

  it('shows no "more" line when every item line fits', () => {
    renderTable([confirmedOrgOrder]);

    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it('falls back gracefully when the outlet or menu no longer exists', () => {
    const bare: OrganizationOrderSummary = { ...confirmedOrgOrder, outlet: undefined, menu: undefined };
    renderTable([bare]);

    const cells = within(bodyRows()[0]).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('Unknown outlet');
    expect(cells[2]).toHaveTextContent('—');
    expect(cells[0]).toHaveTextContent('#order-confirmed-1');
  });
});

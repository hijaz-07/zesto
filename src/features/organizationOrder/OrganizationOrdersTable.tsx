import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';
import { formatBusinessDateTime, formatDate } from '../../utils/date';
import { organizationOrderPaymentBadge, organizationOrderStatusBadge } from './badges';
import type { OrganizationOrderSummary } from './types';

export interface OrganizationOrdersTableProps {
  orders: OrganizationOrderSummary[];
}

const HEADER_CELL = 'px-4 py-3 font-medium';

/**
 * The organization's orders as a table, in the order the backend returned them
 * (newest first). Everything shown comes from the list response: the item lines
 * are each order's own snapshots, the total is the stored total, the payment and
 * status badges come from the backend's own fields, and the outlet/menu names
 * are display context the backend resolved (omitted if they no longer exist).
 * There is deliberately no customer name, phone or email column — this
 * dashboard shows none. On narrow screens the table scrolls sideways rather than
 * dropping columns.
 */
export function OrganizationOrdersTable({ orders }: OrganizationOrdersTableProps) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
          <caption className="sr-only">Orders, newest first</caption>
          <thead className="border-b border-border bg-background text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className={HEADER_CELL}>
                Order ID
              </th>
              <th scope="col" className={HEADER_CELL}>
                Outlet
              </th>
              <th scope="col" className={HEADER_CELL}>
                Menu
              </th>
              <th scope="col" className={HEADER_CELL}>
                Placed
              </th>
              <th scope="col" className={HEADER_CELL}>
                Items
              </th>
              <th scope="col" className={`${HEADER_CELL} text-right`}>
                Total
              </th>
              <th scope="col" className={HEADER_CELL}>
                Payment
              </th>
              <th scope="col" className={HEADER_CELL}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function OrderRow({ order }: { order: OrganizationOrderSummary }) {
  const payment = organizationOrderPaymentBadge(order);
  const status = organizationOrderStatusBadge(order);
  const portions = order.itemCount === 1 ? '1 item' : `${order.itemCount} items`;

  return (
    <tr className="border-b border-border align-top last:border-b-0">
      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-text">#{order.id}</td>
      <td className="px-4 py-3 text-text">
        {order.outlet ? order.outlet.name : <span className="text-muted">Unknown outlet</span>}
      </td>
      <td className="px-4 py-3">
        {order.menu ? (
          <>
            <p className="text-text">{order.menu.title}</p>
            <p className="text-xs text-muted">{formatDate(order.menu.menuDate)}</p>
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-text">{formatBusinessDateTime(order.createdAt)}</td>
      <td className="px-4 py-3">
        <ul className="flex flex-col gap-0.5 text-text">
          {order.items.map((item, index) => (
            <li key={`${index}-${item.name}`}>
              {item.name} × {item.quantity}
            </li>
          ))}
          {order.moreItemLines > 0 && <li className="text-muted">+{order.moreItemLines} more</li>}
        </ul>
        <p className="mt-1 text-xs text-muted">{portions}</p>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-text">
        {formatPaiseAsRupees(order.totalInPaise)}
      </td>
      <td className="px-4 py-3">
        <Badge tone={payment.tone}>{payment.label}</Badge>
      </td>
      <td className="px-4 py-3">
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
    </tr>
  );
}

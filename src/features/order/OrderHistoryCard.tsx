import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';
import { formatBusinessDateTime, formatDate } from '../../utils/date';
import { orderStatusBadges } from './orderStatusBadges';
import type { OrderSummary } from './types';

export interface OrderHistoryCardProps {
  order: OrderSummary;
  onClick: () => void;
}

/**
 * One order in the customer's history. Everything shown comes from the
 * backend's list response: the item lines are the order's own snapshots, the
 * total is the stored total, and the outlet/menu names are display context the
 * backend resolved (and omitted if they no longer exist). Tapping opens the
 * existing order page, which re-reads the full order itself.
 */
export function OrderHistoryCard({ order, onClick }: OrderHistoryCardProps) {
  const placedAt = formatBusinessDateTime(order.createdAt);
  const portions = order.itemCount === 1 ? '1 item' : `${order.itemCount} items`;

  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col gap-3 p-4 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-medium text-text">{order.outlet?.name ?? 'Order'}</h3>
            {order.menu && (
              <p className="text-sm text-muted">
                {order.menu.title} · {formatDate(order.menu.menuDate)}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {orderStatusBadges(order).map((badge) => (
              <Badge key={badge.label} tone={badge.tone}>
                {badge.label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-0.5 text-sm text-text">
          {order.items.map((item, index) => (
            <p key={`${index}-${item.name}`}>
              {item.name} × {item.quantity}
            </p>
          ))}
          {order.moreItemLines > 0 && <p className="text-muted">+{order.moreItemLines} more</p>}
        </div>

        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs text-muted">Placed {placedAt}</p>
            <p className="text-xs text-muted">{portions}</p>
          </div>
          <p className="text-base font-semibold text-text">{formatPaiseAsRupees(order.totalInPaise)}</p>
        </div>
      </button>
    </Card>
  );
}

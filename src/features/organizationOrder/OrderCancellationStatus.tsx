import { Badge } from '../../components/ui/Badge';
import { formatPaiseAsRupees } from '../../utils/currency';
import { formatBusinessDateTime } from '../../utils/date';
import { cancelledByText, organizationRefundView } from './cancellation';
import type { OrganizationOrderSummary } from './types';

/**
 * What a cancelled order's Status cell says beyond its "Cancelled" badge: who
 * cancelled it and when, and — if money was captured — where its refund stands.
 * Shown to every member (staff included): it is the order's state, not a control.
 * Every state is words as well as a badge tone, never color alone. Only the safe
 * summary the backend sends is read; there is no provider, refund or audit
 * identifier to show.
 */
export function OrderCancellationStatus({ order }: { order: OrganizationOrderSummary }) {
  if (order.status !== 'cancelled') {
    return null;
  }
  const by = cancelledByText(order);
  const refund = organizationRefundView(order);
  if (!by && !refund) {
    return null;
  }
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1">
      {by && order.cancellation && (
        <p className="text-xs text-muted">
          {by} · {formatBusinessDateTime(order.cancellation.cancelledAt)}
        </p>
      )}
      {refund && (
        // Squarer than the default pill: the longer labels wrap in a narrow column.
        <Badge tone={refund.tone} className="rounded-lg">
          {refund.label}
        </Badge>
      )}
      {refund?.kind === 'processed' && order.refund && order.refund.refundedInPaise > 0 && (
        <p className="text-xs text-muted">{formatPaiseAsRupees(order.refund.refundedInPaise)} refunded</p>
      )}
    </div>
  );
}

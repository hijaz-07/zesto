import { Button } from '../../components/ui/Button';
import type { OrganizationMemberRole } from '../../domain/types';
import {
  canCancelOrders,
  canRecoverRefunds,
  isOrderCancellable,
  organizationRefundView,
} from './cancellation';
import type { FulfillmentAction } from './fulfillment';
import { OrderFulfillmentActions } from './OrderFulfillmentActions';
import type { OrganizationOrderId, OrganizationOrderSummary } from './types';

export interface OrganizationOrderActionsProps {
  order: OrganizationOrderSummary;
  /** The signed-in member's role. Decides only which controls are shown; the backend decides what they may do. */
  role: OrganizationMemberRole;
  /** Whether a request for this order (a fulfilment action or a cancellation) is in flight. */
  pending: boolean;
  /** Why this order's last action failed, if it did. */
  error: string | null;
  onRun: (orderId: OrganizationOrderId, action: FulfillmentAction) => void;
  /** Opens the cancellation dialog for this order. */
  onCancel: (orderId: OrganizationOrderId) => void;
  /** Asks the backend to retry this order's failed refund. */
  onRetryRefund: (orderId: OrganizationOrderId) => void;
}

/**
 * The action cell of one row of the order dashboard. A live order offers its next
 * fulfilment step (everyone) and, to an owner or manager, "Cancel order" while its
 * status still allows it. A cancelled order offers nothing to change — cancelling
 * is final — but an owner or manager whose refund failed is offered "Retry refund",
 * which asks the backend to start a new attempt; staff see neither. All of it is only what is
 * shown: every request is decided again by the backend, which is also what
 * enforces the roles.
 */
export function OrganizationOrderActions({
  order,
  role,
  pending,
  error,
  onRun,
  onCancel,
  onRetryRefund,
}: OrganizationOrderActionsProps) {
  if (order.status === 'cancelled') {
    const refund = organizationRefundView(order);
    const showRetry = refund?.needsAttention === true && canRecoverRefunds(role);
    const errorMessage = error && (
      <p role="alert" className="text-xs text-danger">
        {error}
      </p>
    );
    if (!showRetry) {
      return (
        <div className="flex flex-col gap-1">
          <span className="text-muted" aria-hidden="true">
            —
          </span>
          {errorMessage}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-1">
        <Button
          variant="secondary"
          className="min-h-11"
          disabled={pending}
          aria-label={`Retry refund, order ${order.id}`}
          onClick={() => onRetryRefund(order.id)}
        >
          Retry refund
        </Button>
        {errorMessage}
      </div>
    );
  }

  const cancellable = canCancelOrders(role) && isOrderCancellable(order);

  return (
    <div className="flex flex-col items-start gap-2">
      <OrderFulfillmentActions
        order={order}
        pending={pending}
        error={error}
        onRun={onRun}
        showEmptyPlaceholder={!cancellable}
      />
      {cancellable && (
        <Button
          variant="secondary"
          className="min-h-11 border-danger/40 text-danger hover:bg-danger/10"
          disabled={pending}
          aria-label={`Cancel order ${order.id}`}
          onClick={() => onCancel(order.id)}
        >
          Cancel order
        </Button>
      )}
    </div>
  );
}

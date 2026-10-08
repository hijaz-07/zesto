import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { isAwaitingPickup, nextFulfillmentAction, type FulfillmentAction } from './fulfillment';
import type { OrganizationOrderId, OrganizationOrderSummary } from './types';

export interface OrderFulfillmentActionsProps {
  order: OrganizationOrderSummary;
  /** Whether a request for this order is in flight. */
  pending: boolean;
  /** Why this order's last action failed, if it did. */
  error: string | null;
  onRun: (orderId: OrganizationOrderId, action: FulfillmentAction) => void;
  /**
   * Whether a row with nothing to offer shows a dash. A caller that puts other
   * controls beside this one turns it off, so a lone dash never sits above them.
   */
  showEmptyPlaceholder?: boolean;
}

/**
 * The action cell of one row of the order dashboard: the single next step the
 * order can be offered (`nextFulfillmentAction`), "Awaiting pickup" for a ready
 * order (only the pickup flow on `/org/pickup` can hand it over, so there is
 * deliberately no button), or a dash when there is nothing to do. "Start
 * preparing" and "Mark completed" act at once; "Mark ready" asks first, inline,
 * because it tells the customer their food is ready and nothing here can take it
 * back. The button is only ever offered from what the backend last reported for
 * the row, and the backend re-checks everything when it is pressed.
 */
export function OrderFulfillmentActions({
  order,
  pending,
  error,
  onRun,
  showEmptyPlaceholder = true,
}: OrderFulfillmentActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const spec = nextFulfillmentAction(order);

  const errorMessage = error && (
    <p role="alert" className="text-xs text-danger">
      {error}
    </p>
  );

  if (!spec) {
    if (!showEmptyPlaceholder && !isAwaitingPickup(order) && !errorMessage) {
      return null;
    }
    return (
      <div className="flex flex-col gap-1">
        {isAwaitingPickup(order) ? (
          <span className="text-sm text-muted">Awaiting pickup</span>
        ) : showEmptyPlaceholder ? (
          <span className="text-muted" aria-hidden="true">
            —
          </span>
        ) : null}
        {errorMessage}
      </div>
    );
  }

  const run = () => onRun(order.id, spec.action);
  const label = `${pending ? spec.pendingLabel : spec.label}, order ${order.id}`;

  if (spec.confirmation && confirming) {
    return (
      <div role="group" aria-label={`Confirm: ${spec.label}, order ${order.id}`} className="flex flex-col gap-2">
        <p className="text-sm font-medium text-text">{spec.confirmation.question}</p>
        <p className="text-xs text-muted">{spec.confirmation.detail}</p>
        {errorMessage}
        <div className="flex items-center gap-2">
          <Button disabled={pending} aria-busy={pending} onClick={run}>
            {pending ? spec.pendingLabel : spec.confirmation.confirmLabel}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        disabled={pending}
        aria-busy={pending}
        aria-label={label}
        onClick={spec.confirmation ? () => setConfirming(true) : run}
      >
        {pending ? spec.pendingLabel : spec.label}
      </Button>
      {errorMessage}
    </div>
  );
}

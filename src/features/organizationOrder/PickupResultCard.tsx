import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { OrganizationOrderId } from './types';
import type { PickupResult } from './usePickupRedeem';

export interface PickupResultCardProps {
  result: PickupResult;
  /** "Mark completed" was pressed for this order. */
  onComplete: (orderId: OrganizationOrderId) => void;
  /** Staff are done with this customer; clear the screen for the next one. */
  onDone: () => void;
}

/**
 * What staff see after a successful handover: the minimum needed to recognise
 * the order — its id, its outlet, what was ordered — and the one thing left to
 * do, "Mark completed". It shows the backend's own row and nothing more: no
 * customer name, email, phone or id, no payment or provider details, no audit
 * fields (none are even in the row), and never the credential that was used.
 *
 * Once the order is `completed` there is no action left and the card says so;
 * "Next pickup" clears it either way. While a request is in flight both buttons
 * are disabled, so completing cannot be sent twice.
 */
export function PickupResultCard({ result, onComplete, onDone }: PickupResultCardProps) {
  const { order, completing, completionError } = result;
  const completed = order.status === 'completed';
  const portions = order.itemCount === 1 ? '1 item' : `${order.itemCount} items`;

  return (
    <Card role="status" className="flex flex-col gap-3 border-success/30 bg-success/10">
      <div className="flex flex-col gap-1">
        <Badge tone={completed ? 'neutral' : 'success'} className="self-start">
          {completed ? 'Completed' : 'Picked up'}
        </Badge>
        <p className="text-sm text-text">
          {completed ? 'This order is complete.' : 'Pickup recorded. Hand the order over now.'}
        </p>
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="font-mono text-xs text-text">Order #{order.id}</p>
        {order.outlet && <p className="text-sm font-medium text-text">{order.outlet.name}</p>}
      </div>

      <div className="flex flex-col gap-0.5 text-sm text-text">
        <ul className="flex flex-col gap-0.5">
          {order.items.map((item, index) => (
            <li key={`${index}-${item.name}`}>
              {item.name} × {item.quantity}
            </li>
          ))}
          {order.moreItemLines > 0 && <li className="text-muted">+{order.moreItemLines} more</li>}
        </ul>
        <p className="text-xs text-muted">{portions}</p>
      </div>

      {completionError !== null && (
        <p role="alert" className="text-sm text-danger">
          {completionError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!completed && (
          <Button disabled={completing} aria-busy={completing} onClick={() => onComplete(order.id)}>
            {completing ? 'Completing…' : 'Mark completed'}
          </Button>
        )}
        <Button variant="secondary" disabled={completing} onClick={onDone}>
          Next pickup
        </Button>
      </div>
    </Card>
  );
}

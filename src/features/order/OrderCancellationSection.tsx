import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { CancelOrderDialog } from './CancelOrderDialog';
import { cancellationUnavailableMessage } from './errors';
import type { CustomerCancellationReason, Order } from './types';
import type { UseCancelOrderResult } from './useCancelOrder';

/**
 * The statuses a customer can ever cancel from. Only the SERVER's hint
 * (`order.cancellation.canCancel`) puts the action on screen; this is a second,
 * narrower guard so a contradictory hint on a collected order can never offer it.
 */
function mayOfferCancel(order: Order): boolean {
  return order.status === 'pending_payment' || order.status === 'confirmed';
}

/**
 * The cancellation part of a customer's order page. It offers "Cancel order"
 * only while the server says the order can be cancelled, explains in words why
 * it can't once preparation has started, and shows nothing for an order that is
 * already cancelled or collected (the page's status card says it). The decision
 * is always the server's: a tap sends one request, and a refusal re-reads the
 * order and is explained, not hidden.
 */
export function OrderCancellationSection({ order, cancel }: { order: Order; cancel: UseCancelOrderResult }) {
  const [open, setOpen] = useState(false);

  if (order.status === 'cancelled') {
    return null;
  }

  const canCancel = order.cancellation?.canCancel === true && mayOfferCancel(order);
  const explanation = canCancel ? null : cancellationUnavailableMessage(order);
  // A refusal's message is the explanation itself once the order has been re-read; show it once.
  const strayError = !open && cancel.errorMessage && cancel.errorMessage !== explanation ? cancel.errorMessage : null;

  async function confirm(reason: CustomerCancellationReason | undefined) {
    const outcome = await cancel.cancel(reason);
    if (outcome === 'cancelled' || outcome === 'refused') {
      setOpen(false);
    }
  }

  return (
    <>
      {canCancel && (
        <Button
          variant="secondary"
          className="min-h-11 text-danger!"
          onClick={() => {
            cancel.clearError();
            setOpen(true);
          }}
        >
          Cancel order
        </Button>
      )}

      {explanation && (
        <Card className="text-sm text-muted">
          <p>{explanation}</p>
        </Card>
      )}

      {strayError && (
        <Card role="alert" className="border-danger/30 bg-danger/10 text-sm text-text">
          <p>{strayError}</p>
        </Card>
      )}

      <CancelOrderDialog
        open={open && canCancel}
        paidInPaise={order.paymentStatus === 'paid' ? order.totalInPaise : null}
        pending={cancel.submitting}
        errorMessage={cancel.errorMessage}
        onConfirm={(reason) => void confirm(reason)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

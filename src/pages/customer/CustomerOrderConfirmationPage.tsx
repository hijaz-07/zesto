import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useAuth } from '../../features/auth/useAuth';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { getOrderErrorMessage } from '../../features/order/errors';
import { newestOrder } from '../../features/order/orderFreshness';
import { OrderCancellationSection } from '../../features/order/OrderCancellationSection';
import { OrderRefundCard } from '../../features/order/OrderRefundCard';
import { humanizeStatus } from '../../features/order/orderStatusBadges';
import { PickupCredentialCard } from '../../features/order/PickupCredentialCard';
import { isPaymentConfirmedStatus, type Order } from '../../features/order/types';
import { useCancelOrder } from '../../features/order/useCancelOrder';
import { useOrder } from '../../features/order/useOrder';
import { useOrderPickup } from '../../features/order/useOrderPickup';
import { useReadyOrderRefresh } from '../../features/order/useReadyOrderRefresh';
import { paymentNoticeText } from '../../features/payment/errors';
import { checkoutDescription } from '../../features/payment/razorpayCheckout';
import type { PaymentNotice } from '../../features/payment/types';
import { usePayOrder } from '../../features/payment/usePayOrder';
import { formatPaiseAsRupees } from '../../utils/currency';

const ORDER_STATUS_LABEL: Record<Order['status'], string> = {
  pending_payment: 'Payment required',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready: 'Ready for pickup',
  picked_up: 'Picked up',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** What a paid order's card says, by where the organization has got to with it. */
const PAID_ORDER_MESSAGE: Partial<Record<Order['status'], string>> = {
  confirmed: 'Payment successful. Your order is confirmed.',
  preparing: "Payment successful. We're preparing your order.",
  ready: 'Payment successful. Your order is ready for pickup.',
  picked_up: 'Your order has been collected.',
  completed: 'Your order is complete.',
};

/** The page heading for an order that has been handed over or cancelled; every other state keeps the original two. */
const HANDED_OVER_TITLE: Partial<Record<Order['status'], string>> = {
  picked_up: 'Order picked up',
  completed: 'Order completed',
  cancelled: 'Order cancelled',
};

/**
 * What a cancelled order's card says. The order's own status is the lifecycle
 * fact: a cancelled order is never "confirmed", even if a payment was captured
 * after it was cancelled (the refund card then says where that money is).
 */
function cancelledOrderMessage(order: Order): string {
  if (order.paymentStatus === 'paid' && order.refund && !order.refund.completedAt && order.refund.status !== 'failed') {
    return 'Your order was cancelled. Your refund has been initiated.';
  }
  return 'Your order was cancelled.';
}

const PAYMENT_STATUS_LABEL: Record<Order['paymentStatus'], string> = {
  pending: 'Payment pending',
  paid: 'Paid',
};

/** Whether a notice is something went wrong (announced assertively) rather than a neutral "not completed". */
function isErrorNotice(notice: PaymentNotice): boolean {
  return notice.kind !== 'dismissed';
}

/**
 * `/app/orders/:orderId` — the newly-created-order confirmation page, NOT
 * order history (see this checkpoint's task notes; a history list is a
 * later checkpoint). Always re-fetches the order from the backend
 * (`useOrder`), so this works identically right after order creation and
 * after a hard refresh, and every value shown — item names/prices, line
 * totals, subtotal, total, status, paymentStatus — comes from that
 * authoritative response, never reconstructed from the cart.
 *
 * A `pending_payment` order shows a "Pay ₹X" action that runs the whole
 * payment flow (see `usePayOrder`): prepare/reuse the backend's Razorpay
 * order, open Razorpay Test Checkout, then send Checkout's callback to the
 * server for signature verification. The page only ever shows the order as
 * confirmed/paid when it's loaded that way from the backend, or when the
 * server's own verification response says so — never because Checkout's
 * browser callback fired. A confirmed order has no Pay action.
 *
 * A `ready` order also shows the customer's pickup credential — a QR code and a
 * backup code to show staff (`PickupCredentialCard`, fetched by `useOrderPickup`
 * for this customer's own order only and held in memory only) — and is re-read
 * about every ten seconds while the page is on screen so it moves on to "Picked
 * up" by itself (`useReadyOrderRefresh`, which stops the moment the order is no
 * longer ready or the page is hidden). Once the order is `picked_up` or
 * `completed` the credential is gone, not just hidden, and there is nothing to
 * do but read the status. A status this build doesn't know is shown as words.
 *
 * Cancelling (`OrderCancellationSection`): "Cancel order" is offered only while the
 * server's own hint on the order says it can be cancelled (`order.cancellation`),
 * behind a confirmation dialog with an optional reason; the server decides, and a
 * refusal re-reads the order and explains. A cancelled order is shown as cancelled
 * whatever its payment status (a payment captured after the cancellation is
 * refunded, and the `OrderRefundCard` says so), never as confirmed. A refund still
 * in flight is re-read slowly until it settles (`useReadyOrderRefresh`).
 */
export function CustomerOrderConfirmationPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { status, order: fetchedOrder, error, retry, refresh } = useOrder(orderId);
  const cancellation = useCancelOrder(orderId);
  const { user } = useAuth();
  const { phase, notice, confirmedOrder, busy, pay, retryVerification } = usePayOrder({
    orderId,
    description: fetchedOrder ? checkoutDescription(fetchedOrder) : '',
    // Optional prefill only — payment never depends on any of these.
    customer: { name: user?.name, email: user?.email, contact: user?.phone },
  });
  // The newest copy the server has given us: what was loaded, what payment verification returned,
  // or what a cancellation (or a refused one's re-read) returned. After server verification the verify
  // response IS the authoritative order; a later read supersedes it as soon as it is newer.
  const loadedOrder = newestOrder(orderId, fetchedOrder, confirmedOrder, cancellation.order);
  // While it is Ready, or cancelled with its refund still in flight (and the page is visible), the
  // order is re-read, so it can move on to picked up / the refund can settle.
  const order = useReadyOrderRefresh(loadedOrder);
  // The pickup credential exists only for the customer's own READY, paid order, and is memory-only.
  const pickup = useOrderPickup(order?.id, order?.status === 'ready' && order.paymentStatus === 'paid');
  // Best-effort display names only — the order itself never depends on this
  // still resolving (see staleness.ts's identical reasoning for the cart).
  const { menu: liveMenu, outlet: liveOutlet } = useExploreMenu(order?.outletId, order?.menuId);

  let content;
  if (status === 'loading' || status === 'idle') {
    content = <LoadingState label="Loading your order…" />;
  } else if (status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load this order"
        description={getOrderErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (order) {
    // Paid and accepted — including once the organization has started on it.
    const isConfirmed = isPaymentConfirmedStatus(order.status) && order.paymentStatus === 'paid';
    const needsPayment = order.status === 'pending_payment' && order.paymentStatus === 'pending';
    const verifyFailed = notice?.kind === 'verify_failed';
    const noticeText = notice ? paymentNoticeText(notice) : null;
    // Typed wider than `string` on purpose: at runtime the lookup can miss, for a
    // status the backend added after this bundle was built.
    const statusLabel: string | undefined = ORDER_STATUS_LABEL[order.status];

    let payLabel = `Pay ${formatPaiseAsRupees(order.totalInPaise)}`;
    if (phase === 'preparing') {
      payLabel = 'Preparing payment…';
    } else if (phase === 'checkout') {
      payLabel = 'Waiting for payment…';
    } else if (phase === 'verifying') {
      payLabel = 'Verifying payment…';
    }

    content = (
      <>
        <PageHeader
          title={HANDED_OVER_TITLE[order.status] ?? (isConfirmed ? 'Order confirmed' : 'Your order')}
          subtitle={`Order #${order.id}`}
        />

        {isConfirmed ? (
          <Card className="flex flex-col gap-2 border-success/30 bg-success/10">
            <Badge tone="success" className="self-start">
              {statusLabel}
            </Badge>
            <p className="text-sm text-text">{PAID_ORDER_MESSAGE[order.status]}</p>
          </Card>
        ) : (
          <Card
            className={
              order.status === 'cancelled'
                ? 'flex flex-col gap-2 border-danger/30 bg-danger/10'
                : 'flex flex-col gap-2 border-warning/30 bg-warning/10'
            }
          >
            <Badge tone={order.status === 'cancelled' ? 'danger' : 'warning'} className="self-start">
              {statusLabel ?? humanizeStatus(order.status)}
            </Badge>
            {needsPayment && <p className="text-sm text-text">Pay to confirm your order.</p>}
            {order.status === 'cancelled' && <p className="text-sm text-text">{cancelledOrderMessage(order)}</p>}
          </Card>
        )}

        <OrderRefundCard order={order} />

        <PickupCredentialCard pickup={pickup} />

        {(liveOutlet || liveMenu) && (
          <div>
            {liveOutlet && <p className="font-medium text-text">{liveOutlet.name}</p>}
            {liveMenu && <p className="text-sm text-muted">{liveMenu.title}</p>}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {order.items.map((item) => (
            <Card key={item.itemId} className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-text">{item.name}</p>
                <p className="text-sm text-muted">
                  Qty {item.quantity} · {formatPaiseAsRupees(item.priceInPaise)} each
                </p>
              </div>
              <p className="text-sm font-semibold text-text">{formatPaiseAsRupees(item.lineTotalInPaise)}</p>
            </Card>
          ))}
        </div>

        <Card className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted">Subtotal</p>
            <p className="text-sm text-text">{formatPaiseAsRupees(order.subtotalInPaise)}</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-text">Total</p>
            <p className="text-sm font-semibold text-text">
              {formatPaiseAsRupees(order.totalInPaise)} {order.currency}
            </p>
          </div>
        </Card>

        <Card className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted">Payment status</p>
          <Badge tone={order.paymentStatus === 'paid' ? 'success' : 'warning'}>
            {PAYMENT_STATUS_LABEL[order.paymentStatus]}
          </Badge>
        </Card>

        {needsPayment && noticeText && (
          <Card
            role={notice && isErrorNotice(notice) ? 'alert' : 'status'}
            className="flex flex-col gap-1 border-warning/30 bg-warning/10"
          >
            <p className="text-sm font-medium text-text">{noticeText.title}</p>
            <p className="text-sm text-muted">{noticeText.detail}</p>
          </Card>
        )}

        {needsPayment &&
          (verifyFailed ? (
            <Button onClick={() => void retryVerification().then(refresh)} disabled={busy}>
              Retry verification
            </Button>
          ) : (
            <Button onClick={() => void pay().then(refresh)} disabled={busy} aria-busy={busy}>
              {payLabel}
            </Button>
          ))}

        <OrderCancellationSection order={order} cancel={cancellation} />

        <Button variant="secondary" onClick={() => navigate('/explore')}>
          Continue browsing
        </Button>
      </>
    );
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Order</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="flex flex-col gap-4 p-4">{content}</div>
      </IonContent>
    </IonPage>
  );
}

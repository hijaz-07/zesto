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
import type { Order } from '../../features/order/types';
import { useOrder } from '../../features/order/useOrder';
import { paymentNoticeText } from '../../features/payment/errors';
import { checkoutDescription } from '../../features/payment/razorpayCheckout';
import type { PaymentNotice } from '../../features/payment/types';
import { usePayOrder } from '../../features/payment/usePayOrder';
import { formatPaiseAsRupees } from '../../utils/currency';

const ORDER_STATUS_LABEL: Record<Order['status'], string> = {
  pending_payment: 'Payment required',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
};

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
 */
export function CustomerOrderConfirmationPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { status, order: fetchedOrder, error, retry } = useOrder(orderId);
  const { user } = useAuth();
  const { phase, notice, confirmedOrder, busy, pay, retryVerification } = usePayOrder({
    orderId,
    description: fetchedOrder ? checkoutDescription(fetchedOrder) : '',
    // Optional prefill only — payment never depends on any of these.
    customer: { name: user?.name, email: user?.email, contact: user?.phone },
  });
  // After server verification the verify response IS the authoritative order;
  // otherwise it's whatever the backend last returned for this order.
  const order = confirmedOrder && confirmedOrder.id === fetchedOrder?.id ? confirmedOrder : fetchedOrder;
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
    const isConfirmed = order.status === 'confirmed' && order.paymentStatus === 'paid';
    const needsPayment = order.status === 'pending_payment' && order.paymentStatus === 'pending';
    const verifyFailed = notice?.kind === 'verify_failed';
    const noticeText = notice ? paymentNoticeText(notice) : null;

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
        <PageHeader title={isConfirmed ? 'Order confirmed' : 'Your order'} subtitle={`Order #${order.id}`} />

        {isConfirmed ? (
          <Card className="flex flex-col gap-2 border-success/30 bg-success/10">
            <Badge tone="success" className="self-start">
              {ORDER_STATUS_LABEL[order.status]}
            </Badge>
            <p className="text-sm text-text">Payment successful. Your order is confirmed.</p>
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
              {ORDER_STATUS_LABEL[order.status]}
            </Badge>
            {needsPayment && <p className="text-sm text-text">Pay to confirm your order.</p>}
          </Card>
        )}

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
            <Button onClick={() => void retryVerification()} disabled={busy}>
              Retry verification
            </Button>
          ) : (
            <Button onClick={() => void pay()} disabled={busy} aria-busy={busy}>
              {payLabel}
            </Button>
          ))}

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

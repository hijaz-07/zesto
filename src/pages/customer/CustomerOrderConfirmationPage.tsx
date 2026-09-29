import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { getOrderErrorMessage } from '../../features/order/errors';
import type { Order } from '../../features/order/types';
import { useOrder } from '../../features/order/useOrder';
import { formatPaiseAsRupees } from '../../utils/currency';

const ORDER_STATUS_LABEL: Record<Order['status'], string> = {
  pending_payment: 'Payment required',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
};

const PAYMENT_STATUS_LABEL: Record<Order['paymentStatus'], string> = {
  pending: 'Payment pending',
};

/**
 * `/app/orders/:orderId` — the newly-created-order confirmation page, NOT
 * order history (see this checkpoint's task notes; a history list is a
 * later checkpoint). Always re-fetches the order from the backend
 * (`useOrder`), so this works identically right after order creation and
 * after a hard refresh, and every value shown — item names/prices, line
 * totals, subtotal, total, status, paymentStatus — comes from that
 * authoritative response, never reconstructed from the cart.
 *
 * A newly created order is always `pending_payment` / `pending`: payment
 * doesn't exist yet (a later checkpoint), so this deliberately never shows
 * a payment button and never implies the order is paid or the food is
 * confirmed.
 */
export function CustomerOrderConfirmationPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { status, order, error, retry } = useOrder(orderId);
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
    content = (
      <>
        <PageHeader title="Order placed" subtitle={`Order #${order.id}`} />

        <Card className="flex flex-col gap-2 border-warning/30 bg-warning/10">
          <Badge tone="warning" className="self-start">
            {ORDER_STATUS_LABEL[order.status]}
          </Badge>
          <p className="text-sm text-text">Order created — payment will be added next.</p>
        </Card>

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
          <Badge tone="warning">{PAYMENT_STATUS_LABEL[order.paymentStatus]}</Badge>
        </Card>

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

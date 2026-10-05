import { IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import { PageHeader } from '../../components/common/PageHeader';
import { Button } from '../../components/ui/Button';
import { listOrdersErrorMessage } from '../../features/order/errors';
import { OrderHistoryCard } from '../../features/order/OrderHistoryCard';
import { useOrderHistory } from '../../features/order/useOrderHistory';
import { useOnBecameVisible } from '../../hooks/useOnBecameVisible';
import { NotificationBell } from '../../features/notification/NotificationBell';

/**
 * `/app/orders` — the signed-in customer's own order history, newest first,
 * loaded from the backend a page at a time (`useOrderHistory`). Opening an
 * order goes to the existing `/app/orders/:orderId` page, which re-reads the
 * full order itself; this page never reconstructs an order from the list.
 */
export function CustomerOrdersPage() {
  const navigate = useNavigate();
  const { status, orders, error, hasMore, loadingMore, loadMoreError, retry, loadMore, refresh } =
    useOrderHistory();

  // Ionic keeps a tab's page mounted (but hidden) when the customer switches
  // away, so without this an order placed since the last visit would be
  // missing. Coming back to the tab isn't a mount, hence the visibility hook.
  const pageRef = useRef<HTMLDivElement>(null);
  useOnBecameVisible(pageRef, refresh);

  let content;
  if (status === 'loading') {
    content = <LoadingState label="Loading your orders…" />;
  } else if (status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load your orders"
        description={listOrdersErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (orders.length === 0) {
    content = (
      <EmptyState
        title="No orders yet"
        description="Orders you place will show up here."
        action={
          <Button variant="secondary" onClick={() => navigate('/explore')}>
            Browse menus
          </Button>
        }
      />
    );
  } else {
    content = (
      <>
        <ul aria-label="Your orders" className="flex flex-col gap-3">
          {orders.map((order) => (
            <li key={order.id}>
              <OrderHistoryCard order={order} onClick={() => navigate(`/app/orders/${order.id}`)} />
            </li>
          ))}
        </ul>

        {loadMoreError !== null && (
          <p role="alert" className="text-center text-sm text-danger">
            {listOrdersErrorMessage(loadMoreError)}
          </p>
        )}

        {hasMore && (
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? 'Loading…' : loadMoreError !== null ? 'Try again' : 'Load more'}
          </Button>
        )}
      </>
    );
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Orders</IonTitle>
          <IonButtons slot="end">
            <NotificationBell />
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div ref={pageRef} className="flex flex-col gap-4 p-4">
          <PageHeader title="My Orders" />
          {content}
        </div>
      </IonContent>
    </IonPage>
  );
}

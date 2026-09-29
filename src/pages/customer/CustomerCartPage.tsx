import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { PageHeader } from '../../components/common/PageHeader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { CartLineRow } from '../../features/cart/CartLineRow';
import { cartSubtotalInPaise } from '../../features/cart/cart';
import { useCart } from '../../features/cart/useCart';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { formatPaiseAsRupees } from '../../utils/currency';

/**
 * `/app/cart` — a preview of the customer's selected demand for one
 * outlet/menu. Client-side UI state only: no order is created and there is
 * no checkout yet (see `../../features/cart` and the Step 11A task notes).
 * Re-fetches the live published menu via the same public Explore API the
 * menu detail page uses, purely to flag a line whose item has disappeared
 * or changed price since it was added — the cart's own price/name snapshot
 * always stays the source of truth for what's shown and totalled.
 */
export function CustomerCartPage() {
  const navigate = useNavigate();
  const { cart, removeLine } = useCart();
  const context = cart.context;
  const { status: menuStatus, menu } = useExploreMenu(context?.outletId, context?.menuId);

  let content;
  if (!context || cart.lines.length === 0) {
    content = (
      <EmptyState
        title="Your cart is empty"
        description="Browse a published menu and add items to see them here."
        action={<Button onClick={() => navigate('/explore')}>Browse menus</Button>}
      />
    );
  } else {
    const menuChecked = menuStatus === 'ready' || menuStatus === 'error';
    const liveItems = menuStatus === 'ready' && menu ? menu.items : [];

    content = (
      <>
        <PageHeader
          title={menu?.title ?? 'Your cart'}
          subtitle={menuStatus === 'error' ? 'This menu is no longer available.' : undefined}
        />

        <div className="flex flex-col gap-3">
          {cart.lines.map((line) => (
            <CartLineRow
              key={line.itemId}
              context={context}
              line={line}
              liveItem={liveItems.find((item) => item.id === line.itemId)}
              menuChecked={menuChecked}
              onRemove={() => removeLine(line.itemId)}
            />
          ))}
        </div>

        <Card className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-text">Subtotal</p>
          <p className="text-sm font-semibold text-text">{formatPaiseAsRupees(cartSubtotalInPaise(cart))}</p>
        </Card>

        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            onClick={() => navigate(`/explore/outlets/${context.outletId}/menus/${context.menuId}`)}
          >
            Return to Menu
          </Button>
          <p className="rounded-lg bg-background px-3 py-2 text-center text-xs text-muted">
            Checkout isn't available yet — this is a preview of your order, not a placed order.
          </p>
        </div>
      </>
    );
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Cart</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="flex flex-col gap-4 p-4">{content}</div>
      </IonContent>
    </IonPage>
  );
}

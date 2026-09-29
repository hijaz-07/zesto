import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../../components/common/EmptyState';
import { PageHeader } from '../../components/common/PageHeader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { CartLineRow } from '../../features/cart/CartLineRow';
import { cartSubtotalInPaise } from '../../features/cart/cart';
import { useCart } from '../../features/cart/useCart';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { cartToOrderRequest } from '../../features/order/cartToOrderRequest';
import { createOrderErrorMessage } from '../../features/order/errors';
import { OrderReviewSection } from '../../features/order/OrderReviewSection';
import { computeCartStaleness } from '../../features/order/staleness';
import { useCreateOrder } from '../../features/order/useCreateOrder';
import { formatPaiseAsRupees } from '../../utils/currency';

type CartStage = 'cart' | 'review';

/**
 * `/app/cart` — the customer's selected demand for one outlet/menu, plus a
 * review stage that turns it into a real `pending_payment` order (see
 * `../../features/order` and this checkpoint's task notes). Re-fetches the
 * live published menu via the same public Explore API the menu detail page
 * uses, both to flag a line whose item has disappeared/changed price (cart
 * stage) and to gate order submission on the same check (review stage) —
 * the cart's own price/name snapshot always stays the source of truth for
 * what's shown and totalled here; the backend's response is the source of
 * truth for the order actually created (see `OrderReviewSection`).
 */
export function CustomerCartPage() {
  const navigate = useNavigate();
  const { cart, removeLine, clearCart } = useCart();
  const context = cart.context;
  const { status: menuStatus, outlet, menu } = useExploreMenu(context?.outletId, context?.menuId);
  const [stage, setStage] = useState<CartStage>('cart');
  const { status: submitStatus, error: submitError, submit, reset: resetSubmission } = useCreateOrder();

  const staleness = computeCartStaleness(cart, menuStatus, menu);

  const handleBackToCart = () => {
    resetSubmission();
    setStage('cart');
  };

  const handlePlaceOrder = async () => {
    const request = cartToOrderRequest(cart);
    if (!request) {
      return;
    }
    try {
      const order = await submit(request);
      clearCart();
      navigate(`/app/orders/${order.id}`);
    } catch {
      // Already captured by useCreateOrder's status/error and shown below;
      // the cart is deliberately left untouched so the customer can retry.
    }
  };

  let content;
  if (!context || cart.lines.length === 0) {
    content = (
      <EmptyState
        title="Your cart is empty"
        description="Browse a published menu and add items to see them here."
        action={<Button onClick={() => navigate('/explore')}>Browse menus</Button>}
      />
    );
  } else if (stage === 'review') {
    content = (
      <OrderReviewSection
        outletName={outlet?.name}
        menuTitle={menu?.title}
        cart={cart}
        staleness={staleness}
        submitting={submitStatus === 'submitting'}
        submitError={submitError ? createOrderErrorMessage(submitError) : null}
        onBack={handleBackToCart}
        onPlaceOrder={handlePlaceOrder}
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
          <Button onClick={() => setStage('review')}>Review Order</Button>
          <Button
            variant="secondary"
            onClick={() => navigate(`/explore/outlets/${context.outletId}/menus/${context.menuId}`)}
          >
            Return to Menu
          </Button>
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

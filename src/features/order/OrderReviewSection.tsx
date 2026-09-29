import { PageHeader } from '../../components/common/PageHeader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';
import { cartSubtotalInPaise } from '../cart/cart';
import type { Cart } from '../cart/types';
import type { CartStalenessResult, StalenessIssue } from './staleness';

export interface OrderReviewSectionProps {
  outletName?: string;
  menuTitle?: string;
  cart: Cart;
  staleness: CartStalenessResult;
  submitting: boolean;
  submitError: string | null;
  onBack: () => void;
  onPlaceOrder: () => void;
}

function stalenessMessage(issue: StalenessIssue): string {
  switch (issue.type) {
  case 'item_unavailable':
    return `${issue.name} is no longer available on this menu.`;
  case 'price_changed':
    return (
      `${issue.name} price changed to ${formatPaiseAsRupees(issue.newPriceInPaise)} ` +
      `(was ${formatPaiseAsRupees(issue.oldPriceInPaise)} in your cart).`
    );
  case 'ordering_not_open':
    return 'Ordering has not opened yet for this menu.';
  case 'ordering_closed':
    return 'Ordering has closed for this menu.';
  case 'menu_unavailable':
    return 'This menu is no longer available.';
  }
}

/**
 * The review/confirm stage of `CustomerCartPage`: a read-only recap of the
 * cart's own snapshot (never the live menu's data — see root CLAUDE.md's
 * "Menu editing"), plus any staleness the cart has picked up since items
 * were added. The "Place Order" button only creates a `pending_payment`
 * order — see `useCreateOrder` and functions/src/domain/orders.ts — so it
 * is deliberately never labeled Pay/Checkout/Confirm Payment.
 */
export function OrderReviewSection({
  outletName,
  menuTitle,
  cart,
  staleness,
  submitting,
  submitError,
  onBack,
  onPlaceOrder,
}: OrderReviewSectionProps) {
  const hasIssues = staleness.issues.length > 0;
  const canSubmit = staleness.ready && !hasIssues && !submitting;

  return (
    <>
      <PageHeader title="Review Order" subtitle={menuTitle} />
      {outletName && <p className="text-sm text-muted">{outletName}</p>}

      <div className="flex flex-col gap-3">
        {cart.lines.map((line) => (
          <Card key={line.itemId} className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-text">{line.name}</p>
              <p className="text-sm text-muted">
                Qty {line.quantity} · {formatPaiseAsRupees(line.priceInPaise)} each
              </p>
            </div>
            <p className="text-sm font-semibold text-text">
              {formatPaiseAsRupees(line.priceInPaise * line.quantity)}
            </p>
          </Card>
        ))}
      </div>

      <Card className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-text">Subtotal</p>
        <p className="text-sm font-semibold text-text">{formatPaiseAsRupees(cartSubtotalInPaise(cart))}</p>
      </Card>

      {!staleness.ready && <p className="text-sm text-muted">Checking the latest menu…</p>}

      {hasIssues && (
        <Card className="flex flex-col gap-2 border-warning/30 bg-warning/10">
          <p className="text-sm font-medium text-text">Your cart has changed since you added these items</p>
          <ul className="flex flex-col gap-1">
            {staleness.issues.map((issue, index) => (
              <li key={index} className="text-sm text-warning">
                {stalenessMessage(issue)}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">Go back to your cart to remove or adjust the affected items.</p>
        </Card>
      )}

      {submitError && (
        <p role="alert" className="text-sm text-danger">
          {submitError}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button onClick={onPlaceOrder} disabled={!canSubmit}>
          {submitting ? 'Placing order…' : 'Place Order'}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={submitting}>
          Back to Cart
        </Button>
        <p className="rounded-lg bg-background px-3 py-2 text-center text-xs text-muted">
          This creates your order — payment isn&apos;t collected yet.
        </p>
      </div>
    </>
  );
}

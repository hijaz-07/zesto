import { LoadingState } from '../../components/common/LoadingState';
import { QrCode } from '../../components/common/QrCode';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { getPickupCredentialErrorMessage } from './errors';
import type { UseOrderPickupResult } from './useOrderPickup';

export interface PickupCredentialCardProps {
  pickup: UseOrderPickupResult;
}

/**
 * The customer's pickup section for their own READY order: the QR code and the
 * backup code to show or read out to staff. It renders only what the backend
 * returned for this order's own customer (see `useOrderPickup`) — never a
 * guess, never a stored copy — and shows nothing at all once `pickup.status` is
 * `idle`, which is what the page passes as soon as the order is no longer ready.
 */
export function PickupCredentialCard({ pickup }: PickupCredentialCardProps) {
  if (pickup.status === 'idle') {
    return null;
  }

  return (
    <Card aria-labelledby="pickup-credential-heading" className="flex flex-col items-center gap-3 text-center">
      <h2 id="pickup-credential-heading" className="text-base font-semibold text-text">
        Collect your order
      </h2>

      {pickup.status === 'loading' && <LoadingState label="Loading your pickup code…" />}

      {pickup.status === 'error' && (
        <div role="alert" className="flex flex-col items-center gap-2">
          <p className="text-sm font-medium text-danger">Couldn&apos;t load your pickup code</p>
          <p className="max-w-sm text-sm text-muted">{getPickupCredentialErrorMessage(pickup.error)}</p>
          <Button variant="secondary" onClick={pickup.retry}>
            Try again
          </Button>
        </div>
      )}

      {pickup.status === 'ready' && pickup.credential && (
        <>
          <p className="max-w-sm text-sm text-muted">
            Show the QR code to staff when you collect your order, or read out the pickup code.
          </p>
          <QrCode value={pickup.credential.qrPayload} label="Pickup QR code" />
          <div className="flex flex-col items-center gap-1">
            <p className="text-xs uppercase tracking-wide text-muted">Pickup code</p>
            <p translate="no" className="font-mono text-2xl font-semibold tracking-[0.2em] text-text">
              {pickup.credential.code}
            </p>
          </div>
        </>
      )}
    </Card>
  );
}

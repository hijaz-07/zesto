import { IonContent, IonPage } from '@ionic/react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/common/PageHeader';
import { OrganizationPageToolbar } from '../../components/layout/OrganizationPageToolbar';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { OrganizationId, OrganizationMemberRole, OutletId } from '../../domain/types';
import { canHandOverOrders } from '../../features/organizationOrder/fulfillment';
import { PickupResultCard } from '../../features/organizationOrder/PickupResultCard';
import { QrScanner } from '../../features/organizationOrder/QrScanner';
import { usePickupRedeem } from '../../features/organizationOrder/usePickupRedeem';
import { useQrScannerSupport } from '../../features/organizationOrder/useQrScannerSupport';
import { useOutlets } from '../../features/outlet/useOutlets';

export interface OrganizationPickupPageProps {
  organizationId: OrganizationId;
  /** The caller's membership role (from `GET /organizations`, threaded down via `OrganizationGate` -> `OrganizationAppLayout`). Decides only whether the pickup controls are shown — see `canHandOverOrders`. */
  role: OrganizationMemberRole;
}

const ALL_OUTLETS = '';

/**
 * `/org/pickup` — handing ready orders over to the customers who come to
 * collect them. Staff scan the customer's QR code, or type the 8-character
 * backup code (or let a USB/Bluetooth scanner "type" the QR payload into the same
 * field); the backend finds the order from that credential, checks everything,
 * and moves it `ready` → `picked_up` in one transaction. The page then shows what
 * to hand over and a "Mark completed" action.
 *
 * Only what is shown is decided here, from the member's role: the controls appear
 * for owner/manager/staff, and anyone else sees only that they have no access.
 * Authority is the backend's — it checks the caller's active membership, the
 * order's organization, its state, payment, and the credential on every request.
 * The outlet selector is only a narrowing check ("this counter serves Main
 * Canteen"): it can make the backend refuse an order of another outlet, never let
 * it accept one it otherwise would not.
 *
 * Typing the code is the first-class path. "Scan QR" appears only where the
 * browser can really scan (`useQrScannerSupport`) and a camera failure is shown
 * inside the scanner panel, never as a page error.
 *
 * The credential is a SECRET. It exists only in the input while being typed or
 * scanned, is cleared the instant it is submitted (success or failure alike), and
 * is never stored, logged or put in a URL. The input is not named, is not
 * auto-completed, and spell-check and auto-correct are off, so the browser keeps
 * no history of it either.
 */
export function OrganizationPickupPage({ organizationId, role }: OrganizationPickupPageProps) {
  return (
    <IonPage>
      <OrganizationPageToolbar title="Pickup" />
      <IonContent>
        <div className="flex flex-col gap-4 p-4">
          <PageHeader title="Pickup" subtitle="Hand ready orders to the customers collecting them." />
          {canHandOverOrders(role) ? (
            <PickupWorkspace organizationId={organizationId} />
          ) : (
            <div role="alert" className="flex flex-col items-center gap-2 py-12 text-center">
              <p className="text-sm font-medium text-danger">You don&apos;t have access to hand over orders</p>
              <p className="max-w-sm text-sm text-muted">Ask an owner or manager of this organization for access.</p>
            </div>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
}

function PickupWorkspace({ organizationId }: { organizationId: OrganizationId }) {
  const [selectedOutletId, setSelectedOutletId] = useState<OutletId>(ALL_OUTLETS);
  const [credentialInput, setCredentialInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { status: outletsStatus, outlets } = useOutlets(organizationId);
  const { submitting, error, result, submit, complete, dismiss } = usePickupRedeem(organizationId);
  const scannerSupport = useQrScannerSupport();

  const outletId = selectedOutletId === ALL_OUTLETS ? null : selectedOutletId;

  // After every attempt, put the cursor back in the field, so the next scan or code can be entered at once.
  useEffect(() => {
    if (!submitting && !scanning) {
      inputRef.current?.focus();
    }
  }, [submitting, scanning, result, error]);

  /**
   * Sends `raw` and forgets it: the field is cleared before the request leaves, so
   * the credential is not on screen — or in state — while it is in flight, nor
   * after it comes back, whatever the outcome.
   */
  const redeem = useCallback(
    (raw: string) => {
      setCredentialInput('');
      void submit(raw, outletId);
    },
    [submit, outletId],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submitting) {
      redeem(credentialInput);
    }
  }

  function handleScanned(value: string) {
    setScanning(false);
    redeem(value);
  }

  return (
    <>
      <div className="flex max-w-xs flex-col gap-1">
        <label htmlFor="org-pickup-outlet" className="text-sm font-medium text-text">
          Outlet
        </label>
        <select
          id="org-pickup-outlet"
          value={selectedOutletId}
          disabled={outletsStatus !== 'ready' || submitting}
          onChange={(event) => setSelectedOutletId(event.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary disabled:opacity-50"
        >
          <option value={ALL_OUTLETS}>All outlets</option>
          {outlets.map((outlet) => (
            <option key={outlet.id} value={outlet.id}>
              {outlet.status === 'inactive' ? `${outlet.name} (inactive)` : outlet.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted">Choose the outlet this counter serves to catch an order meant for another.</p>
      </div>

      <Card className="flex flex-col gap-3">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3" aria-label="Pickup code">
          <div className="flex flex-col gap-1">
            <label htmlFor="org-pickup-code" className="text-sm font-medium text-text">
              Pickup code
            </label>
            <input
              ref={inputRef}
              id="org-pickup-code"
              type="text"
              value={credentialInput}
              onChange={(event) => setCredentialInput(event.target.value)}
              disabled={submitting}
              placeholder="A1B2-C3D4"
              maxLength={200}
              // Not named, not auto-completed, not corrected: the browser keeps no history of a pickup code.
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="go"
              className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm uppercase tracking-wider text-text outline-none placeholder:normal-case focus:border-primary disabled:opacity-50"
            />
            <p className="text-xs text-muted">
              Type the customer&apos;s 8-character code, or scan their QR code with a scanner or the camera.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={submitting || credentialInput.trim() === ''} aria-busy={submitting}>
              {submitting ? 'Handing over…' : 'Hand over'}
            </Button>
            {scannerSupport === 'supported' && !scanning && (
              <Button variant="secondary" disabled={submitting} onClick={() => setScanning(true)}>
                Scan QR
              </Button>
            )}
          </div>
        </form>

        {scanning && <QrScanner onScan={handleScanned} onClose={() => setScanning(false)} />}
      </Card>

      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {result && <PickupResultCard result={result} onComplete={(orderId) => void complete(orderId)} onDone={dismiss} />}
    </>
  );
}

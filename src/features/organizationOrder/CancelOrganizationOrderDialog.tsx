import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { formatPaiseAsRupees } from '../../utils/currency';
import { organizationOrderStatusBadge } from './badges';
import {
  ORGANIZATION_CANCELLATION_REASONS,
  ORGANIZATION_CANCELLATION_REASON_LABEL,
  type OrganizationCancellationReason,
} from './cancellation';
import type { OrganizationOrderSummary } from './types';

export interface CancelOrganizationOrderDialogProps {
  /** The order being cancelled, as the list last reported it; the dialog follows the list if it refreshes. `null` keeps the dialog closed. */
  order: OrganizationOrderSummary | null;
  /** A cancellation request is in flight. */
  pending: boolean;
  /** Why the last attempt failed, to be retried from here. */
  errorMessage: string | null;
  onConfirm: (reason: OrganizationCancellationReason) => void;
  onClose: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What the current status means for the decision, in the operator's words. */
function stateNote(order: OrganizationOrderSummary): string | null {
  switch (order.status) {
    case 'preparing':
      return 'Preparation has already started on this order.';
    case 'ready':
      return 'This order is already marked ready for pickup.';
    default:
      return null;
  }
}

/**
 * The confirmation an owner or manager sees before cancelling an order. It only
 * collects the decision — one of the approved reasons, required, and a yes — and
 * reports it; the backend decides whether the cancellation happens, who may do it
 * and what is refunded.
 *
 * A real modal dialog: it takes focus when it opens (on the safe choice, "Keep
 * order"), keeps Tab inside itself, closes on Escape or a tap outside, and puts
 * focus back where it came from when it closes. While a request is in flight it
 * cannot be dismissed and its buttons do nothing, so a double-tap sends one
 * request. Rendered into `document.body` so no table container clips it.
 */
export function CancelOrganizationOrderDialog(props: CancelOrganizationOrderDialogProps) {
  if (props.order === null) {
    return null;
  }
  return createPortal(<DialogContent {...props} order={props.order} />, document.body);
}

function DialogContent({
  order,
  pending,
  errorMessage,
  onConfirm,
  onClose,
}: CancelOrganizationOrderDialogProps & { order: OrganizationOrderSummary }) {
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const reasonHintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);
  const [reason, setReason] = useState<OrganizationCancellationReason | ''>('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const status = organizationOrderStatusBadge(order);
  const paid = order.paymentStatus === 'paid';
  const note = stateNote(order);

  // Take focus on open; give it back on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!pending) {
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) {
      return;
    }
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function confirm() {
    if (pending) {
      return;
    }
    if (reason === '') {
      setReasonMissing(true);
      reasonRef.current?.focus();
      return;
    }
    onConfirm(reason);
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
        className="flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold text-text">
          Cancel this order?
        </h2>

        <section aria-label="Order" className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs text-text">#{order.id}</span>
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted">Current status</span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </span>
          </div>
          <p className="text-muted">{order.outlet ? order.outlet.name : 'Unknown outlet'}</p>
          <ul className="flex flex-col gap-0.5 text-text">
            {order.items.map((item, index) => (
              <li key={`${index}-${item.name}`}>
                {item.name} × {item.quantity}
              </li>
            ))}
            {order.moreItemLines > 0 && <li className="text-muted">+{order.moreItemLines} more</li>}
          </ul>
          <p className="font-medium text-text">Total {formatPaiseAsRupees(order.totalInPaise)}</p>
        </section>

        <div id={descriptionId} className="flex flex-col gap-2 text-sm text-muted">
          <p className="font-medium text-text">Cancelling is permanent and can&apos;t be undone.</p>
          {note && <p>{note}</p>}
          <p>The customer will be notified.</p>
          {paid ? (
            <p>The customer will receive a full refund of the eligible amount.</p>
          ) : (
            <p>
              This order hasn&apos;t been paid for, so there&apos;s nothing to refund. If the customer&apos;s payment is
              still in progress, it will be refunded automatically.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className="text-sm font-medium text-text">
            Reason <span className="font-normal text-muted">(required)</span>
          </label>
          <select
            ref={reasonRef}
            id={reasonId}
            value={reason}
            required
            aria-required="true"
            aria-invalid={reasonMissing && reason === ''}
            aria-describedby={reasonMissing && reason === '' ? reasonHintId : undefined}
            disabled={pending}
            onChange={(event) => {
              setReason(event.target.value as OrganizationCancellationReason | '');
              setReasonMissing(false);
            }}
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text"
          >
            <option value="">Choose a reason…</option>
            {ORGANIZATION_CANCELLATION_REASONS.map((value) => (
              <option key={value} value={value}>
                {ORGANIZATION_CANCELLATION_REASON_LABEL[value]}
              </option>
            ))}
          </select>
          {reasonMissing && reason === '' && (
            <p id={reasonHintId} role="alert" className="text-sm font-medium text-danger">
              Choose a reason to cancel this order.
            </p>
          )}
        </div>

        {errorMessage && (
          <p role="alert" className="text-sm font-medium text-danger">
            {errorMessage}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            data-autofocus
            variant="secondary"
            className="min-h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={pending}
            onClick={() => {
              if (!pending) {
                onClose();
              }
            }}
          >
            Keep order
          </Button>
          <Button
            variant="danger"
            className="min-h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={pending}
            aria-busy={pending}
            onClick={confirm}
          >
            {pending ? 'Cancelling…' : errorMessage ? 'Try again' : 'Yes, cancel order'}
          </Button>
        </div>
      </div>
    </div>
  );
}

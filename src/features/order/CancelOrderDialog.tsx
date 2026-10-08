import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui/Button';
import { formatPaiseAsRupees } from '../../utils/currency';
import { CANCELLATION_REASON_LABEL } from './cancellationCopy';
import { CUSTOMER_CANCELLATION_REASONS, type CustomerCancellationReason } from './types';

export interface CancelOrderDialogProps {
  open: boolean;
  /** What the customer paid, or `null` when nothing has been paid (so no refund applies). */
  paidInPaise: number | null;
  /** A cancellation request is in flight. */
  pending: boolean;
  /** Why the last attempt failed, to be retried from here. */
  errorMessage: string | null;
  onConfirm: (reason: CustomerCancellationReason | undefined) => void;
  onClose: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The confirmation shown when a customer asks to cancel an order. It only
 * collects the decision — the optional reason and a yes — and reports it; the
 * server decides whether the cancellation happens and what is refunded.
 *
 * A real modal dialog: it takes focus when it opens (on the safe choice, "Keep
 * order"), keeps Tab inside itself, closes on Escape or a tap outside, and puts
 * focus back where it came from when it closes. While a request is in flight it
 * cannot be dismissed and its buttons do nothing, so a double-tap sends one
 * request. Rendered into `document.body` so no page container clips it.
 */
export function CancelOrderDialog(props: CancelOrderDialogProps) {
  if (!props.open) {
    return null;
  }
  return createPortal(<CancelOrderDialogContent {...props} />, document.body);
}

function CancelOrderDialogContent({ paidInPaise, pending, errorMessage, onConfirm, onClose }: CancelOrderDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState<CustomerCancellationReason | ''>('');

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

        <div id={descriptionId} className="flex flex-col gap-2 text-sm text-muted">
          <p>This will cancel your order. It can&apos;t be undone.</p>
          {paidInPaise !== null ? (
            <p>
              You&apos;ll get a full refund of {formatPaiseAsRupees(paidInPaise)} to your original payment method.
              Refunds are processed in the background and may take a few business days to appear.
            </p>
          ) : (
            <p>This order hasn&apos;t been paid for, so there&apos;s nothing to refund.</p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className="text-sm font-medium text-text">
            Reason <span className="font-normal text-muted">(optional)</span>
          </label>
          <select
            id={reasonId}
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.target.value as CustomerCancellationReason | '')}
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text"
          >
            <option value="">Prefer not to say</option>
            {CUSTOMER_CANCELLATION_REASONS.map((value) => (
              <option key={value} value={value}>
                {CANCELLATION_REASON_LABEL[value]}
              </option>
            ))}
          </select>
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
            onClick={() => {
              if (!pending) {
                onConfirm(reason === '' ? undefined : reason);
              }
            }}
          >
            {pending ? 'Cancelling…' : errorMessage ? 'Try again' : 'Yes, cancel order'}
          </Button>
        </div>
      </div>
    </div>
  );
}

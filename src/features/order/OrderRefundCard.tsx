import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';
import { formatBusinessDateTime } from '../../utils/date';
import { getSupportEmail } from '../public/siteConfig';
import { showsRefundCard } from './cancellationCopy';
import type { Order } from './types';

interface RefundCopy {
  title: string;
  badge: string;
  tone: BadgeTone;
}

function SupportLine() {
  const email = getSupportEmail();
  return (
    <p className="text-sm text-muted">
      Need help?{' '}
      {email ? (
        <a className="font-medium text-primary underline" href={`mailto:${email}`}>
          Contact support
        </a>
      ) : (
        <Link className="font-medium text-primary underline" to="/contact">
          Contact support
        </Link>
      )}
      .
    </p>
  );
}

/**
 * The refund of a cancelled, paid order, in plain words: initiated (the refund
 * is `requested` or `pending` — the customer need not tell them apart),
 * processed, or couldn't be completed automatically. Every state is said in
 * words as well as by its badge, never by color alone, and none of it promises
 * an exact time. Nothing but the safe summary the server sends is shown: no
 * refund or provider identifier, no internal status name, no provider error.
 * A cancelled paid order whose refund summary is missing or unreadable says its
 * refund is being arranged rather than guessing a state.
 */
export function OrderRefundCard({ order }: { order: Order }) {
  if (!showsRefundCard(order)) {
    return null;
  }
  const refund = order.refund;

  let copy: RefundCopy;
  let body: ReactNode;
  if (!refund) {
    copy = { title: 'Refund being arranged', badge: 'In progress', tone: 'warning' };
    body = <p className="text-sm text-muted">We&apos;re arranging your refund. Check back shortly for an update.</p>;
  } else if (refund.status === 'processed') {
    copy = { title: 'Refund processed', badge: 'Completed', tone: 'success' };
    body = (
      <>
        <p className="text-sm text-text">
          {formatPaiseAsRupees(refund.amountInPaise)} has been refunded to your original payment method.
        </p>
        <p className="text-sm text-muted">
          Depending on your bank, it can take a few business days to show in your account.
        </p>
        {refund.completedAt && <p className="text-xs text-muted">Processed {formatBusinessDateTime(refund.completedAt)}</p>}
      </>
    );
  } else if (refund.status === 'failed') {
    copy = { title: 'Refund not completed', badge: 'Not completed', tone: 'danger' };
    body = (
      <>
        <p className="text-sm text-text">We couldn&apos;t complete your refund automatically. We&apos;ve been notified.</p>
        <SupportLine />
      </>
    );
  } else {
    copy = { title: 'Refund initiated', badge: 'In progress', tone: 'warning' };
    body = (
      <>
        <p className="text-sm text-text">
          Your refund of {formatPaiseAsRupees(refund.amountInPaise)} is being processed and may take a few business days
          to appear in your account.
        </p>
        <p className="text-xs text-muted">Initiated {formatBusinessDateTime(refund.initiatedAt)}</p>
      </>
    );
  }

  return (
    <Card
      aria-labelledby="refund-card-heading"
      role={refund?.status === 'failed' ? 'alert' : 'status'}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="refund-card-heading" className="text-base font-semibold text-text">
          {copy.title}
        </h2>
        <Badge tone={copy.tone}>{copy.badge}</Badge>
      </div>
      {body}
    </Card>
  );
}

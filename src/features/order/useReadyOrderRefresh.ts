import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api/client';
import { getOrder } from './api';
import { isTerminalRefundStatus, type Order } from './types';

/** How often a Ready order is re-read while the page is on screen. */
export const READY_ORDER_REFRESH_MS = 10_000;

/**
 * How often a cancelled order whose refund is still in flight is re-read. A
 * refund settles over minutes to days, so this is deliberately slow.
 */
export const REFUND_REFRESH_MS = 30_000;

/**
 * How long this order should wait between re-reads, or `null` if it should not
 * be re-read at all. Only two situations change under a customer who is simply
 * looking at the page: a Ready order being collected, and a cancelled order's
 * refund (`requested` or `pending`) being settled. Every other order, and a refund
 * that has `processed` or `failed`, is left alone.
 */
function refreshIntervalMs(order: Order | null | undefined): number | null {
  if (!order) {
    return null;
  }
  if (order.status === 'ready') {
    return READY_ORDER_REFRESH_MS;
  }
  if (order.status === 'cancelled' && order.refund && !isTerminalRefundStatus(order.refund.status)) {
    return REFUND_REFRESH_MS;
  }
  return null;
}

/** Whether `a` was last changed after `b` (an unreadable timestamp is never "newer"). */
function isNewer(a: Order, b: Order): boolean {
  return Date.parse(a.updatedAt) > Date.parse(b.updatedAt);
}

/** A failure that no amount of waiting fixes: the session is gone, or the order is no longer this customer's. */
function isPermanentFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);
}

/**
 * Keeps a customer's order fresh while it is in a state that changes without
 * them doing anything:
 *
 * - a READY order, while they stand at the counter, so their screen moves on to
 *   "Picked up" without a manual refresh — about every ten seconds;
 * - a CANCELLED order whose refund is still `requested` or `pending`, so the
 *   refund card moves on to "processed" or "failed" — every thirty seconds, and
 *   not at all once the refund has settled either way.
 *
 * It re-reads the order through the existing order-detail API (`getOrder`), and
 * ONLY under all of these:
 *
 * - the order on screen is one of the two above — never for `pending_payment`,
 *   `confirmed`, `preparing`, `picked_up`, `completed`, or a cancelled order
 *   with no refund in flight;
 * - the component is mounted;
 * - the page is visible. When the tab or window goes hidden the timer is
 *   cleared and nothing is requested; when it becomes visible again the order
 *   is re-read at once (it may have moved while the customer was away) and the
 *   ten-second beat resumes.
 *
 * It stops the instant a read shows the order no longer needs it (no longer
 * `ready`, or its refund settled) — the timer is not rescheduled — and on unmount. It never overlaps requests (the next
 * read is scheduled only after the previous one finishes), and a failed read
 * changes nothing on screen: a network or server hiccup just waits for the next
 * beat, while a 401/403/404 stops it for good. Deliberately NOT a general
 * polling facility, and not a realtime listener: one timer, one endpoint, one
 * status.
 *
 * @param order The order the page is showing, or null while there is none.
 * @return The order to show: the latest this hook read for the same order, else
 *   `order` itself.
 */
export function useReadyOrderRefresh(order: Order | null): Order | null {
  const [refreshed, setRefreshed] = useState<Order | null>(null);
  // What this hook read stands in for the order it was given — unless the page has
  // since been handed a newer copy of that order, which must never be hidden by an
  // older read.
  const current =
    order && refreshed && refreshed.id === order.id && !isNewer(order, refreshed) ? refreshed : order;
  const orderId = current?.id;
  const intervalMs = refreshIntervalMs(current);

  useEffect(() => {
    if (intervalMs === null || orderId === undefined) {
      return;
    }
    // Declared as plain values so the hoisted functions below see them as such.
    const id: string = orderId;
    const beat: number = intervalMs;

    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isHidden = () => document.visibilityState === 'hidden';
    const stopTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const scheduleNext = () => {
      stopTimer();
      timer = setTimeout(() => void read(), beat);
    };

    async function read() {
      timer = undefined;
      if (cancelled || inFlight || isHidden()) {
        return;
      }
      inFlight = true;
      try {
        const { order: latest } = await getOrder(id);
        if (cancelled) {
          return;
        }
        if (latest.id !== id) {
          // Not the order this screen is about: ignore it, as for any failed read.
          scheduleNextIfVisible();
          return;
        }
        setRefreshed(latest);
        if (refreshIntervalMs(latest) !== beat) {
          // Moved on (or onto a different beat): stop right here, without waiting for the re-render, which restarts it if need be.
          return;
        }
        scheduleNextIfVisible();
      } catch (error: unknown) {
        if (cancelled || isPermanentFailure(error)) {
          return;
        }
        scheduleNextIfVisible();
      } finally {
        inFlight = false;
      }
    }

    function scheduleNextIfVisible() {
      if (!cancelled && !isHidden()) {
        scheduleNext();
      }
    }

    function onVisibilityChange() {
      if (isHidden()) {
        stopTimer();
      } else if (timer === undefined && !inFlight) {
        void read();
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    scheduleNextIfVisible();

    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, orderId]);

  return current;
}

import type { ISODateString } from '../types/common';

/** Formats an ISO date-time as a short, locale-aware time, e.g. "6:30 PM". */
export function formatTime(isoDateTime: ISODateString): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(isoDateTime));
}

/** Formats an ISO date as a short, locale-aware date, e.g. "25 Sep 2026". */
export function formatDate(isoDate: ISODateString): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(isoDate));
}

export type OrderingState = 'not_open' | 'open' | 'closed';

/**
 * Derives a menu's ordering state from its opening/closing instants and the
 * current instant. `orderingOpensAt`/`orderingClosesAt` are full ISO
 * date-times with an explicit UTC offset, so this is a plain instant
 * comparison — correct regardless of the caller's local time zone, matching
 * Zesto's business time zone convention (Asia/Kolkata; see
 * functions/src/time.ts) without needing to convert into it. The boundaries
 * mirror the backend's own rule (functions/src/domain/menuItems.ts): opening
 * is inclusive (`now === orderingOpensAt` is already "open"), closing is
 * inclusive-closed (`now === orderingClosesAt` is already "closed").
 *
 * Deterministic and pure — takes `now` explicitly rather than reading
 * `new Date()` internally — so callers can test it without fake timers, and
 * so this logic never needs to be duplicated inside a component.
 */
export function getOrderingState(
  orderingOpensAt: ISODateString,
  orderingClosesAt: ISODateString,
  now: Date = new Date(),
): OrderingState {
  const opensAtMs = new Date(orderingOpensAt).getTime();
  const closesAtMs = new Date(orderingClosesAt).getTime();
  const nowMs = now.getTime();

  if (nowMs < opensAtMs) {
    return 'not_open';
  }
  if (nowMs >= closesAtMs) {
    return 'closed';
  }
  return 'open';
}

import type { ISODateString } from '../types/common';

/** Formats an ISO date-time as a short, locale-aware time, e.g. "6:30 PM". */
export function formatTime(isoDateTime: ISODateString): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(isoDateTime));
}

/**
 * Formats an ISO date as a short, locale-aware calendar date, e.g. "25 Sep
 * 2026". `timeZone: 'UTC'` is deliberate: a date-only ISO string (no time
 * component, e.g. a menu's `menuDate`) parses as UTC midnight, and without
 * pinning the formatter to UTC too, `Intl.DateTimeFormat` would render it in
 * the browser's local time zone instead — shifting the displayed calendar
 * date back a day for any viewer west of UTC. Formatting in UTC reads the
 * same calendar date back out regardless of the viewer's own time zone.
 */
export function formatDate(isoDate: ISODateString): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(isoDate));
}

/**
 * Zesto's business time zone (Asia/Kolkata) has no daylight-saving
 * transitions, so its UTC offset is always exactly `+05:30` — safe to
 * hardcode rather than resolve per-instant. Mirrors
 * functions/src/time.ts#BUSINESS_TIME_ZONE.
 */
const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const BUSINESS_UTC_OFFSET = '+05:30';

const BUSINESS_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const BUSINESS_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Today's calendar date in Zesto's business time zone, `YYYY-MM-DD`. Mirrors
 * functions/src/time.ts#businessDateString; takes an explicit `now` (like
 * `getOrderingState` below) so callers can test it without fake timers.
 */
export function businessToday(now: Date = new Date()): string {
  return BUSINESS_DATE_FORMATTER.format(now);
}

/** An ISO instant's calendar date in Zesto's business time zone, `YYYY-MM-DD`. */
export function businessDateOf(isoDateTime: ISODateString): string {
  return BUSINESS_DATE_FORMATTER.format(new Date(isoDateTime));
}

/** An ISO instant's local clock time in Zesto's business time zone, 24-hour `HH:mm`. */
export function businessTimeOf(isoDateTime: ISODateString): string {
  return BUSINESS_TIME_FORMATTER.format(new Date(isoDateTime));
}

/**
 * Combines a calendar date (`YYYY-MM-DD`) and 24-hour local time (`HH:mm`),
 * both already understood to be in Zesto's business time zone, into an ISO
 * 8601 timestamp with an explicit offset — the shape the menus API expects.
 * Deliberately NOT `new Date(`${date}T${time}`)`: that parses in the
 * browser's own time zone, silently producing the wrong instant for any
 * viewer outside Asia/Kolkata. Callers are expected to supply well-formed
 * `date`/`time` (e.g. straight from an `<input type="date">`/`type="time">`);
 * this does no parsing or validation of its own.
 */
export function toBusinessTimestamp(date: string, time: string): string {
  return `${date}T${time}:00${BUSINESS_UTC_OFFSET}`;
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

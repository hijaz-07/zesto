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

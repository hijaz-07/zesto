/** ISO 8601 date or date-time string, e.g. "2026-09-25" or "2026-09-25T18:30:00+05:30". */
export type ISODateString = string;

export interface DevelopmentStatusItem {
  label: string;
  ready: boolean;
}

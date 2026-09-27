/**
 * Zesto's business time zone is hardcoded to Asia/Kolkata for v1 (no
 * per-outlet time zone field yet — see docs/architecture/domain-model.md).
 * This module is deliberately minimal and Menu-agnostic: "what calendar date
 * is it right now, in Zesto's business time zone."
 */
export const BUSINESS_TIME_ZONE = "Asia/Kolkata";

const KOLKATA_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * @param {Date} instant The instant to resolve (defaults to now). Accepting
 *   an explicit instant — rather than always reading `new Date()` internally
 *   — keeps this function's own tests deterministic without fake timers.
 * @return {string} `instant`'s calendar date in Zesto's business time zone
 *   (Asia/Kolkata), as `YYYY-MM-DD`. The `en-CA` locale formats dates in this
 *   order already, so no string reassembly is needed.
 */
export function businessDateString(instant: Date = new Date()): string {
  return KOLKATA_DATE_FORMATTER.format(instant);
}

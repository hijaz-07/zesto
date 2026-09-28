/** Formats a paise amount as an Indian Rupee string, e.g. 12000 -> "₹120". */
export function formatPaiseAsRupees(priceInPaise: number): string {
  const rupees = priceInPaise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: rupees % 1 === 0 ? 0 : 2,
  }).format(rupees);
}

/** A non-negative integer number of rupees, optionally with 1-2 decimal places. */
const RUPEES_INPUT_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Parses a user-entered decimal rupee string (e.g. "120", "99.50") into
 * integer paise, e.g. "99.50" -> 9950. Converts via string splitting, never
 * by multiplying a parsed float by 100 — money must never round-trip
 * through floating-point arithmetic (see root CLAUDE.md). Rejects a
 * negative amount, more than 2 decimal places, or anything that isn't a
 * plain decimal number (returning `null` rather than throwing, since this
 * is meant to run on every keystroke of a form field).
 */
export function parseRupeesToPaise(input: string): number | null {
  const trimmed = input.trim();
  if (!RUPEES_INPUT_PATTERN.test(trimmed)) {
    return null;
  }

  const [rupees, decimal = ''] = trimmed.split('.');
  const paise = decimal.padEnd(2, '0');
  const totalPaise = Number(rupees) * 100 + Number(paise);

  return Number.isSafeInteger(totalPaise) ? totalPaise : null;
}

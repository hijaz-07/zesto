/**
 * Turns whatever staff typed, pasted, or a scanner produced into a pickup
 * credential to send — or says why it cannot be one. A convenience only: it
 * saves a request (and a confusing error) for something that is plainly not a
 * pickup code. The backend parses and verifies every credential itself and is
 * the only authority; nothing here makes a credential valid.
 *
 * Three kinds of input arrive in the one field:
 *
 * - the 8-character backup code, typed by hand — forgiving the way a person
 *   needs it to be: any case, spaces or hyphens anywhere, and the characters
 *   that look alike read as their digit (`O` as 0, `I` and `L` as 1), exactly
 *   as the backend's alphabet does;
 * - the whole QR payload (`ZP1.<orderId>.<proof>`), pasted, or typed by a
 *   keyboard-wedge scanner (a USB or Bluetooth scanner "types" what it reads and
 *   presses Enter) — exact, case-sensitive, passed through untouched;
 * - a camera scan of the same payload.
 *
 * Stray control characters (the newline a wedge scanner may add, a pasted line
 * break) are dropped first. The value is never logged, stored, or put in a URL
 * by this module, or by anything that calls it.
 */

export type PickupInputResult =
  | { ok: true; kind: 'qr' | 'code'; credential: string }
  | { ok: false; message: string };

/** The longest input worth looking at; a real payload is ~47 characters. */
export const PICKUP_INPUT_MAX_LENGTH = 200;

export const PICKUP_INPUT_EMPTY = 'Enter or scan a pickup code.';
export const PICKUP_INPUT_MALFORMED =
  "That doesn't look like a Zesto pickup code. A backup code is 8 letters and numbers, like A1B2-C3D4.";

const QR_PREFIX = 'ZP1.';
/** `ZP1.<order id>.<22-character proof>`; the id may not contain whitespace or a slash. */
const QR_PATTERN = /^ZP1\.[^\s/]+\.[A-Za-z0-9_-]{22}$/;
/** Crockford base32, the backend's alphabet: no I, L, O or U. */
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * @param raw What was typed, pasted or scanned.
 * @return The credential to send, or a message for the person at the counter.
 */
export function normalizePickupInput(raw: string): PickupInputResult {
  const value = raw.replace(CONTROL_CHARACTERS, '').trim();

  if (value.length === 0) {
    return { ok: false, message: PICKUP_INPUT_EMPTY };
  }
  if (value.length > PICKUP_INPUT_MAX_LENGTH) {
    return { ok: false, message: PICKUP_INPUT_MALFORMED };
  }

  if (value.startsWith(QR_PREFIX)) {
    return QR_PATTERN.test(value)
      ? { ok: true, kind: 'qr', credential: value }
      : { ok: false, message: PICKUP_INPUT_MALFORMED };
  }

  const code = value
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!CODE_PATTERN.test(code)) {
    return { ok: false, message: PICKUP_INPUT_MALFORMED };
  }
  return { ok: true, kind: 'code', credential: `${code.slice(0, 4)}-${code.slice(4)}` };
}

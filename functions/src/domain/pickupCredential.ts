import {createHmac, timingSafeEqual} from "node:crypto";
import {defineSecret} from "firebase-functions/params";
import {HttpsError} from "firebase-functions/v2/https";
import {isValidDocumentId} from "../auth/membership";

/**
 * The PICKUP CREDENTIAL: what a customer shows (as a QR code, or reads out as a
 * short backup code) so staff can hand over a ready order, and what the server
 * checks before moving it `ready` -> `picked_up` (see `domain/orderPickup.ts`).
 *
 * It is DERIVED, never stored. Both forms are an HMAC-SHA256 of the order's own
 * ID under a server-only secret (`PICKUP_CREDENTIAL_SECRET`), so:
 *
 * - nothing about it exists in Firestore, a log, a URL or any API response
 *   other than the one that hands it to the order's own customer;
 * - the customer can reload their screen and get the same credential back;
 * - it cannot be worked out from the order ID (which is not secret — it is in
 *   URLs and the staff table) without the secret, and is not a reversible
 *   encoding of it;
 * - it carries no customer or payment data;
 * - rotating the secret invalidates every outstanding credential at once.
 *
 * Two forms of the same proof, with different strength for different jobs:
 *
 * - QR payload `ZP1.<orderId>.<proof>` — 128 bits of proof. Self-locating (it
 *   names its order), so a scan needs no search.
 * - Backup code `K7QX-4M2P` — 40 bits, 8 Crockford-base32 characters, easy to
 *   read out and type. It does not name its order; the server finds the order
 *   by checking it against the organization's orders awaiting pickup, which
 *   is only safe because the space (2^40) is enormous next to the handful of
 *   candidates. The two derivations use different domain-separation strings,
 *   so learning one reveals nothing about the other.
 *
 * Validity is not a property of the credential: it is whatever the ORDER's
 * state allows. Once an order is `picked_up` the same credential changes
 * nothing (`redeemPickup` refuses it), which is the replay protection. The
 * `ZP1` prefix versions the format, leaving room for a time-windowed `ZP2`.
 *
 * Everything here that takes a `secret` is pure, so it is unit-testable with a
 * made-up one; only `getPickupCredentialSecret` reads the environment.
 */

/**
 * The HMAC key. A REAL secret, handled exactly like the Razorpay ones in
 * `providers/razorpay.ts` and DELIBERATELY a different value from them: Cloud
 * Secret Manager in production (declared on the `api` function's `secrets`
 * array in `index.ts`), `functions/.secret.local` for the local emulator. Never
 * in source control, Firestore, an API response, or a log line.
 */
export const pickupCredentialSecret = defineSecret("PICKUP_CREDENTIAL_SECRET", {
  description: "HMAC key for order pickup credentials (QR payload / backup code). " +
    "Server-only — never log or return this value. At least 32 characters.",
});

/** The shortest secret `derivePickupCredentials` and friends will use. */
export const PICKUP_SECRET_MIN_LENGTH = 32;

/** Upper bound on a credential string a client may send (a real QR payload is ~47 characters). */
export const PICKUP_CREDENTIAL_MAX_LENGTH = 200;

const QR_PREFIX = "ZP1.";
const QR_PROOF_BYTES = 16;
const QR_PROOF_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CODE_BYTES = 5;
const CODE_LENGTH = 8;
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/** Crockford base32: no I, L, O or U, so nothing a person reads out can be mistaken for something else. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * @return {string} The configured pickup-credential secret, trimmed.
 * @throws {Error} If `PICKUP_CREDENTIAL_SECRET` is missing or blank — a server
 *   misconfiguration, deliberately a plain error (a 500) and never reported to
 *   the caller as an invalid credential, and never containing the secret.
 */
export function getPickupCredentialSecret(): string {
  const value = pickupCredentialSecret.value().trim();
  if (!value) {
    throw new Error("PICKUP_CREDENTIAL_SECRET is not configured.");
  }
  return value;
}

/** What a customer is shown for their ready order. Nothing else is ever part of it. */
export interface PickupCredentials {
  /** The text encoded in the QR code. */
  qrPayload: string;
  /** The backup code, formatted for reading out: `K7QX-4M2P`. */
  code: string;
}

/** A credential as a client presented it, parsed but NOT yet verified. */
export type ParsedPickupCredential =
  | {kind: "qr"; orderId: string; proof: string}
  | {kind: "code"; code: string};

/**
 * @param {string} secret The HMAC key.
 * @param {string} message The domain-separated message to authenticate.
 * @return {Buffer} The raw HMAC-SHA256 digest.
 * @throws {Error} If the secret is shorter than `PICKUP_SECRET_MIN_LENGTH`.
 */
function hmac(secret: string, message: string): Buffer {
  if (secret.length < PICKUP_SECRET_MIN_LENGTH) {
    throw new Error(
      `The pickup credential secret must be at least ${PICKUP_SECRET_MIN_LENGTH} characters.`,
    );
  }
  return createHmac("sha256", secret).update(message, "utf8").digest();
}

/**
 * @param {string} secret The HMAC key.
 * @param {string} orderId The order's document ID.
 * @return {string} The QR proof: 16 bytes of the HMAC, base64url (22 characters).
 */
function qrProof(secret: string, orderId: string): string {
  return hmac(secret, `zesto:pickup:v1:qr:${orderId}`).subarray(0, QR_PROOF_BYTES).toString("base64url");
}

/**
 * @param {string} secret The HMAC key.
 * @param {string} orderId The order's document ID.
 * @return {string} The normalized backup code: 5 bytes of the HMAC as 8
 *   Crockford-base32 characters, with no separator.
 */
export function pickupCodeFor(secret: string, orderId: string): string {
  const bytes = hmac(secret, `zesto:pickup:v1:code:${orderId}`).subarray(0, CODE_BYTES);
  let buffer = 0;
  let bitCount = 0;
  let code = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      code += CODE_ALPHABET[(buffer >> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
    buffer &= (1 << bitCount) - 1;
  }
  return code;
}

/**
 * @param {string} a One string.
 * @param {string} b Another string.
 * @return {boolean} Whether they are equal, compared in constant time. The
 *   lengths of what is compared are fixed by the format, not secret, so an
 *   early return on a length mismatch reveals nothing.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Derives the credential for an order. Deterministic: the same secret and
 * order always give the same result.
 *
 * @param {string} secret The HMAC key (see `getPickupCredentialSecret`).
 * @param {string} orderId The order's document ID.
 * @return {PickupCredentials} The QR payload and the backup code.
 * @throws {Error} If the secret is too short, or the order ID is not a valid
 *   document ID or would make a payload longer than a client may send back.
 */
export function derivePickupCredentials(secret: string, orderId: string): PickupCredentials {
  if (!isValidDocumentId(orderId)) {
    throw new Error("Cannot derive a pickup credential for a malformed order ID.");
  }
  const qrPayload = `${QR_PREFIX}${orderId}.${qrProof(secret, orderId)}`;
  if (qrPayload.length > PICKUP_CREDENTIAL_MAX_LENGTH) {
    throw new Error("The pickup credential for this order would be too long to present.");
  }
  const code = pickupCodeFor(secret, orderId);
  return {qrPayload, code: `${code.slice(0, 4)}-${code.slice(4)}`};
}

/**
 * Parses what a client sent as a pickup credential — a scanned (or
 * keyboard-wedge-typed) QR payload, or a typed backup code — without checking
 * it against anything. A QR payload is recognised by its `ZP1.` prefix and is
 * case-sensitive; a backup code is forgiving the way a person needs it to be:
 * case-insensitive, spaces and hyphens ignored, and the characters Crockford
 * base32 treats as look-alikes read as their digit (O as 0, I and L as 1).
 *
 * @param {unknown} raw The credential as received.
 * @return {ParsedPickupCredential} The parsed credential.
 * @throws {HttpsError} `invalid-argument` (400) if it is neither a QR payload
 *   nor a backup code in shape. The message never echoes the input.
 */
export function parsePickupCredential(raw: unknown): ParsedPickupCredential {
  const malformed = new HttpsError("invalid-argument", "That doesn't look like a Zesto pickup code.");
  if (typeof raw !== "string") {
    throw malformed;
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > PICKUP_CREDENTIAL_MAX_LENGTH) {
    throw malformed;
  }

  if (value.startsWith(QR_PREFIX)) {
    const rest = value.slice(QR_PREFIX.length);
    // The proof is base64url, so it never contains ".": the LAST dot is the split.
    const split = rest.lastIndexOf(".");
    if (split < 1) {
      throw malformed;
    }
    const orderId = rest.slice(0, split);
    const proof = rest.slice(split + 1);
    if (!isValidDocumentId(orderId) || !QR_PROOF_PATTERN.test(proof)) {
      throw malformed;
    }
    return {kind: "qr", orderId, proof};
  }

  const code = value
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH || !CODE_PATTERN.test(code)) {
    throw malformed;
  }
  return {kind: "code", code};
}

/**
 * Whether a parsed credential is the genuine one for `orderId`. This is the
 * authoritative check; `redeemPickup` runs it inside its transaction against
 * the order it just read.
 *
 * @param {string} secret The HMAC key.
 * @param {string} orderId The order's document ID.
 * @param {ParsedPickupCredential} credential What the client presented.
 * @return {boolean} Whether it proves possession of this order's credential.
 *   A QR payload that names a different order never matches.
 */
export function pickupCredentialMatches(
  secret: string,
  orderId: string,
  credential: ParsedPickupCredential,
): boolean {
  if (credential.kind === "qr") {
    return credential.orderId === orderId && safeEqual(credential.proof, qrProof(secret, orderId));
  }
  return safeEqual(credential.code, pickupCodeFor(secret, orderId));
}

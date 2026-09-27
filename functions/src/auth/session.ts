import type {AuthenticationInfo} from "@descope/node-sdk";
import {HttpsError} from "firebase-functions/v2/https";
import {
  getDescopeClient,
  getDescopeProjectId,
  type DescopeSdk,
} from "./descopeClient";

/**
 * Server-side authentication boundary for Cloud Functions.
 *
 * Every protected business operation must call `verifyDescopeSession` (or
 * `authenticateRequest`) before doing anything else, and must take the
 * caller's identity ONLY from the returned `VerifiedSession` — never from
 * a user ID, role, or organization claim sent in the request body.
 *
 * Transport contract: the client sends its Descope session JWT as
 * `Authorization: Bearer <sessionToken>` to HTTPS (`onRequest`) functions.
 * `onCall` callables are not used for this, because the callable protocol
 * reserves the Authorization header for Firebase Auth ID tokens and rejects
 * anything else before the handler runs.
 *
 * Validation (`validateSession`) verifies the JWT signature against
 * Descope's published keys for this project, its expiry, its issuer, and its
 * audience. The expected audience is the backend's `DESCOPE_PROJECT_ID`
 * (Descope's default `aud` for session tokens). It comes only from trusted
 * backend configuration: this module deliberately offers no way to supply
 * an audience from a request.
 */

/** A caller whose Descope session token was validated server-side. */
export interface VerifiedSession {
  /**
   * Descope user ID (the JWT `sub`) — the identity key for `users/{userId}`
   * and `organizations/{organizationId}/members/{userId}`.
   */
  userId: string;
  /** The validated JWT claims. */
  claims: AuthenticationInfo["token"];
}

/** The part of the Descope client this boundary uses (injectable in tests). */
export type SessionValidator = Pick<DescopeSdk, "validateSession">;

/**
 * The Descope Node SDK's `validateSession` collapses every failure — a
 * rejected token AND an infrastructure failure while validating it (e.g. it
 * could not fetch Descope's signing keys) — into one generic `Error`, whose
 * message embeds the original error's stringified name (see
 * `@descope/node-sdk`'s `validateSession`/`getKey`). These substrings are
 * the only signal available to tell "the token was rejected" apart from "we
 * couldn't validate it right now": every one of jose's JWT-content error
 * classes (expired, bad signature, malformed, disallowed algorithm, wrong
 * claim), plus this SDK's own "no matching signing key" / "malformed kid"
 * messages, which mean the keys WERE fetched successfully. Anything else —
 * a network/DNS failure, a timeout, or a bad response fetching Descope's
 * signing keys — does not match and is treated as an infrastructure failure.
 */
const TOKEN_REJECTION_PATTERNS: readonly RegExp[] = [
  /JWTExpired/,
  /JWTClaimValidationFailed/,
  /JWSSignatureVerificationFailed/,
  /JWSInvalid/,
  /JWTInvalid/,
  /JOSEAlgNotAllowed/,
  /JOSENotSupported/,
  /JWKInvalid/,
  /header\.kid must not be empty/,
  /failed to fetch matching key/,
];

/**
 * @param {unknown} error An error thrown by `SessionValidator.validateSession`.
 * @return {boolean} Whether it indicates the token itself was rejected, as
 *   opposed to an infrastructure failure while validating it.
 */
function isTokenRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TOKEN_REJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header value.
 *
 * @param {string | undefined} header The raw Authorization header value.
 * @return {string | null} The bearer token, or null if absent or malformed.
 */
export function getBearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

/**
 * @param {unknown} aud The token's `aud` claim (a string or string array).
 * @param {string} expected The trusted expected audience.
 * @return {boolean} Whether `aud` is, or contains, `expected`.
 */
function hasAudience(aud: unknown, expected: string): boolean {
  return aud === expected || (Array.isArray(aud) && aud.includes(expected));
}

/**
 * Validates a Descope session token and resolves the caller's identity.
 *
 * @param {string | null | undefined} sessionToken The Descope session JWT.
 * @param {SessionValidator} validator Descope client (defaults to the shared
 *   client; injectable for tests).
 * @return {Promise<VerifiedSession>} The verified caller identity.
 * @throws {HttpsError} `unauthenticated` (401) if the token is missing,
 *   invalid, expired, issued for another audience, or has no subject.
 * @throws {HttpsError} `unavailable` (503) if the session could not be
 *   validated due to an infrastructure failure (e.g. Descope's signing
 *   keys could not be fetched) rather than a rejected token. Callers must
 *   not treat this as an authentication failure — in particular, the
 *   frontend must not sign the user out because of it.
 * @throws {Error} If `DESCOPE_PROJECT_ID` is not configured (a server
 *   misconfiguration, deliberately not reported as a client auth failure).
 */
export async function verifyDescopeSession(
  sessionToken: string | null | undefined,
  validator: SessionValidator = getDescopeClient(),
): Promise<VerifiedSession> {
  if (!sessionToken) {
    throw new HttpsError("unauthenticated", "A session token is required.");
  }

  const expectedAudience = getDescopeProjectId();
  const invalidSession = () => new HttpsError(
    "unauthenticated",
    "The session is invalid or has expired.",
  );
  const serviceUnavailable = () => new HttpsError(
    "unavailable",
    "The session could not be validated right now. Please try again.",
  );

  let authInfo: AuthenticationInfo;
  try {
    authInfo = await validator.validateSession(sessionToken, {
      audience: expectedAudience,
    });
  } catch (error) {
    // A validator that already throws HttpsError (the real Descope SDK
    // never does — see TOKEN_REJECTION_PATTERNS — but a test double
    // legitimately might) has already made this call; respect it as-is
    // instead of reclassifying it by message text.
    if (error instanceof HttpsError) {
      throw error;
    }
    throw isTokenRejection(error) ? invalidSession() : serviceUnavailable();
  }

  // Defense in depth: enforce the audience here too, rather than relying
  // solely on the SDK (which skips the check for a falsy audience option).
  if (!hasAudience(authInfo.token.aud, expectedAudience)) {
    throw invalidSession();
  }

  const userId = authInfo.token.sub;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new HttpsError(
      "unauthenticated",
      "The session token has no subject.",
    );
  }

  return {userId, claims: authInfo.token};
}

/**
 * Authenticates an HTTPS (`onRequest`) function request from its
 * `Authorization: Bearer <sessionToken>` header.
 *
 * @param {{headers: {authorization?: string}}} request The incoming request.
 * @param {SessionValidator} validator Descope client (injectable for tests).
 * @return {Promise<VerifiedSession>} The verified caller identity.
 * @throws {HttpsError} `unauthenticated` (401) if the session is rejected,
 *   or `unavailable` (503) if it could not be validated right now (see
 *   `verifyDescopeSession`). Handlers should respond with
 *   `error.httpErrorCode.status` either way.
 */
export async function authenticateRequest(
  request: {headers: {authorization?: string}},
  validator?: SessionValidator,
): Promise<VerifiedSession> {
  return verifyDescopeSession(
    getBearerToken(request.headers.authorization),
    validator,
  );
}

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
 * @throws {HttpsError} `unauthenticated` if the token is missing, invalid,
 *   expired, issued for another audience, or has no subject.
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

  let authInfo: AuthenticationInfo;
  try {
    authInfo = await validator.validateSession(sessionToken, {
      audience: expectedAudience,
    });
  } catch {
    throw invalidSession();
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
 * @throws {HttpsError} `unauthenticated` if the session cannot be verified;
 *   handlers should respond with `error.httpErrorCode.status` (401).
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

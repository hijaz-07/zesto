import * as logger from "firebase-functions/logger";

/**
 * Fields logged for every `api` request. Deliberately a closed set: there is
 * no way to pass through arbitrary request data, so a caller of `logRequest`
 * cannot accidentally log an Authorization header, a session/refresh token,
 * a phone number, an email address, or a raw request body.
 */
export interface RequestLogFields {
  requestId: string;
  route: string;
  method: string;
  status: number;
  /** Milliseconds from request start to response sent. */
  duration: number;
  /** The authenticated caller's Descope user ID, if any. */
  userId?: string;
}

/**
 * Logs one structured line for a completed `api` request.
 *
 * @param {RequestLogFields} fields The fields to log.
 */
export function logRequest(fields: RequestLogFields): void {
  logger.info("api request", fields);
}

/**
 * Logs an unexpected (non-`ApiResult`) failure while handling a request.
 * Only the request ID and route are attached — the error itself is passed
 * as Cloud Logging's own `error` field rather than interpolated into a
 * message, so nothing about the request (headers, body, tokens) leaks
 * through an error message.
 *
 * @param {string} requestId This request's ID.
 * @param {string} route The normalized route path.
 * @param {unknown} error The thrown value.
 */
export function logUnhandledError(
  requestId: string,
  route: string,
  error: unknown,
): void {
  logger.error("unhandled api error", {requestId, route, error});
}

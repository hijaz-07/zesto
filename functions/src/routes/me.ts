import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {authenticateRequest, type SessionValidator} from "../auth/session";
import {getOrCreateUserProfile, toUserProfileResponse} from "../domain/users";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";

export interface MeRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/**
 * Builds the routes for `/me`, closing over the dependencies (Firestore,
 * and optionally a test `SessionValidator`) they need.
 *
 * @param {MeRouteDeps} deps The route's dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createMeRoutes(deps: MeRouteDeps): RouteDefinition[] {
  return [
    {method: "GET", path: "/me", handler: (ctx) => handleGetMe(ctx, deps)},
  ];
}

/**
 * @param {NormalizedRequest} request The incoming request.
 * @return {string | undefined} The raw `Authorization` header value.
 */
function authorizationHeader(request: NormalizedRequest): string | undefined {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `GET /me`: returns the caller's profile, creating it on first call.
 *
 * The caller's identity comes ONLY from the verified Descope session —
 * never from `request.query`, `request.body`, or any header other than
 * `Authorization` — so a forged `userId` anywhere else in the request has
 * no effect.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MeRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetMe(
  ctx: RouteContext,
  deps: MeRouteDeps,
): Promise<ApiResult> {
  let userId: string;
  try {
    const session = await authenticateRequest(
      {headers: {authorization: authorizationHeader(ctx.request)}},
      deps.validator,
    );
    userId = session.userId;
  } catch (error) {
    return mapAuthError(error);
  }

  const profile = await getOrCreateUserProfile(deps.db, userId);
  return {
    kind: "success",
    status: 200,
    data: toUserProfileResponse(profile),
    userId,
  };
}

/**
 * Maps an authentication failure to its response: `401` for a rejected
 * token, `503` for an infrastructure failure while validating it. Anything
 * else is not an authentication failure at all, so it is rethrown for the
 * caller's generic-error handling.
 *
 * @param {unknown} error The error thrown by `authenticateRequest`.
 * @return {ApiResult} The mapped error result.
 */
function mapAuthError(error: unknown): ApiResult {
  if (!(error instanceof HttpsError)) {
    throw error;
  }

  const status = error.httpErrorCode.status;
  if (status === 401) {
    return {
      kind: "error",
      status,
      code: "unauthenticated",
      message: error.message,
      headers: {"WWW-Authenticate": "Bearer"},
    };
  }

  return {
    kind: "error",
    status,
    code: status === 503 ? "unavailable" : "internal",
    message: error.message,
  };
}

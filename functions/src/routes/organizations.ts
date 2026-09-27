import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {ZodError} from "zod";
import {authenticateRequest, type SessionValidator} from "../auth/session";
import {
  createOrganization,
  createOrganizationBodySchema,
  listOrganizationsForUser,
  toOrganizationMembershipResponse,
  toOrganizationResponse,
} from "../domain/organizations";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";

export interface OrganizationsRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/**
 * Builds the routes for `/organizations`, closing over the dependencies
 * (Firestore, and optionally a test `SessionValidator`) they need.
 *
 * @param {OrganizationsRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createOrganizationRoutes(
  deps: OrganizationsRouteDeps,
): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/organizations",
      handler: (ctx) => handlePostOrganizations(ctx, deps),
    },
    {
      method: "GET",
      path: "/organizations",
      handler: (ctx) => handleGetOrganizations(ctx, deps),
    },
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
 * `POST /organizations`: creates a new organization and makes the caller its
 * owner. The caller's identity comes ONLY from the verified Descope session —
 * any `ownerId`, `userId`, `createdBy`, `role`, `status`, or `id` field in the
 * request body is ignored, never used as authority.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrganizationsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePostOrganizations(
  ctx: RouteContext,
  deps: OrganizationsRouteDeps,
): Promise<ApiResult> {
  let userId: string;
  try {
    const session = await authenticateRequest(
      {headers: {authorization: authorizationHeader(ctx.request)}},
      deps.validator,
    );
    userId = session.userId;
  } catch (error) {
    return mapKnownError(error);
  }

  const parsedBody = createOrganizationBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const {organization, membership} = await createOrganization(
      deps.db,
      userId,
      parsedBody.data,
    );
    return {
      kind: "success",
      status: 201,
      data: {
        organization: toOrganizationResponse(organization),
        membership: toOrganizationMembershipResponse(membership),
      },
      userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `GET /organizations`: returns the organizations where the caller has an
 * ACTIVE membership (never `invited`/`revoked` memberships, and never an
 * organization the caller has no membership in at all).
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrganizationsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetOrganizations(
  ctx: RouteContext,
  deps: OrganizationsRouteDeps,
): Promise<ApiResult> {
  let userId: string;
  try {
    const session = await authenticateRequest(
      {headers: {authorization: authorizationHeader(ctx.request)}},
      deps.validator,
    );
    userId = session.userId;
  } catch (error) {
    return mapKnownError(error);
  }

  const organizations = await listOrganizationsForUser(deps.db, userId);
  return {
    kind: "success",
    status: 200,
    data: {organizations},
    userId,
  };
}

/**
 * @param {ZodError} error A failed `safeParse` result's error.
 * @return {string} The first validation issue's message, or a generic
 *   fallback if the error has none.
 */
function firstZodIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? "Invalid request body.";
}

/**
 * Maps an `HttpsError` thrown by the auth boundary (`authenticateRequest`)
 * or the domain layer (`createOrganization`'s slug-conflict) to its response.
 * Anything else — including a non-`HttpsError` — is not a known failure, so
 * it is rethrown for the caller's generic 500 handling.
 *
 * @param {unknown} error The thrown error.
 * @return {ApiResult} The mapped error result.
 */
function mapKnownError(error: unknown): ApiResult {
  if (!(error instanceof HttpsError)) {
    throw error;
  }

  const status = error.httpErrorCode.status;
  switch (status) {
  case 401:
    return {
      kind: "error",
      status,
      code: "unauthenticated",
      message: error.message,
      headers: {"WWW-Authenticate": "Bearer"},
    };
  case 409:
    return {
      kind: "error",
      status,
      code: "already_exists",
      message: error.message,
    };
  case 503:
    return {kind: "error", status, code: "unavailable", message: error.message};
  default:
    return {kind: "error", status, code: "internal", message: error.message};
  }
}

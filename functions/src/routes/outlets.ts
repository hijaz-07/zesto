import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {ZodError} from "zod";
import type {
  OrganizationMemberRole,
  OrganizationMembership,
} from "../auth/membership";
import {requireOrganizationRole} from "../auth/membership";
import {
  authenticateRequest,
  type SessionValidator,
  type VerifiedSession,
} from "../auth/session";
import {
  createOutlet,
  createOutletBodySchema,
  listOutletsForOrganization,
  toOutletResponse,
  updateOutlet,
  updateOutletBodySchema,
} from "../domain/outlets";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";

export interface OutletsRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/** Roles that may create, edit, activate, or deactivate outlets. */
const MANAGE_ROLES: readonly OrganizationMemberRole[] = ["owner", "manager"];

/** Roles that may view outlets (every active member, including staff). */
const VIEW_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

/**
 * Builds the routes for `/organizations/{organizationId}/outlets`, closing
 * over the dependencies (Firestore, and optionally a test `SessionValidator`)
 * they need.
 *
 * @param {OutletsRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createOutletRoutes(deps: OutletsRouteDeps): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/organizations/:organizationId/outlets",
      handler: (ctx) => handlePostOutlets(ctx, deps),
    },
    {
      method: "GET",
      path: "/organizations/:organizationId/outlets",
      handler: (ctx) => handleGetOutlets(ctx, deps),
    },
    {
      method: "PATCH",
      path: "/organizations/:organizationId/outlets/:outletId",
      handler: (ctx) => handlePatchOutlet(ctx, deps),
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

/** What a caller must have to proceed past `authenticateAndAuthorize`. */
interface AuthorizedCaller {
  session: VerifiedSession;
  membership: OrganizationMembership;
}

/**
 * Authenticates the caller, then requires an active membership with one of
 * `allowedRoles` in the route's `:organizationId`. The single place every
 * outlet handler starts from, so authentication always runs before
 * authorization and authorization always runs before touching the request
 * body — a caller who isn't an authorized member never learns whether their
 * body would otherwise have been valid.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OutletsRouteDeps} deps The route's dependencies.
 * @param {readonly OrganizationMemberRole[]} allowedRoles Roles permitted to
 *   proceed.
 * @return {Promise<AuthorizedCaller>} The verified session and the caller's
 *   authorized membership.
 * @throws {HttpsError} Whatever `authenticateRequest` or
 *   `requireOrganizationRole` throws (401, 400, or 403).
 */
async function authenticateAndAuthorize(
  ctx: RouteContext,
  deps: OutletsRouteDeps,
  allowedRoles: readonly OrganizationMemberRole[],
): Promise<AuthorizedCaller> {
  const session = await authenticateRequest(
    {headers: {authorization: authorizationHeader(ctx.request)}},
    deps.validator,
  );
  const membership = await requireOrganizationRole(
    deps.db, session, ctx.params?.organizationId, allowedRoles,
  );
  return {session, membership};
}

/**
 * `POST /organizations/{organizationId}/outlets`: creates a new outlet in
 * the target organization. Only an active `owner`/`manager` member may
 * create one. `status` is never accepted from the request body — a new
 * outlet always starts `"active"` — and `createdBy`/`createdAt`/`updatedAt`/
 * `id`/`organizationId` all come from the backend.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OutletsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePostOutlets(
  ctx: RouteContext,
  deps: OutletsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  const parsedBody = createOutletBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const outlet = await createOutlet(
      deps.db, membership.organizationId, session.userId, parsedBody.data,
    );
    return {
      kind: "success",
      status: 201,
      data: {outlet: toOutletResponse(outlet)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `GET /organizations/{organizationId}/outlets`: lists every outlet in the
 * target organization, active and inactive alike. Any active member —
 * `owner`, `manager`, or `staff` — may view the list.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OutletsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetOutlets(
  ctx: RouteContext,
  deps: OutletsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, VIEW_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  const outlets =
    await listOutletsForOrganization(deps.db, membership.organizationId);
  return {
    kind: "success",
    status: 200,
    data: {outlets},
    userId: session.userId,
  };
}

/**
 * `PATCH /organizations/{organizationId}/outlets/{outletId}`: edits an
 * existing outlet's `name`/`description`/`phone`/`address`/`location`/
 * `status`. Only an active `owner`/`manager` member may update. `slug`,
 * `id`, `organizationId`, `createdBy`, and `createdAt` can never be changed
 * through this endpoint.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OutletsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePatchOutlet(
  ctx: RouteContext,
  deps: OutletsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  const parsedBody = updateOutletBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const outlet = await updateOutlet(
      deps.db, membership.organizationId, ctx.params?.outletId, parsedBody.data,
    );
    return {
      kind: "success",
      status: 200,
      data: {outlet: toOutletResponse(outlet)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
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
 * Maps an `HttpsError` thrown by the auth boundary (`authenticateRequest`),
 * the tenant-authorization boundary (`requireOrganizationRole`), or the
 * domain layer (`createOutlet`'s slug-conflict, `updateOutlet`'s not-found)
 * to its response. Anything else — including a non-`HttpsError` — is not a
 * known failure, so it is rethrown for the caller's generic 500 handling.
 *
 * @param {unknown} error The thrown error.
 * @return {ApiResult} The mapped error result.
 */
function mapKnownError(error: unknown): ApiResult {
  if (!(error instanceof HttpsError)) {
    throw error;
  }

  const status = error.httpErrorCode.status;
  const message = error.message;
  switch (status) {
  case 400:
    return {kind: "error", status, code: "invalid_argument", message};
  case 401:
    return {
      kind: "error",
      status,
      code: "unauthenticated",
      message,
      headers: {"WWW-Authenticate": "Bearer"},
    };
  case 403:
    return {kind: "error", status, code: "permission_denied", message};
  case 404:
    return {kind: "error", status, code: "not_found", message};
  case 409:
    return {kind: "error", status, code: "already_exists", message};
  case 503:
    return {kind: "error", status, code: "unavailable", message};
  default:
    return {kind: "error", status, code: "internal", message};
  }
}

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
  listOrganizationOrders,
  listOrganizationOrdersQuerySchema,
} from "../domain/organizationOrders";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";

export interface OrganizationOrdersRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/**
 * Roles that may view the organization's orders: every active member,
 * including staff — the same set that may view outlets, menus, and menu
 * items. This checkpoint's order access is read-only; there is deliberately no
 * order-mutating route here, so no manage-roles set exists yet.
 */
const VIEW_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

/**
 * Builds the routes for `/organizations/{organizationId}/orders` — the
 * organization-side, read-only counterpart of the customer's `GET /orders`
 * (see `routes/orders.ts`). Unlike that identity-scoped endpoint, this one is
 * tenant-scoped like `routes/outlets.ts`/`routes/menus.ts`: the organization is
 * named in the path, and what that name is worth is decided by the caller's
 * own active membership, never by the name itself.
 *
 * @param {OrganizationOrdersRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createOrganizationOrderRoutes(
  deps: OrganizationOrdersRouteDeps,
): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/organizations/:organizationId/orders",
      handler: (ctx) => handleGetOrganizationOrders(ctx, deps),
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
 * `allowedRoles` in the route's `:organizationId`. Authentication always runs
 * before authorization, and authorization before the query string is even
 * looked at — a caller who isn't an authorized member never learns whether
 * their query would otherwise have been valid.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrganizationOrdersRouteDeps} deps The route's dependencies.
 * @param {readonly OrganizationMemberRole[]} allowedRoles Roles permitted to
 *   proceed.
 * @return {Promise<AuthorizedCaller>} The verified session and the caller's
 *   authorized membership.
 * @throws {HttpsError} Whatever `authenticateRequest` or
 *   `requireOrganizationRole` throws (401, 400, or 403).
 */
async function authenticateAndAuthorize(
  ctx: RouteContext,
  deps: OrganizationOrdersRouteDeps,
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
 * `GET /organizations/{organizationId}/orders`: one page of the organization's
 * orders, newest first, optionally narrowed to one of its outlets with
 * `?outletId=`. Any active `owner`/`manager`/`staff` member may read it.
 *
 * The scope is the organization of the caller's verified membership
 * (`membership.organizationId`), not the path value as received. `outletId` is
 * only a requested filter: the domain layer confirms it is an outlet of that
 * organization (404 otherwise) before using it. The response carries no
 * customer identity and no payment-provider data (see
 * `OrganizationOrderSummaryResponse`).
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrganizationOrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome: `200` with
 *   `{orders, nextCursor}` — an empty `orders` for an organization with none.
 */
async function handleGetOrganizationOrders(
  ctx: RouteContext,
  deps: OrganizationOrdersRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, VIEW_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  const parsedQuery = listOrganizationOrdersQuerySchema.safeParse(ctx.request.query);
  if (!parsedQuery.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedQuery.error),
    };
  }

  try {
    const page = await listOrganizationOrders(deps.db, membership.organizationId, parsedQuery.data);
    return {kind: "success", status: 200, data: page, userId: session.userId};
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
  return error.issues[0]?.message ?? "Invalid request.";
}

/**
 * Maps an `HttpsError` thrown by the auth boundary (`authenticateRequest`),
 * the tenant-authorization boundary (`requireOrganizationRole`), or the
 * domain layer (a malformed cursor, an unknown outlet) to its response.
 * Anything else — including a non-`HttpsError` — is not a known failure, so
 * it is rethrown for the caller's generic 500 handling. Duplicated per route
 * file, matching this codebase's established convention.
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
  case 503:
    return {kind: "error", status, code: "unavailable", message};
  default:
    return {kind: "error", status, code: "internal", message};
  }
}

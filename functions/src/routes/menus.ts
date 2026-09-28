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
import {getOutlet, type Outlet} from "../domain/outlets";
import {
  archiveMenu,
  createMenu,
  createMenuBodySchema,
  getMenu,
  listMenusForOutlet,
  publishMenu,
  toMenuResponse,
  updateMenu,
  updateMenuBodySchema,
} from "../domain/menus";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";

export interface MenusRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/** Roles that may create, edit, publish, or archive menus. */
const MANAGE_ROLES: readonly OrganizationMemberRole[] = ["owner", "manager"];

/** Roles that may view menus (every active member, including staff). */
const VIEW_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

/**
 * Builds the routes for
 * `/organizations/{organizationId}/outlets/{outletId}/menus`, closing over
 * the dependencies (Firestore, and optionally a test `SessionValidator`)
 * they need.
 *
 * @param {MenusRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createMenuRoutes(deps: MenusRouteDeps): RouteDefinition[] {
  const base = "/organizations/:organizationId/outlets/:outletId/menus";
  return [
    {
      method: "POST",
      path: base,
      handler: (ctx) => handlePostMenus(ctx, deps),
    },
    {
      method: "GET",
      path: base,
      handler: (ctx) => handleGetMenus(ctx, deps),
    },
    {
      method: "GET",
      path: `${base}/:menuId`,
      handler: (ctx) => handleGetMenu(ctx, deps),
    },
    {
      method: "PATCH",
      path: `${base}/:menuId`,
      handler: (ctx) => handlePatchMenu(ctx, deps),
    },
    {
      method: "POST",
      path: `${base}/:menuId/publish`,
      handler: (ctx) => handlePostPublish(ctx, deps),
    },
    {
      method: "POST",
      path: `${base}/:menuId/archive`,
      handler: (ctx) => handlePostArchive(ctx, deps),
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
 * `allowedRoles` in the route's `:organizationId`. Menu's authorization is
 * purely organization-scoped, identical to Outlet's — there is no separate
 * outlet-level or menu-level role. Runs before the outlet is looked up and
 * before the request body is ever parsed, matching `routes/outlets.ts`'s
 * invariant: a caller who isn't an authorized member never learns whether
 * the outlet exists, or whether their body would otherwise have been valid.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @param {readonly OrganizationMemberRole[]} allowedRoles Roles permitted to
 *   proceed.
 * @return {Promise<AuthorizedCaller>} The verified session and the caller's
 *   authorized membership.
 * @throws {HttpsError} Whatever `authenticateRequest` or
 *   `requireOrganizationRole` throws (401, 400, or 403).
 */
async function authenticateAndAuthorize(
  ctx: RouteContext,
  deps: MenusRouteDeps,
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
 * Confirms the route's `:outletId` exists and belongs to `organizationId`,
 * and — for a mutation that requires an active outlet — that its status is
 * `"active"`. Deliberately a separate, non-transactional read from whatever
 * Firestore transaction the eventual menu domain call runs (create/update/
 * publish each open their own): this accepts a narrow, low-consequence
 * TOCTOU race (the outlet could in principle be deactivated in the
 * microseconds between this check and the menu write) in exchange for
 * keeping `domain/menus.ts` free of any dependency on `domain/outlets.ts`.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @param {string} organizationId The caller's already-authorized organization.
 * @param {{requireActive: boolean}} options Whether this operation requires
 *   the outlet to currently be active.
 * @return {Promise<Outlet>} The outlet.
 * @throws {HttpsError} `not-found` (404) if no such outlet exists in this
 *   organization; `failed-precondition` (400) if `requireActive` and the
 *   outlet is `"inactive"`.
 */
async function requireOutlet(
  ctx: RouteContext,
  deps: MenusRouteDeps,
  organizationId: string,
  options: {requireActive: boolean},
): Promise<Outlet> {
  const outlet =
    await getOutlet(deps.db, organizationId, ctx.params?.outletId);
  if (options.requireActive && outlet.status !== "active") {
    throw new HttpsError("failed-precondition", "This outlet is not active.");
  }
  return outlet;
}

/**
 * `POST .../menus`: creates a new draft menu for the target outlet. Only an
 * active `owner`/`manager` member may create one, and only for an active
 * outlet. `status` is never accepted from the request body — a new menu
 * always starts `"draft"` — and `createdBy`/`createdAt`/`updatedAt`/`id`/
 * `organizationId`/`outletId` all come from the backend.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePostMenus(
  ctx: RouteContext,
  deps: MenusRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: true},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  const parsedBody = createMenuBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const menu = await createMenu(
      deps.db, membership.organizationId, outlet.id, session.userId,
      parsedBody.data,
    );
    return {
      kind: "success",
      status: 201,
      data: {menu: toMenuResponse(menu)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `GET .../menus`: lists every menu in the target outlet, every lifecycle
 * state alike. Any active member — `owner`, `manager`, or `staff` — may
 * view the list, and the outlet may be inactive (existing menus on an
 * inactive outlet remain readable).
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetMenus(
  ctx: RouteContext,
  deps: MenusRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, VIEW_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: false},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  const menus =
    await listMenusForOutlet(deps.db, membership.organizationId, outlet.id);
  return {
    kind: "success",
    status: 200,
    data: {menus},
    userId: session.userId,
  };
}

/**
 * `GET .../menus/{menuId}`: reads a single menu. Any active member may view
 * it, and the outlet may be inactive.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetMenu(
  ctx: RouteContext,
  deps: MenusRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, VIEW_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: false},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    const menu = await getMenu(
      deps.db, membership.organizationId, outlet.id, ctx.params?.menuId,
    );
    return {
      kind: "success",
      status: 200,
      data: {menu: toMenuResponse(menu)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `PATCH .../menus/{menuId}`: edits an existing menu's `menuDate`/`title`/
 * `description`/`orderingOpensAt`/`orderingClosesAt`/`pickupStartsAt`/
 * `pickupEndsAt`. Only an active `owner`/`manager` member may update, and
 * only for an active outlet. `status`, `id`, `organizationId`, `outletId`,
 * `createdBy`, `createdAt`, and `publishedAt` can never be changed through
 * this endpoint — status changes are explicit lifecycle operations (see
 * `handlePostPublish`/`handlePostArchive`).
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePatchMenu(
  ctx: RouteContext,
  deps: MenusRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: true},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  const parsedBody = updateMenuBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const menu = await updateMenu(
      deps.db, membership.organizationId, outlet.id, ctx.params?.menuId,
      parsedBody.data,
    );
    return {
      kind: "success",
      status: 200,
      data: {menu: toMenuResponse(menu)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `POST .../menus/{menuId}/publish`: an explicit lifecycle operation, not a
 * generic PATCH. Requires the menu is currently `draft`, the outlet is
 * active, and (enforced inside `publishMenu` itself, against real
 * Firestore item documents) the menu has at least one enabled item. Takes
 * no request body.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePostPublish(
  ctx: RouteContext,
  deps: MenusRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: true},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    const menu = await publishMenu(
      deps.db, membership.organizationId, outlet.id, ctx.params?.menuId,
    );
    return {
      kind: "success",
      status: 200,
      data: {menu: toMenuResponse(menu)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `POST .../menus/{menuId}/archive`: an explicit lifecycle operation.
 * Requires the menu is currently `published`. Unlike the other mutating
 * endpoints, does NOT require the outlet to be active — archiving an
 * already-published menu is a cleanup/historical action, allowed even if
 * the outlet has since been deactivated. Takes no request body.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenusRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePostArchive(
  ctx: RouteContext,
  deps: MenusRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: false},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    const menu = await archiveMenu(
      deps.db, membership.organizationId, outlet.id, ctx.params?.menuId,
    );
    return {
      kind: "success",
      status: 200,
      data: {menu: toMenuResponse(menu)},
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
 * the tenant-authorization boundary (`requireOrganizationRole`), the
 * outlet-dependency check (`requireOutlet`), or the domain layer
 * (`getMenu`/`updateMenu`/`publishMenu`/`archiveMenu`'s not-found and
 * failed-precondition cases) to its response. Anything else — including a
 * non-`HttpsError` — is not a known failure, so it is rethrown for the
 * caller's generic 500 handling. Introduces no new status codes beyond what
 * `routes/outlets.ts` already maps: every Menu-specific "wrong lifecycle
 * state" failure (archived, ordering closed, outlet inactive, publish
 * requires draft, archive requires published, schedule violations) is
 * thrown as `HttpsError("failed-precondition", ...)`, which lands on the
 * existing 400 branch below.
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

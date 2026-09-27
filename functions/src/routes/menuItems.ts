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
  createMenuItem,
  createMenuItemBodySchema,
  deleteMenuItem,
  findItemDeletionViolation,
  findItemMutationViolation,
  getMenuItem,
  listMenuItemsForMenu,
  toMenuItemResponse,
  updateMenuItem,
  updateMenuItemBodySchema,
} from "../domain/menuItems";
import {getMenu, type Menu} from "../domain/menus";
import {getOutlet, type Outlet} from "../domain/outlets";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";

export interface MenuItemsRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/** Roles that may create, edit, enable/disable, reorder, or delete items. */
const MANAGE_ROLES: readonly OrganizationMemberRole[] = ["owner", "manager"];

/** Roles that may view items (every active member, including staff). */
const VIEW_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

/**
 * Builds the routes for
 * `/organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items`,
 * closing over the dependencies (Firestore, and optionally a test
 * `SessionValidator`) they need.
 *
 * @param {MenuItemsRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createMenuItemRoutes(
  deps: MenuItemsRouteDeps,
): RouteDefinition[] {
  const base =
    "/organizations/:organizationId/outlets/:outletId/menus/:menuId/items";
  return [
    {
      method: "POST",
      path: base,
      handler: (ctx) => handlePostItems(ctx, deps),
    },
    {
      method: "GET",
      path: base,
      handler: (ctx) => handleGetItems(ctx, deps),
    },
    {
      method: "GET",
      path: `${base}/:itemId`,
      handler: (ctx) => handleGetItem(ctx, deps),
    },
    {
      method: "PATCH",
      path: `${base}/:itemId`,
      handler: (ctx) => handlePatchItem(ctx, deps),
    },
    {
      method: "DELETE",
      path: `${base}/:itemId`,
      handler: (ctx) => handleDeleteItem(ctx, deps),
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
 * `allowedRoles` in the route's `:organizationId`. Menu Item's authorization
 * is purely organization-scoped, identical to Outlet's/Menu's — there is no
 * separate outlet-level, menu-level, or item-level role. Runs before the
 * outlet/menu are looked up and before the request body is ever parsed,
 * matching `routes/menus.ts`'s invariant: a caller who isn't an authorized
 * member never learns whether the outlet/menu exist, or whether their body
 * would otherwise have been valid.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
 * @param {readonly OrganizationMemberRole[]} allowedRoles Roles permitted to
 *   proceed.
 * @return {Promise<AuthorizedCaller>} The verified session and the caller's
 *   authorized membership.
 * @throws {HttpsError} Whatever `authenticateRequest` or
 *   `requireOrganizationRole` throws (401, 400, or 403).
 */
async function authenticateAndAuthorize(
  ctx: RouteContext,
  deps: MenuItemsRouteDeps,
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
 * `"active"`. Deliberately a separate, non-transactional read (see
 * `routes/menus.ts`'s identical `requireOutlet`, which this duplicates
 * rather than imports, matching this codebase's per-route-file convention).
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
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
  deps: MenuItemsRouteDeps,
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
 * Confirms the route's `:menuId` exists and belongs to `organizationId`/
 * `outletId` (via `getMenu`, which already handles a malformed, nonexistent,
 * or cross-tenant menu ID with the established secure-not-found behavior),
 * and, for a mutation, that the menu's current lifecycle state and ordering
 * window allow it. Mirrors `requireOutlet`'s shape and reasoning: a
 * non-transactional read, accepting the same narrow, low-consequence TOCTOU
 * race in exchange for keeping `domain/menuItems.ts` free of any dependency
 * on `domain/menus.ts`'s Firestore access — only the pure violation checks
 * (`findItemMutationViolation`/`findItemDeletionViolation`) are reused here.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
 * @param {string} organizationId The caller's already-authorized organization.
 * @param {string} outletId The already-verified outlet.
 * @param {{mutation: "none" | "write" | "delete"}} options Which gate, if
 *   any, to apply: `"none"` for a read (never gated — historical menu/item
 *   data must always remain readable), `"write"` for create/update
 *   (`findItemMutationViolation`), `"delete"` for the stricter draft-only
 *   rule (`findItemDeletionViolation`).
 * @return {Promise<Menu>} The menu.
 * @throws {HttpsError} `not-found` (404) if no such menu exists in this
 *   outlet; `failed-precondition` (400) if a mutation was requested and the
 *   menu's state/ordering-window currently forbids it.
 */
async function requireMenu(
  ctx: RouteContext,
  deps: MenuItemsRouteDeps,
  organizationId: string,
  outletId: string,
  options: {mutation: "none" | "write" | "delete"},
): Promise<Menu> {
  const menu =
    await getMenu(deps.db, organizationId, outletId, ctx.params?.menuId);

  const violation = options.mutation === "write" ?
    findItemMutationViolation(menu) :
    options.mutation === "delete" ?
      findItemDeletionViolation(menu) :
      null;
  if (violation) {
    throw new HttpsError("failed-precondition", violation);
  }

  return menu;
}

/**
 * `POST .../items`: creates a new item on the target menu. Only an active
 * `owner`/`manager` member may create one, only for an active outlet, and
 * only while the parent menu currently accepts item mutations (draft, or
 * published with ordering still open). `enabled` is never accepted from the
 * request body — a new item always starts enabled — and `createdBy`/
 * `createdAt`/`updatedAt`/`id`/`menuId` all come from the backend.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePostItems(
  ctx: RouteContext,
  deps: MenuItemsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  let menu: Menu;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: true},
    );
    menu = await requireMenu(
      ctx, deps, membership.organizationId, outlet.id, {mutation: "write"},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  const parsedBody = createMenuItemBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const item = await createMenuItem(
      deps.db, membership.organizationId, outlet.id, menu.id, session.userId,
      parsedBody.data,
    );
    return {
      kind: "success",
      status: 201,
      data: {item: toMenuItemResponse(item)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `GET .../items`: lists every item on the target menu, enabled and
 * disabled alike. Any active member — `owner`, `manager`, or `staff` — may
 * view the list, the outlet may be inactive, and the menu may be in any
 * lifecycle state (including archived).
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetItems(
  ctx: RouteContext,
  deps: MenuItemsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, VIEW_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  let menu: Menu;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: false},
    );
    menu = await requireMenu(
      ctx, deps, membership.organizationId, outlet.id, {mutation: "none"},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  const items =
    await listMenuItemsForMenu(deps.db, membership.organizationId, outlet.id, menu.id);
  return {
    kind: "success",
    status: 200,
    data: {items},
    userId: session.userId,
  };
}

/**
 * `GET .../items/{itemId}`: reads a single item. Any active member may view
 * it, the outlet may be inactive, and the menu may be in any lifecycle
 * state.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetItem(
  ctx: RouteContext,
  deps: MenuItemsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, VIEW_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  let menu: Menu;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: false},
    );
    menu = await requireMenu(
      ctx, deps, membership.organizationId, outlet.id, {mutation: "none"},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    const item = await getMenuItem(
      deps.db, membership.organizationId, outlet.id, menu.id, ctx.params?.itemId,
    );
    return {
      kind: "success",
      status: 200,
      data: {item: toMenuItemResponse(item)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `PATCH .../items/{itemId}`: edits an existing item's `name`/`description`/
 * `priceInPaise`/`enabled`/`displayOrder`. Only an active `owner`/`manager`
 * member may update, only for an active outlet, and only while the parent
 * menu currently accepts item mutations. `id`, `menuId`, `createdBy`, and
 * `createdAt` can never be changed through this endpoint.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePatchItem(
  ctx: RouteContext,
  deps: MenuItemsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  let menu: Menu;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: true},
    );
    menu = await requireMenu(
      ctx, deps, membership.organizationId, outlet.id, {mutation: "write"},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  const parsedBody = updateMenuItemBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const item = await updateMenuItem(
      deps.db, membership.organizationId, outlet.id, menu.id, ctx.params?.itemId,
      parsedBody.data,
    );
    return {
      kind: "success",
      status: 200,
      data: {item: toMenuItemResponse(item)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `DELETE .../items/{itemId}`: permanently removes an item. Only an active
 * `owner`/`manager` member may delete, only for an active outlet, and only
 * while the parent menu is currently a draft — a published or archived
 * menu must disable the item (`PATCH enabled: false`) instead, never a
 * silent fallback to disabling here.
 *
 * @param {RouteContext} ctx The route context.
 * @param {MenuItemsRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleDeleteItem(
  ctx: RouteContext,
  deps: MenuItemsRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, MANAGE_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  let outlet: Outlet;
  let menu: Menu;
  try {
    outlet = await requireOutlet(
      ctx, deps, membership.organizationId, {requireActive: true},
    );
    menu = await requireMenu(
      ctx, deps, membership.organizationId, outlet.id, {mutation: "delete"},
    );
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    await deleteMenuItem(
      deps.db, membership.organizationId, outlet.id, menu.id, ctx.params?.itemId,
    );
    return {
      kind: "success",
      status: 200,
      data: {},
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
 * outlet/menu-dependency checks (`requireOutlet`/`requireMenu`), or the
 * domain layer (`getMenuItem`/`updateMenuItem`/`deleteMenuItem`'s not-found
 * case) to its response. Anything else — including a non-`HttpsError` — is
 * not a known failure, so it is rethrown for the caller's generic 500
 * handling. Introduces no new status codes beyond what `routes/menus.ts`
 * already maps: every "wrong lifecycle state" failure (outlet inactive,
 * menu archived, ordering closed, delete on a non-draft menu) is thrown as
 * `HttpsError("failed-precondition", ...)`, which lands on the existing 400
 * branch below.
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

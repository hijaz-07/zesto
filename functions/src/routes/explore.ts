import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {
  getCustomerMenuDetail,
  listExploreOutlets,
  listUpcomingPublishedMenusForOutlet,
  resolveActivePublicOutlet,
  toCustomerMenuResponse,
  toExploreOutletsEntryResponse,
  toPublicOutletSummary,
  type CustomerMenuDetailResponse,
  type ExploreOutletsEntryResponse,
  type OutletExplorePageResponse,
} from "../domain/explore";
import type {Outlet} from "../domain/outlets";
import type {ApiResult, RouteContext, RouteDefinition} from "../http/types";

export interface ExploreRouteDeps {
  db: Firestore;
}

/**
 * Builds the public, unauthenticated `/explore` customer-discovery routes:
 * `GET /explore/outlets`, `GET /explore/outlets/{outletId}`, and
 * `GET /explore/outlets/{outletId}/menus/{menuId}` (see
 * docs/architecture/http-api.md#explore). Unlike every other route file in
 * this codebase, none of these handlers call `authenticateRequest` — these
 * three GET endpoints must work identically with or without an
 * `Authorization` header, and never require organization membership. Every
 * other route (`/me`, `/organizations`, outlet/menu/menu-item management)
 * is untouched and remains fully authenticated.
 *
 * @param {ExploreRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createExploreRoutes(deps: ExploreRouteDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/explore/outlets",
      handler: (ctx) => handleGetExploreOutlets(ctx, deps),
    },
    {
      method: "GET",
      path: "/explore/outlets/:outletId",
      handler: (ctx) => handleGetOutletExplorePage(ctx, deps),
    },
    {
      method: "GET",
      path: "/explore/outlets/:outletId/menus/:menuId",
      handler: (ctx) => handleGetCustomerMenuDetail(ctx, deps),
    },
  ];
}

/**
 * `GET /explore/outlets`: the default customer discovery feed. Public — no
 * authentication, no organization membership.
 *
 * @param {RouteContext} ctx The route context.
 * @param {ExploreRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetExploreOutlets(
  ctx: RouteContext,
  deps: ExploreRouteDeps,
): Promise<ApiResult> {
  const entries = await listExploreOutlets(deps.db);
  const outlets: ExploreOutletsEntryResponse[] = entries.map(toExploreOutletsEntryResponse);
  return {kind: "success", status: 200, data: {outlets}};
}

/**
 * `GET /explore/outlets/{outletId}`: one active outlet and its upcoming
 * customer-visible menus (no items). Public — no authentication, no
 * organization membership.
 *
 * @param {RouteContext} ctx The route context.
 * @param {ExploreRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetOutletExplorePage(
  ctx: RouteContext,
  deps: ExploreRouteDeps,
): Promise<ApiResult> {
  let outlet: Outlet;
  try {
    outlet = await resolveActivePublicOutlet(deps.db, ctx.params?.outletId);
  } catch (error) {
    return mapKnownError(error);
  }

  const menus = await listUpcomingPublishedMenusForOutlet(deps.db, outlet);
  const data: OutletExplorePageResponse = {outlet: toPublicOutletSummary(outlet), menus};
  return {kind: "success", status: 200, data};
}

/**
 * `GET /explore/outlets/{outletId}/menus/{menuId}`: one customer-safe
 * published menu and its enabled items. A known link to an already
 * ordering-closed published menu still resolves, read-only. Public — no
 * authentication, no organization membership.
 *
 * @param {RouteContext} ctx The route context.
 * @param {ExploreRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetCustomerMenuDetail(
  ctx: RouteContext,
  deps: ExploreRouteDeps,
): Promise<ApiResult> {
  let outlet: Outlet;
  try {
    outlet = await resolveActivePublicOutlet(deps.db, ctx.params?.outletId);
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    const {menu, items} = await getCustomerMenuDetail(deps.db, outlet, ctx.params?.menuId);
    const data: CustomerMenuDetailResponse = {
      outlet: toPublicOutletSummary(outlet),
      menu: toCustomerMenuResponse(menu, items),
    };
    return {kind: "success", status: 200, data};
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * Maps an `HttpsError` thrown by the domain layer
 * (`resolveActivePublicOutlet`/`getCustomerMenuDetail`) to its response.
 * These public routes have no authentication and no request body to
 * validate, so `not-found` is the only outcome the domain layer ever
 * deliberately throws; anything else — including a non-`HttpsError` — is
 * not a known failure here, so it is rethrown for the caller's generic 500
 * handling.
 *
 * @param {unknown} error The thrown error.
 * @return {ApiResult} The mapped error result.
 */
function mapKnownError(error: unknown): ApiResult {
  if (error instanceof HttpsError && error.httpErrorCode.status === 404) {
    return {kind: "error", status: 404, code: "not_found", message: error.message};
  }
  throw error;
}

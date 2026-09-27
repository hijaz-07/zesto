import type {ApiResult, NormalizedRequest, RouteDefinition} from "./types";

/**
 * Strips a leading `/api` path segment, so the router matches the same
 * routes whether the caller is Firebase Hosting's `/api/**` rewrite (which
 * forwards the original path, e.g. `/api/me`) or a direct call to the
 * function's own emulator URL (which does not carry the prefix).
 *
 * @param {string} rawPath The incoming request path (no query string).
 * @return {string} The path with any leading `/api` removed.
 */
export function normalizePath(rawPath: string): string {
  if (rawPath === "/api") {
    return "/";
  }
  if (rawPath.startsWith("/api/")) {
    return rawPath.slice(4);
  }
  return rawPath;
}

export type RouteMatch =
  | {kind: "found"; route: RouteDefinition; params: Record<string, string>}
  | {kind: "not_found"}
  | {kind: "method_not_allowed"; allowedMethods: string[]};

/** A route whose path pattern matched, paired with its captured params. */
interface MatchedRoute {
  route: RouteDefinition;
  params: Record<string, string>;
}

/**
 * @param {string} path A request or route path.
 * @return {string[]} Its non-empty `/`-separated segments, e.g. "/a/b/" ->
 *   ["a", "b"]. Because both a request path and a route path are split the
 *   same way, a route path can never match by virtue of stray slashes.
 */
function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Matches a single route's path pattern against a request path, capturing
 * any `:name` segments. A `:name` segment matches exactly one non-empty
 * path segment — never a slash, and never an empty segment — so it can't
 * be used to smuggle in extra path structure.
 *
 * @param {string} routePath A registered `RouteDefinition.path`.
 * @param {string} requestPath The already-normalized request path.
 * @return {Record<string, string> | null} The captured params if the
 *   route's path pattern matches, or null if it doesn't.
 */
function matchPath(
  routePath: string,
  requestPath: string,
): Record<string, string> | null {
  const routeSegments = splitPath(routePath);
  const requestSegments = splitPath(requestPath);
  if (routeSegments.length !== requestSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const routeSegment = routeSegments[i];
    const requestSegment = requestSegments[i];
    if (routeSegment.startsWith(":")) {
      params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
    } else if (routeSegment !== requestSegment) {
      return null;
    }
  }
  return params;
}

/**
 * Finds the route for a normalized path and method, distinguishing an
 * unknown path (404) from a known path called with the wrong method (405).
 *
 * @param {readonly RouteDefinition[]} routes The registered routes.
 * @param {string} method The request method (any case).
 * @param {string} path The already-normalized request path.
 * @return {RouteMatch} The match outcome.
 */
export function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  path: string,
): RouteMatch {
  const candidates: MatchedRoute[] = [];
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (params !== null) {
      candidates.push({route, params});
    }
  }
  if (candidates.length === 0) {
    return {kind: "not_found"};
  }

  const upperMethod = method.toUpperCase();
  const match = candidates.find((c) => c.route.method === upperMethod);
  if (!match) {
    return {
      kind: "method_not_allowed",
      allowedMethods: [...new Set(candidates.map((c) => c.route.method))],
    };
  }

  return {kind: "found", route: match.route, params: match.params};
}

/**
 * Routes a normalized request to the matching handler, or produces the
 * appropriate 404 / 405 result when there is no match. This is the single
 * place that turns a `RouteMatch` into an `ApiResult`.
 *
 * @param {readonly RouteDefinition[]} routes The registered routes.
 * @param {NormalizedRequest} request The incoming request.
 * @return {Promise<ApiResult>} The route's outcome.
 */
export async function dispatch(
  routes: readonly RouteDefinition[],
  request: NormalizedRequest,
): Promise<ApiResult> {
  const match = matchRoute(routes, request.method, request.path);

  switch (match.kind) {
  case "not_found":
    return {
      kind: "error",
      status: 404,
      code: "not_found",
      message: "The requested resource was not found.",
    };
  case "method_not_allowed":
    return {
      kind: "error",
      status: 405,
      code: "method_not_allowed",
      message: "This method is not allowed for this resource.",
      headers: {"Allow": match.allowedMethods.join(", ")},
    };
  case "found":
    return match.route.handler({request, params: match.params});
  }
}

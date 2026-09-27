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
  | {kind: "found"; route: RouteDefinition}
  | {kind: "not_found"}
  | {kind: "method_not_allowed"; allowedMethods: string[]};

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
  const samePath = routes.filter((route) => route.path === path);
  if (samePath.length === 0) {
    return {kind: "not_found"};
  }

  const upperMethod = method.toUpperCase();
  const route = samePath.find((r) => r.method === upperMethod);
  if (!route) {
    return {
      kind: "method_not_allowed",
      allowedMethods: [...new Set(samePath.map((r) => r.method))],
    };
  }

  return {kind: "found", route};
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
    return match.route.handler({request});
  }
}

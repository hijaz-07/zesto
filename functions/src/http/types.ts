/**
 * Shared shapes for the `api` HTTP function's internal router. Handlers work
 * against this small, framework-free contract instead of Express's
 * `Request`/`Response` directly, so router matching, envelope building, and
 * route handlers can all be unit tested without spinning up HTTP objects.
 */

/** A request, reduced to the fields the router and handlers need. */
export interface NormalizedRequest {
  method: string;
  /** Path only (no query string), already normalized to strip a leading `/api`. */
  path: string;
  /** Header names are lower-cased, matching Express's `req.headers`. */
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
}

/** A successful route outcome. */
export interface ApiSuccess {
  kind: "success";
  status: number;
  data: unknown;
  /** The authenticated caller, if any, for request logging only. */
  userId?: string;
  headers?: Record<string, string>;
}

/** A failed route outcome, already shaped for the error envelope. */
export interface ApiError {
  kind: "error";
  status: number;
  code: string;
  message: string;
  userId?: string;
  headers?: Record<string, string>;
}

export type ApiResult = ApiSuccess | ApiError;

export interface RouteContext {
  request: NormalizedRequest;
  /**
   * Values captured from `:name` segments in the matched route's `path`
   * (see `router.ts`'s `matchRoute`). Always populated by `dispatch`;
   * optional here only so a hand-built `RouteContext` in a test can omit it
   * for a route with no dynamic segments.
   */
  params?: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<ApiResult>;

export interface RouteDefinition {
  method: string;
  /**
   * Path to match, e.g. "/me". A segment starting with `:` (e.g.
   * "/organizations/:organizationId/outlets") matches any single non-empty
   * path segment and is captured into `RouteContext.params` under that name.
   */
  path: string;
  handler: RouteHandler;
}

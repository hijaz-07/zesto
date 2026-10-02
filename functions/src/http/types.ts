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
  /** The body as the runtime's JSON/text parser decoded it. NEVER use this to verify a signature — see `rawBody`. */
  body: unknown;
  /**
   * The request body's ORIGINAL bytes, exactly as received and before any
   * parsing, as exposed by the Functions runtime (`request.rawBody`). The
   * only correct input for verifying a provider webhook signature (see
   * `providers/razorpay.ts`'s `verifyWebhookSignature`): re-serializing
   * `body` does not reproduce what was signed. Absent only when a test or
   * non-HTTP caller builds a request by hand.
   */
  rawBody?: Buffer;
}

/**
 * Extra, route-curated operational fields to add to the request's single
 * `api request` log line (see `logger.ts`). A route must put only values it
 * knows are safe to log here (identifiers and outcomes — never a header, a
 * body, a token, or a secret); `logRequest` attaches them under one `context`
 * key rather than letting a route add arbitrary top-level log fields.
 */
export type LogContext = Readonly<Record<string, string | number | boolean>>;

/** A successful route outcome. */
export interface ApiSuccess {
  kind: "success";
  status: number;
  data: unknown;
  /** The authenticated caller, if any, for request logging only. */
  userId?: string;
  headers?: Record<string, string>;
  logContext?: LogContext;
}

/** A failed route outcome, already shaped for the error envelope. */
export interface ApiError {
  kind: "error";
  status: number;
  code: string;
  message: string;
  userId?: string;
  headers?: Record<string, string>;
  logContext?: LogContext;
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

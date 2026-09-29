import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {ZodError} from "zod";
import {authenticateRequest, type SessionValidator, type VerifiedSession} from "../auth/session";
import {
  createOrder,
  createOrderBodySchema,
  getOwnedOrder,
  toOrderResponse,
} from "../domain/orders";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";

export interface OrdersRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/**
 * Builds the routes for `/orders` — the customer order-creation and
 * ownership-read API (see docs/architecture/http-api.md and this
 * checkpoint's "Order creation API"/"Order read API" notes). Unlike the
 * organization-management routes (`organizations.ts`/`outlets.ts`/
 * `menus.ts`/`menuItems.ts`), these are NOT nested under
 * `/organizations/{organizationId}/...` — an order's `organizationId` is
 * derived server-side from its `outletId` (see `domain/orders.ts`'s
 * `createOrder`), never supplied or known by the client up front, matching
 * `/me`'s top-level, identity-scoped shape rather than the tenant-scoped
 * routes' shape.
 *
 * @param {OrdersRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createOrderRoutes(deps: OrdersRouteDeps): RouteDefinition[] {
  return [
    {method: "POST", path: "/orders", handler: (ctx) => handlePostOrders(ctx, deps)},
    {method: "GET", path: "/orders/:orderId", handler: (ctx) => handleGetOrder(ctx, deps)},
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
 * `POST /orders`: creates a customer pre-order. The caller's identity comes
 * ONLY from the verified Descope session (`session.userId`) — never from
 * `request.body`, matching `/me`'s established rule. Authenticates before
 * ever parsing the request body, matching every other route in this
 * codebase: an unauthenticated caller never learns whether their body would
 * otherwise have been valid.
 *
 * All pricing, the order's `organizationId`, and its initial `status`/
 * `paymentStatus`/`currency` are determined by `domain/orders.ts`'s
 * `createOrder` from authoritative Firestore data — never trusted from the
 * request body, however the client fills it in.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome. `201` for a newly
 *   created order; `200` when the same (user, `idempotencyKey`) pair safely
 *   replays an already-created order (see `createOrder`'s idempotency
 *   design) — either way, the response body shape is identical.
 */
async function handlePostOrders(
  ctx: RouteContext,
  deps: OrdersRouteDeps,
): Promise<ApiResult> {
  let session: VerifiedSession;
  try {
    session = await authenticateRequest(
      {headers: {authorization: authorizationHeader(ctx.request)}},
      deps.validator,
    );
  } catch (error) {
    return mapKnownError(error);
  }

  const parsedBody = createOrderBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const {order, created} = await createOrder(deps.db, session.userId, parsedBody.data);
    return {
      kind: "success",
      status: created ? 201 : 200,
      data: {order: toOrderResponse(order)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `GET /orders/{orderId}`: reads one order the caller owns. Ownership is
 * verified server-side (`domain/orders.ts`'s `getOwnedOrder`) purely from
 * the order's stored `userId` versus the verified session's `userId` — an
 * organization's own staff/manager/owner has no special access through this
 * endpoint, and an order belonging to a different customer is
 * indistinguishable from a nonexistent one.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetOrder(
  ctx: RouteContext,
  deps: OrdersRouteDeps,
): Promise<ApiResult> {
  let session: VerifiedSession;
  try {
    session = await authenticateRequest(
      {headers: {authorization: authorizationHeader(ctx.request)}},
      deps.validator,
    );
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    const order = await getOwnedOrder(deps.db, session.userId, ctx.params?.orderId);
    return {
      kind: "success",
      status: 200,
      data: {order: toOrderResponse(order)},
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
 * Maps an `HttpsError` thrown by the auth boundary (`authenticateRequest`)
 * or the domain layer (`createOrder`/`getOwnedOrder`) to its response.
 * Duplicated per-route-file, matching this codebase's established
 * convention (see `routes/menuItems.ts`'s identical `mapKnownError`):
 * introduces no new status codes beyond docs/architecture/http-api.md's
 * existing error-semantics table, including reusing `409 already_exists`
 * for an idempotency-key conflict (reusing a key already bound to a
 * different request) — the same "this identifier is already taken" shape
 * `already_exists` covers elsewhere (organization/outlet slugs). Anything
 * else — including a non-`HttpsError` — is not a known failure, so it is
 * rethrown for the caller's generic 500 handling.
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

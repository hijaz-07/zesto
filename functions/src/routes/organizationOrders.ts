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
import {ORDER_CANCELLATION_ROLES} from "../domain/cancellation";
import {cancelOrder, cancelOrderBodySchema, toCancellationResponse} from "../domain/orderCancellation";
import {
  ORDER_FULFILLMENT_ROLES,
  transitionOrderStatus,
  type FulfillmentTarget,
} from "../domain/orderFulfillment";
import {
  ORDER_PICKUP_ROLES,
  redeemPickup,
  redeemPickupBodySchema,
} from "../domain/orderPickup";
import {
  listOrganizationOrders,
  listOrganizationOrdersQuerySchema,
  loadOrganizationOrderSummary,
} from "../domain/organizationOrders";
import {getPickupCredentialSecret} from "../domain/pickupCredential";
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
  /**
   * Injectable for tests; defaults to the `PICKUP_CREDENTIAL_SECRET` param.
   * Called only once a request is authenticated, authorized and well formed,
   * so an unconfigured secret never shows up in the answer to anyone else.
   */
  pickupSecret?: () => string;
}

/**
 * Roles that may view the organization's orders: every active member,
 * including staff — the same set that may view outlets, menus, and menu
 * items. The roles that may change an order's fulfillment state are a separate
 * set, `ORDER_FULFILLMENT_ROLES`, defined with the transition itself (it
 * happens to be the same three roles today, but they are different decisions).
 */
const VIEW_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

/**
 * Builds the organization-side order routes — the counterpart of the
 * customer's `/orders` (see `routes/orders.ts`): the order list, the
 * fulfillment actions, and pickup. Unlike that identity-scoped API, these are
 * tenant-scoped like `routes/outlets.ts`/`routes/menus.ts`: the organization is
 * named in the path, and what that name is worth is decided by the caller's own
 * active membership, never by the name itself.
 *
 * The fulfillment actions (`start-preparing`, `mark-ready`, `complete`) are
 * explicit, body-less operations — like a menu's `publish`/`archive` — not a
 * generic "set status": the target comes from the URL, and everything else (the
 * order's current state, whether it is paid, who is acting) is read from the
 * server. All call the same `transitionOrderStatus`, so the rules exist in
 * exactly one place.
 *
 * Pickup is deliberately NOT one of them. `ready` -> `picked_up` needs a
 * credential, and a credential identifies its own order — a typed backup code
 * does not even carry an order ID — so it is `POST .../pickups`, not a route
 * under an order's ID. No URL that merely names an order can mark it picked up.
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
    {
      method: "POST",
      path: "/organizations/:organizationId/orders/:orderId/start-preparing",
      handler: (ctx) => handleFulfillmentAction(ctx, deps, "preparing"),
    },
    {
      method: "POST",
      path: "/organizations/:organizationId/orders/:orderId/mark-ready",
      handler: (ctx) => handleFulfillmentAction(ctx, deps, "ready"),
    },
    {
      method: "POST",
      path: "/organizations/:organizationId/orders/:orderId/complete",
      handler: (ctx) => handleFulfillmentAction(ctx, deps, "completed"),
    },
    {
      method: "POST",
      path: "/organizations/:organizationId/orders/:orderId/cancel",
      handler: (ctx) => handleCancelOrder(ctx, deps),
    },
    {
      method: "POST",
      path: "/organizations/:organizationId/pickups",
      handler: (ctx) => handleRedeemPickup(ctx, deps),
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
 * `POST /organizations/{organizationId}/orders/{orderId}/start-preparing`,
 * `.../mark-ready` and `.../complete`: moves a paid order to `preparing` /
 * `ready` / `completed`. Any active `owner`/`manager`/`staff` member may do any
 * of them (`ORDER_FULFILLMENT_ROLES`).
 * Takes no request body, so there is nothing for a caller to assert: a body or
 * query string (an `organizationId`, `outletId`, `status`, `userId`, ...) is
 * never read.
 *
 * Authentication, then authorization, run before the order is looked up; the
 * order is then resolved INSIDE the caller's organization by
 * `transitionOrderStatus`, so another organization's order is a plain 404.
 * Repeating an action whose result already holds is a `200` that changes
 * nothing; any other state the order cannot move from is a `409 conflict`.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrganizationOrdersRouteDeps} deps The route's dependencies.
 * @param {FulfillmentTarget} to The status this route moves the order into.
 * @return {Promise<ApiResult>} The route's outcome: `200` with `{order}` — the
 *   order's row in the same shape the list uses.
 */
async function handleFulfillmentAction(
  ctx: RouteContext,
  deps: OrganizationOrdersRouteDeps,
  to: FulfillmentTarget,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, ORDER_FULFILLMENT_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  try {
    const result = await transitionOrderStatus(deps.db, {
      membership,
      orderId: ctx.params?.orderId,
      to,
    });
    const order = await loadOrganizationOrderSummary(deps.db, result.order);
    return {
      kind: "success",
      status: 200,
      data: {order},
      userId: session.userId,
      logContext: {
        from: result.previousStatus,
        to,
        outcome: result.changed ? "transitioned" : "unchanged",
      },
    };
  } catch (error) {
    return {
      ...mapKnownError(error),
      userId: session.userId,
      logContext: {to, outcome: "rejected"},
    };
  }
}

/**
 * `POST /organizations/{organizationId}/pickups`: hands a ready order over to
 * the customer presenting its credential — body `{credential, outletId?}`,
 * where `credential` is the scanned QR payload or the typed backup code. Any
 * active `owner`/`manager`/`staff` member may (`ORDER_PICKUP_ROLES`).
 *
 * Authentication, then authorization, then the body: a caller who is not an
 * authorized member never learns whether their body would have been valid.
 * Only `credential` (and the optional narrowing `outletId`) is read from it —
 * a `status`, `userId`, `organizationId` or `orderId` there is ignored. The
 * credential is never logged, echoed, or part of any response; the log line
 * carries only the outcome and how it was presented.
 *
 * `redeemPickup` verifies the credential and moves the order in one
 * transaction (see its doc comment), so there is no separate verification
 * request to race. A `409` is only ever answered to a caller holding a genuine
 * credential; anything that does not open an order of this organization is the
 * same `404`. Presenting a credential for an order already handed over is a
 * `409`, never a repeat `200`.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrganizationOrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome: `200` with `{order}` — the
 *   order's row in the same shape the list uses (no customer identity).
 */
async function handleRedeemPickup(
  ctx: RouteContext,
  deps: OrganizationOrdersRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, ORDER_PICKUP_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  const parsedBody = redeemPickupBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
      userId: session.userId,
      logContext: {to: "picked_up", outcome: "rejected"},
    };
  }

  try {
    const result = await redeemPickup(deps.db, {
      membership,
      credential: parsedBody.data.credential,
      outletId: parsedBody.data.outletId,
      getSecret: deps.pickupSecret ?? getPickupCredentialSecret,
    });
    const order = await loadOrganizationOrderSummary(deps.db, result.order);
    return {
      kind: "success",
      status: 200,
      data: {order},
      userId: session.userId,
      logContext: {from: "ready", to: "picked_up", outcome: "picked_up", via: result.via},
    };
  } catch (error) {
    return {
      ...mapKnownError(error),
      userId: session.userId,
      logContext: {to: "picked_up", outcome: "rejected"},
    };
  }
}

/**
 * `POST /organizations/{organizationId}/orders/{orderId}/cancel`: the
 * organization cancels one of its own orders — body `{reason}`, where `reason`
 * is REQUIRED and one of the organization reasons. Only an active `owner` or
 * `manager` may (`ORDER_CANCELLATION_ROLES`): cancelling a paid order starts a
 * refund, which is money, so staff are refused (`403`) — unlike fulfillment.
 *
 * Authentication, then authorization, then the body, then the order — like the
 * other organization order routes. The order is resolved by ID and must belong
 * to the caller's verified organization: another organization's order is a plain
 * `404`. Everything else (status, payment consistency, the refund of a paid
 * order, which is always the full remaining amount) is decided server-side by
 * `cancelOrder`; the body's other fields are ignored. A refused state is `409
 * conflict`.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrganizationOrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome: `200` with `{order,
 *   cancellation, refund?}` — the order's row in the same shape the list uses,
 *   the cancellation state, and (when money was captured) a safe refund summary —
 *   for the cancellation and for a repeat that changed nothing. See
 *   `CancellationResponseSummary`: no provider, payment or audit identifier.
 */
async function handleCancelOrder(
  ctx: RouteContext,
  deps: OrganizationOrdersRouteDeps,
): Promise<ApiResult> {
  let caller: AuthorizedCaller;
  try {
    caller = await authenticateAndAuthorize(ctx, deps, ORDER_CANCELLATION_ROLES);
  } catch (error) {
    return mapKnownError(error);
  }
  const {session, membership} = caller;

  const parsedBody = cancelOrderBodySchema.safeParse(ctx.request.body ?? {});
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
      userId: session.userId,
      logContext: {to: "cancelled", outcome: "rejected"},
    };
  }

  try {
    const result = await cancelOrder(deps.db, {
      actor: {kind: "organization", membership},
      orderId: ctx.params?.orderId,
      reason: parsedBody.data.reason,
    });
    const order = await loadOrganizationOrderSummary(deps.db, result.order);
    return {
      kind: "success",
      status: 200,
      data: {order, ...toCancellationResponse(result)},
      userId: session.userId,
      logContext: {
        from: result.previousStatus,
        to: "cancelled",
        outcome: result.changed ? "cancelled" : "unchanged",
        refund: result.refund ? "reserved" : "none",
      },
    };
  } catch (error) {
    return {
      ...mapKnownError(error),
      userId: session.userId,
      logContext: {to: "cancelled", outcome: "rejected"},
    };
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
 * domain layer (a malformed cursor, an unknown outlet or order, a refused
 * fulfillment transition) to its response.
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
  case 409:
    // The order is not in a state this action can act on (or changed under
    // it): a stale or racing request, not a malformed one. Distinct from
    // `already_exists`, which the other routes use for taken slugs/keys.
    return {kind: "error", status, code: "conflict", message};
  case 503:
    return {kind: "error", status, code: "unavailable", message};
  default:
    return {kind: "error", status, code: "internal", message};
  }
}

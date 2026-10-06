import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {ZodError} from "zod";
import {authenticateRequest, type SessionValidator, type VerifiedSession} from "../auth/session";
import {listOrdersQuerySchema, listOwnedOrders} from "../domain/orderHistory";
import {
  createOrder,
  createOrderBodySchema,
  getOwnedOrder,
  toOrderResponse,
} from "../domain/orders";
import {cancelOrder, cancelOrderBodySchema, toCancellationResponse} from "../domain/orderCancellation";
import {getPickupCredentialForCustomer} from "../domain/orderPickup";
import {
  ensureProviderOrder,
  preparePayment,
  toPaymentResponse,
  verifyCheckoutPayment,
  verifyCheckoutPaymentBodySchema,
} from "../domain/payments";
import {getPickupCredentialSecret} from "../domain/pickupCredential";
import type {
  ApiResult,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";
import {getRazorpayGateway, getRazorpayKeyId, type PaymentProviderGateway} from "../providers/razorpay";

export interface OrdersRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
  /** Injectable for tests; defaults to the shared real Razorpay gateway. */
  paymentProvider?: PaymentProviderGateway;
  /** Injectable for tests; defaults to the `PICKUP_CREDENTIAL_SECRET` param. */
  pickupSecret?: () => string;
}

/**
 * Builds the routes for `/orders` — the customer order-creation, order-history
 * and ownership-read API (see docs/architecture/http-api.md and this
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
    {method: "GET", path: "/orders", handler: (ctx) => handleListOrders(ctx, deps)},
    {method: "GET", path: "/orders/:orderId", handler: (ctx) => handleGetOrder(ctx, deps)},
    {
      method: "POST",
      path: "/orders/:orderId/payment",
      handler: (ctx) => handlePostOrderPayment(ctx, deps),
    },
    {
      method: "POST",
      path: "/orders/:orderId/payment/verify",
      handler: (ctx) => handlePostOrderPaymentVerify(ctx, deps),
    },
    {
      method: "GET",
      path: "/orders/:orderId/pickup-credential",
      handler: (ctx) => handleGetPickupCredential(ctx, deps),
    },
    {
      method: "POST",
      path: "/orders/:orderId/cancel",
      handler: (ctx) => handlePostOrderCancel(ctx, deps),
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
 * `GET /orders`: one page of the caller's own order history, newest first
 * (see `domain/orderHistory.ts`). Like every other authenticated route here,
 * it authenticates before reading anything from the request, and the caller's
 * identity comes ONLY from the verified session — `userId` is not a query
 * parameter this endpoint knows about, so one in the query string is ignored.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome: `200` with
 *   `{orders, nextCursor}` — an empty `orders` for a caller with no orders.
 */
async function handleListOrders(
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

  const parsedQuery = listOrdersQuerySchema.safeParse(ctx.request.query);
  if (!parsedQuery.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedQuery.error),
    };
  }

  try {
    const page = await listOwnedOrders(deps.db, session.userId, parsedQuery.data);
    return {kind: "success", status: 200, data: page, userId: session.userId};
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
 * `POST /orders/{orderId}/payment`: prepares a payment for the caller's own
 * `pending_payment` order, then ensures it has a Razorpay Test Mode order to
 * collect payment against (see `domain/payments.ts`'s `preparePayment`/
 * `ensureProviderOrder` and this checkpoint's "Server-side Razorpay order
 * creation" notes). Takes no request body — `amountInPaise`/`currency` (both
 * Zesto's and, in turn, Razorpay's) always come from the order, never from
 * the client, so there is nothing in the body to even read.
 *
 * This is the ONLY payment-related endpoint this checkpoint touches. There
 * is deliberately no endpoint that can mark a payment/order succeeded, and
 * creating a Razorpay order is NOT a payment — see root CLAUDE.md's core
 * payment rule and `ensureProviderOrder`'s doc comment: only a future
 * trusted provider webhook, calling `domain/payments.ts`'s
 * `markPaymentSucceeded` directly, may confirm an order.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome. `201` if this call
 *   created the internal payment or its provider order (or both); `200` if
 *   both already existed (a pure idempotent replay) — either way, the
 *   response body shape is identical, and never exposes provider secrets
 *   (see `toPaymentResponse`).
 */
async function handlePostOrderPayment(
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
    const providerKeyId = getRazorpayKeyId();
    const {payment, created: paymentCreated} =
      await preparePayment(deps.db, session.userId, ctx.params?.orderId);
    const {payment: updatedPayment, created: providerOrderCreated} = await ensureProviderOrder(
      deps.db, payment.orderId, payment.id, deps.paymentProvider ?? getRazorpayGateway(),
    );
    return {
      kind: "success",
      status: paymentCreated || providerOrderCreated ? 201 : 200,
      data: {payment: toPaymentResponse(updatedPayment, providerKeyId)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `POST /orders/{orderId}/payment/verify`: the trusted server-side
 * verification endpoint for a completed Razorpay Checkout payment (see
 * `domain/payments.ts`'s `verifyCheckoutPayment` for the full security
 * model — ownership, the stored `providerOrderId`, and the HMAC signature
 * are all independently verified there; nothing in the request body is
 * trusted at face value). The browser calls this once Razorpay Checkout
 * succeeds, handing back exactly the three identifiers Checkout gave it.
 *
 * Authenticates before ever parsing the request body, matching every other
 * route in this codebase. This is the ONLY endpoint in this checkpoint that
 * can move a payment/order from `pending`/`pending_payment` to
 * `succeeded`/`confirmed` — see root CLAUDE.md's core payment rule and
 * `verifyCheckoutPayment`'s doc comment: there is deliberately no endpoint
 * that lets a client assert payment success directly.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome: `200` with the
 *   confirmed order/payment on success (including a safe idempotent
 *   replay) — never exposes provider secrets (see `toPaymentResponse`).
 */
async function handlePostOrderPaymentVerify(
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

  const parsedBody = verifyCheckoutPaymentBodySchema.safeParse(ctx.request.body);
  if (!parsedBody.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedBody.error),
    };
  }

  try {
    const {payment, order} = await verifyCheckoutPayment(
      deps.db, session.userId, ctx.params?.orderId, parsedBody.data,
    );
    return {
      kind: "success",
      status: 200,
      data: {order: toOrderResponse(order), payment: toPaymentResponse(payment)},
      userId: session.userId,
    };
  } catch (error) {
    return mapKnownError(error);
  }
}

/**
 * `GET /orders/{orderId}/pickup-credential`: the QR payload and backup code the
 * CUSTOMER shows at the counter to collect their own ready order (see
 * `domain/pickupCredential.ts`).
 *
 * Authorization is the order's customer and nothing else. The caller is the
 * verified session's user; `getPickupCredentialForCustomer` reads the
 * authoritative order and compares its stored `userId` with that user. Knowing
 * an order ID is not enough — an unrelated customer, and equally the
 * organization's own owner/manager/staff (who are shown the credential by the
 * customer and never fetch it), get the same `404` as for an order that does
 * not exist.
 *
 * The response is exactly `{pickup: {qrPayload, code}}`: no customer identity,
 * Descope ID, payment-provider data, audit field or secret. It is only
 * available while the order is `ready` and paid (`409 conflict` otherwise),
 * rides `Cache-Control: private, no-store` like every response here, and is
 * derived on demand — nothing is stored server-side.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handleGetPickupCredential(
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
    const {qrPayload, code} = await getPickupCredentialForCustomer(
      deps.db, session.userId, ctx.params?.orderId, deps.pickupSecret ?? getPickupCredentialSecret,
    );
    return {
      kind: "success",
      status: 200,
      data: {pickup: {qrPayload, code}},
      userId: session.userId,
    };
  } catch (error) {
    const mapped = mapKnownError(error);
    // The order exists and is theirs, but cannot be collected right now: a
    // state conflict, not the "this identifier is taken" this file's 409 means.
    return mapped.kind === "error" && mapped.status === 409 ? {...mapped, code: "conflict"} : mapped;
  }
}

/**
 * `POST /orders/{orderId}/cancel`: the customer cancels their own order — body
 * `{reason?}`, where `reason` is one of the customer reasons and may be omitted.
 * Whether the order may be cancelled now (status, the menu's ordering
 * deadline, payment consistency) and what that costs (the refund of a paid
 * order) are decided server-side from Firestore inside one transaction (see
 * `domain/orderCancellation.ts`); the request carries no amount, deadline,
 * status, user or organization, and anything else in the body is ignored.
 *
 * Authenticates before the body is read, like every route here. The customer is
 * the verified session's user and must own the order: anyone else's order is
 * indistinguishable from a missing one (`404`), and that is decided before a
 * repeat of an already-cancelled order is answered. A refused state is `409
 * conflict` (an order already being prepared, the deadline passed, ...); an
 * invalid reason is `400`.
 *
 * @param {RouteContext} ctx The route context.
 * @param {OrdersRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome: `200` with `{order,
 *   cancellation, refund?}` — the order in the customer shape, the cancellation
 *   state, and (when money was captured) a safe refund summary — both for the
 *   cancellation and for a repeat that changed nothing. See
 *   `CancellationResponseSummary`: no provider, payment or audit identifier.
 */
async function handlePostOrderCancel(
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
      actor: {kind: "customer", userId: session.userId},
      orderId: ctx.params?.orderId,
      reason: parsedBody.data.reason,
    });
    return {
      kind: "success",
      status: 200,
      data: {order: toOrderResponse(result.order), ...toCancellationResponse(result)},
      userId: session.userId,
      logContext: {
        from: result.previousStatus,
        to: "cancelled",
        outcome: result.changed ? "cancelled" : "unchanged",
        refund: result.refund ? "reserved" : "none",
      },
    };
  } catch (error) {
    const mapped = mapKnownError(error);
    // The order is theirs but is not in a state that can be cancelled: a state
    // conflict, not the "this identifier is taken" this file's 409 means.
    return {
      ...(mapped.kind === "error" && mapped.status === 409 ? {...mapped, code: "conflict"} : mapped),
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

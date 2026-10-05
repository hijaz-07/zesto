import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {ZodError} from "zod";
import {requireOrganizationRole} from "../auth/membership";
import {authenticateRequest, type SessionValidator, type VerifiedSession} from "../auth/session";
import {NOTIFICATION_ORG_ROLES} from "../domain/notificationPolicy";
import {
  countUnreadNotifications,
  customerScope,
  listNotifications,
  listNotificationsQuerySchema,
  markAllNotificationsRead,
  markNotificationRead,
  organizationScope,
} from "../domain/notifications";
import type {ApiResult, NormalizedRequest, RouteContext, RouteDefinition} from "../http/types";

export interface NotificationsRouteDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the shared Descope client. */
  validator?: SessionValidator;
}

/** Who is asking and which of their inboxes the route is about. */
interface InboxCaller {
  session: VerifiedSession;
  /** `customerScope()`, or the organization scope of the caller's VERIFIED membership. */
  scope: string;
}

/** Authenticates (and, for the organization inbox, authorizes) the caller and names their inbox scope. */
type ResolveInbox = (ctx: RouteContext) => Promise<InboxCaller>;

/**
 * Builds the notification inbox routes — the HTTP side of `domain/notifications.ts`.
 * Backend only: nothing here creates a notification (that is
 * `domain/notificationProcessor.ts`, triggered by the outbox) and nothing here
 * accepts a recipient. Every route reads and writes only the verified
 * session's OWN inbox, in one scope:
 *
 * - `/notifications...` — the caller's customer notifications. Identity-scoped
 *   like `/orders`: no organization in the path.
 * - `/organizations/{organizationId}/notifications...` — the caller's
 *   notifications for that organization. Tenant-scoped like the order routes:
 *   an active `owner`/`manager`/`staff` membership is required, and the scope is
 *   the one of the membership as verified, never of the path as received. A
 *   member whose membership is revoked is refused at once, on every route,
 *   whatever is still sitting in their inbox.
 *
 * @param {NotificationsRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createNotificationRoutes(deps: NotificationsRouteDeps): RouteDefinition[] {
  const customerInbox: ResolveInbox = async (ctx) => ({
    session: await authenticate(ctx, deps),
    scope: customerScope(),
  });

  const organizationInbox: ResolveInbox = async (ctx) => {
    const session = await authenticate(ctx, deps);
    const membership = await requireOrganizationRole(
      deps.db, session, ctx.params?.organizationId, NOTIFICATION_ORG_ROLES,
    );
    return {session, scope: organizationScope(membership.organizationId)};
  };

  const inboxRoutes = (prefix: string, resolve: ResolveInbox): RouteDefinition[] => [
    {method: "GET", path: `${prefix}/notifications`, handler: (ctx) => handleList(ctx, deps, resolve)},
    {
      method: "GET",
      path: `${prefix}/notifications/unread-count`,
      handler: (ctx) => handleUnreadCount(ctx, deps, resolve),
    },
    {
      method: "POST",
      path: `${prefix}/notifications/read-all`,
      handler: (ctx) => handleReadAll(ctx, deps, resolve),
    },
    {
      method: "POST",
      path: `${prefix}/notifications/:notificationId/read`,
      handler: (ctx) => handleRead(ctx, deps, resolve),
    },
  ];

  return [
    ...inboxRoutes("", customerInbox),
    ...inboxRoutes("/organizations/:organizationId", organizationInbox),
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
 * @param {RouteContext} ctx The route context.
 * @param {NotificationsRouteDeps} deps The route's dependencies.
 * @return {Promise<VerifiedSession>} The verified session.
 */
function authenticate(ctx: RouteContext, deps: NotificationsRouteDeps): Promise<VerifiedSession> {
  return authenticateRequest({headers: {authorization: authorizationHeader(ctx.request)}}, deps.validator);
}

/**
 * `GET .../notifications?limit=&cursor=&unread=true`: one page of the caller's
 * notifications in this scope, newest first. Authentication and authorization
 * run before the query string is looked at.
 *
 * @param {RouteContext} ctx The route context.
 * @param {NotificationsRouteDeps} deps The route's dependencies.
 * @param {ResolveInbox} resolve Authenticates the caller and names the scope.
 * @return {Promise<ApiResult>} `200` with `{notifications, nextCursor}`.
 */
async function handleList(
  ctx: RouteContext,
  deps: NotificationsRouteDeps,
  resolve: ResolveInbox,
): Promise<ApiResult> {
  let caller: InboxCaller;
  try {
    caller = await resolve(ctx);
  } catch (error) {
    return mapKnownError(error);
  }

  const parsedQuery = listNotificationsQuerySchema.safeParse(ctx.request.query);
  if (!parsedQuery.success) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_argument",
      message: firstZodIssueMessage(parsedQuery.error),
      userId: caller.session.userId,
    };
  }

  try {
    const page = await listNotifications(deps.db, caller.session.userId, caller.scope, parsedQuery.data);
    return {kind: "success", status: 200, data: page, userId: caller.session.userId};
  } catch (error) {
    return {...mapKnownError(error), userId: caller.session.userId};
  }
}

/**
 * `GET .../notifications/unread-count`: how many of the caller's notifications
 * in this scope are unread (counting no further than the cap).
 *
 * @param {RouteContext} ctx The route context.
 * @param {NotificationsRouteDeps} deps The route's dependencies.
 * @param {ResolveInbox} resolve Authenticates the caller and names the scope.
 * @return {Promise<ApiResult>} `200` with `{unreadCount}`.
 */
async function handleUnreadCount(
  ctx: RouteContext,
  deps: NotificationsRouteDeps,
  resolve: ResolveInbox,
): Promise<ApiResult> {
  let caller: InboxCaller;
  try {
    caller = await resolve(ctx);
  } catch (error) {
    return mapKnownError(error);
  }

  const unreadCount = await countUnreadNotifications(deps.db, caller.session.userId, caller.scope);
  return {kind: "success", status: 200, data: {unreadCount}, userId: caller.session.userId};
}

/**
 * `POST .../notifications/{notificationId}/read`: marks one of the caller's own
 * notifications read. Takes no body. Idempotent: reading an already-read
 * notification is a `200` that changes nothing. Anyone else's notification, one
 * from another scope, and a missing one are the same `404`.
 *
 * @param {RouteContext} ctx The route context.
 * @param {NotificationsRouteDeps} deps The route's dependencies.
 * @param {ResolveInbox} resolve Authenticates the caller and names the scope.
 * @return {Promise<ApiResult>} `200` with `{notification}`.
 */
async function handleRead(
  ctx: RouteContext,
  deps: NotificationsRouteDeps,
  resolve: ResolveInbox,
): Promise<ApiResult> {
  let caller: InboxCaller;
  try {
    caller = await resolve(ctx);
  } catch (error) {
    return mapKnownError(error);
  }

  try {
    const notification = await markNotificationRead(
      deps.db, caller.session.userId, caller.scope, ctx.params?.notificationId,
    );
    return {kind: "success", status: 200, data: {notification}, userId: caller.session.userId};
  } catch (error) {
    return {...mapKnownError(error), userId: caller.session.userId};
  }
}

/**
 * `POST .../notifications/read-all`: marks the caller's unread notifications in
 * this scope read, in bounded batches. Takes no body.
 *
 * @param {RouteContext} ctx The route context.
 * @param {NotificationsRouteDeps} deps The route's dependencies.
 * @param {ResolveInbox} resolve Authenticates the caller and names the scope.
 * @return {Promise<ApiResult>} `200` with `{updated, hasMore}`.
 */
async function handleReadAll(
  ctx: RouteContext,
  deps: NotificationsRouteDeps,
  resolve: ResolveInbox,
): Promise<ApiResult> {
  let caller: InboxCaller;
  try {
    caller = await resolve(ctx);
  } catch (error) {
    return mapKnownError(error);
  }

  const result = await markAllNotificationsRead(deps.db, caller.session.userId, caller.scope);
  return {kind: "success", status: 200, data: result, userId: caller.session.userId};
}

/**
 * @param {ZodError} error A failed `safeParse` result's error.
 * @return {string} The first validation issue's message, or a generic fallback.
 */
function firstZodIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? "Invalid request.";
}

/**
 * Maps an `HttpsError` thrown by the auth boundary, the tenant-authorization
 * boundary, or the domain layer to its response. Anything else is not a known
 * failure and is rethrown for the generic 500 handling. Duplicated per route
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
    return {kind: "error", status, code: "conflict", message};
  case 503:
    return {kind: "error", status, code: "unavailable", message};
  default:
    return {kind: "error", status, code: "internal", message};
  }
}

import {randomUUID} from "node:crypto";
import {setGlobalOptions} from "firebase-functions";
import * as logger from "firebase-functions/logger";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import type {Response} from "express";
import {getAdminFirestore} from "./firebaseAdmin";
import {authenticateRequest} from "./auth/session";
import {toResponseBody} from "./http/envelope";
import {handleRequest} from "./http/handleRequest";
import {logRequest, logUnhandledError} from "./http/logger";
import {withRateLimits} from "./http/rateLimit";
import {toNormalizedRequest} from "./http/request";
import type {ApiResult} from "./http/types";
import {createExploreRoutes} from "./routes/explore";
import {createMeRoutes} from "./routes/me";
import {createMenuItemRoutes} from "./routes/menuItems";
import {createMenuRoutes} from "./routes/menus";
import {createNotificationRoutes} from "./routes/notifications";
import {createOrderRoutes} from "./routes/orders";
import {createOrganizationOrderRoutes} from "./routes/organizationOrders";
import {createOrganizationRoutes} from "./routes/organizations";
import {createOutletRoutes} from "./routes/outlets";
import {createWebhookRoutes} from "./routes/webhooks";
import {handleNotificationEventCreated} from "./domain/notificationEventTrigger";
import {pickupCredentialSecret} from "./domain/pickupCredential";
import {handleRefundCreated, reconcileDueRefunds} from "./domain/refundReconciliation";
import {razorpayKeySecret, razorpayWebhookSecret} from "./providers/razorpay";
import {getRazorpayRefundGateway} from "./providers/razorpayRefunds";

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. See functions/README or Firebase docs for details.
setGlobalOptions({maxInstances: 10});

const ROUTES = [
  ...createMeRoutes({db: getAdminFirestore()}),
  ...createOrganizationRoutes({db: getAdminFirestore()}),
  ...createOutletRoutes({db: getAdminFirestore()}),
  ...createMenuRoutes({db: getAdminFirestore()}),
  ...createMenuItemRoutes({db: getAdminFirestore()}),
  ...createOrderRoutes({db: getAdminFirestore()}),
  ...createOrganizationOrderRoutes({db: getAdminFirestore()}),
  ...createExploreRoutes({db: getAdminFirestore()}),
  ...createNotificationRoutes({db: getAdminFirestore()}),
  ...createWebhookRoutes({db: getAdminFirestore()}),
];

// Per-user, per-instance abuse limits on the highest-risk routes (see `http/rateLimit.ts`).
// The caller is verified here only to pick a bucket; a request that fails verification is
// passed straight on, and the route's own handler answers it (401/503) as it always did.
const LIMITED_ROUTES = withRateLimits(ROUTES, {
  resolveUserId: async (ctx) => {
    const authorization = ctx.request.headers.authorization;
    const session = await authenticateRequest({
      headers: {authorization: Array.isArray(authorization) ? authorization[0] : authorization},
    });
    return session.userId;
  },
});

/**
 * Applies the headers common to every response (always `X-Request-Id` and
 * `Cache-Control`; anything the result itself specifies, e.g. `Allow` on a
 * 405 or `WWW-Authenticate` on a 401) and writes the enveloped JSON body.
 *
 * @param {Response} response The Express response to write to.
 * @param {ApiResult} result The route's outcome.
 * @param {string} requestId This request's ID.
 */
function sendResult(
  response: Response,
  result: ApiResult,
  requestId: string,
): void {
  response.set("X-Request-Id", requestId);
  response.set("Cache-Control", "private, no-store");
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    response.set(name, value);
  }
  response.status(result.status).json(toResponseBody(result, requestId));
}

/**
 * Zesto's HTTP API. A single Cloud Function fronting a small internal
 * router (see `functions/src/http/router.ts`) — see
 * docs/architecture/http-api.md for the full request/response contract.
 */
export const api = onRequest(
  // `secrets` makes RAZORPAY_KEY_SECRET (API key secret: creating orders,
  // Checkout verification) and RAZORPAY_WEBHOOK_SECRET (the SEPARATE secret
  // Razorpay signs webhook deliveries with) available via `process.env` when
  // deployed (backed by Cloud Secret Manager). RAZORPAY_KEY_ID is a plain
  // `defineString` param (like DESCOPE_PROJECT_ID) and needs no such
  // declaration. The webhook route lives on this same function — there is
  // deliberately no second Cloud Function. PICKUP_CREDENTIAL_SECRET is the
  // HMAC key pickup credentials (QR payload / backup code) are derived from
  // (see `domain/pickupCredential.ts`); a third, unrelated secret.
  {
    region: "asia-south1",
    secrets: [razorpayKeySecret, razorpayWebhookSecret, pickupCredentialSecret],
  },
  async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    // `request.rawBody` is the original, unparsed body bytes (see
    // `http/request.ts`) — carried alongside the parsed `body` for the
    // webhook route's signature check.
    const normalized = toNormalizedRequest(request);

    const result: ApiResult = await handleRequest(
      LIMITED_ROUTES,
      normalized,
      (error) => logUnhandledError(requestId, normalized.path, error),
    );

    sendResult(response, result, requestId);

    logRequest({
      requestId,
      route: normalized.path,
      method: normalized.method,
      status: result.status,
      duration: Date.now() - startedAt,
      userId: result.userId,
      context: result.logContext,
    });
  },
);

/**
 * Turns each notification outbox event into visible notifications. Fires once
 * per document created in `notificationEvents` — written inside the same
 * transaction as the order transition it reports (see
 * `domain/notificationEvents.ts`) — and processes exactly that event, never
 * any other document. Same region as the Firestore database (asia-south1),
 * which a Firestore trigger requires.
 *
 * `retry: true` redelivers an invocation that throws, with backoff; the
 * processor throws only for a transient failure with attempts left, and marks
 * the event `failed` and returns normally otherwise, so this never retries
 * forever (see `domain/notificationProcessor.ts`). It holds no secrets and
 * needs no `secrets` declaration.
 */
export const onNotificationEventCreated = onDocumentCreated(
  {document: "notificationEvents/{eventId}", region: "asia-south1", retry: true},
  async (event) => {
    await handleNotificationEventCreated(getAdminFirestore(), event.params.eventId);
  },
);

/**
 * Submits a refund to the provider as soon as it is created (by a cancellation, or
 * by a payment captured after one). Fires once per document created under any
 * payment's `refunds`, and runs `submitRefund` — the one submission driver — for
 * exactly that document (see `domain/refundSubmission.ts`). Provider failures are
 * recorded on the refund, never thrown, so `retry: true` only redelivers an
 * unexpected local failure; the scheduled sweep below recovers anything else.
 * Needs the Razorpay API secret, so it declares it.
 */
export const onRefundCreated = onDocumentCreated(
  {
    document: "organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/orders/{orderId}/payments/{paymentId}/refunds/{refundId}",
    region: "asia-south1",
    retry: true,
    secrets: [razorpayKeySecret],
  },
  async (event) => {
    if (!event.data) {
      return;
    }
    await handleRefundCreated(getAdminFirestore(), getRazorpayRefundGateway(), event.data.ref.path);
  },
);

/**
 * The refund safety net: every 15 minutes, advances a bounded batch of refunds
 * that are due (lost responses, dead workers, pending refunds with no webhook, retries
 * now due) through the same `submitRefund` driver (see
 * `domain/refundReconciliation.ts`). Safe if two runs overlap. Deploying it needs the
 * Cloud Scheduler API enabled on the project.
 */
export const reconcileRefunds = onSchedule(
  {
    schedule: "every 15 minutes",
    region: "asia-south1",
    timeoutSeconds: 540,
    maxInstances: 1,
    secrets: [razorpayKeySecret],
  },
  async () => {
    const summary = await reconcileDueRefunds(getAdminFirestore(), getRazorpayRefundGateway());
    logger.info("Refund reconciliation finished.", summary);
  },
);

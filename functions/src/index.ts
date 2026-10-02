import {randomUUID} from "node:crypto";
import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/v2/https";
import type {Response} from "express";
import {getAdminFirestore} from "./firebaseAdmin";
import {toResponseBody} from "./http/envelope";
import {handleRequest} from "./http/handleRequest";
import {logRequest, logUnhandledError} from "./http/logger";
import {toNormalizedRequest} from "./http/request";
import type {ApiResult} from "./http/types";
import {createExploreRoutes} from "./routes/explore";
import {createMeRoutes} from "./routes/me";
import {createMenuItemRoutes} from "./routes/menuItems";
import {createMenuRoutes} from "./routes/menus";
import {createOrderRoutes} from "./routes/orders";
import {createOrganizationOrderRoutes} from "./routes/organizationOrders";
import {createOrganizationRoutes} from "./routes/organizations";
import {createOutletRoutes} from "./routes/outlets";
import {createWebhookRoutes} from "./routes/webhooks";
import {razorpayKeySecret, razorpayWebhookSecret} from "./providers/razorpay";

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
  ...createWebhookRoutes({db: getAdminFirestore()}),
];

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
  // deliberately no second Cloud Function.
  {region: "asia-south1", secrets: [razorpayKeySecret, razorpayWebhookSecret]},
  async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    // `request.rawBody` is the original, unparsed body bytes (see
    // `http/request.ts`) — carried alongside the parsed `body` for the
    // webhook route's signature check.
    const normalized = toNormalizedRequest(request);

    const result: ApiResult = await handleRequest(
      ROUTES,
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

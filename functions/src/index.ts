import {randomUUID} from "node:crypto";
import {setGlobalOptions} from "firebase-functions";
import {onRequest, type Request} from "firebase-functions/v2/https";
import type {Response} from "express";
import {getAdminFirestore} from "./firebaseAdmin";
import {toResponseBody} from "./http/envelope";
import {handleRequest} from "./http/handleRequest";
import {logRequest, logUnhandledError} from "./http/logger";
import {normalizePath} from "./http/router";
import type {ApiResult, NormalizedRequest} from "./http/types";
import {createExploreRoutes} from "./routes/explore";
import {createMeRoutes} from "./routes/me";
import {createMenuItemRoutes} from "./routes/menuItems";
import {createMenuRoutes} from "./routes/menus";
import {createOrderRoutes} from "./routes/orders";
import {createOrganizationRoutes} from "./routes/organizations";
import {createOutletRoutes} from "./routes/outlets";

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
  ...createExploreRoutes({db: getAdminFirestore()}),
];

/**
 * @param {Request} request The incoming Express-compatible request.
 * @return {NormalizedRequest} The request reduced to the router's contract.
 */
function toNormalizedRequest(request: Request): NormalizedRequest {
  return {
    method: request.method,
    path: normalizePath(request.path),
    headers: request.headers,
    query: request.query,
    body: request.body,
  };
}

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
  {region: "asia-south1"},
  async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
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
    });
  },
);

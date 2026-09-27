import {dispatch} from "./router";
import type {ApiResult, NormalizedRequest, RouteDefinition} from "./types";

/**
 * Runs the router and converts any exception a handler didn't turn into an
 * `ApiResult` itself (e.g. a malformed stored Firestore document, or an
 * unexpected Firestore error) into a generic `500 internal` result. This is
 * the only path that can produce a 500: handlers are expected to map their
 * own known failures (401, 503, ...) to an `ApiResult` and let anything
 * truly unexpected propagate here instead of guessing at a status code.
 *
 * @param {readonly RouteDefinition[]} routes The registered routes.
 * @param {NormalizedRequest} request The incoming request.
 * @param {(error: unknown) => void} onUnhandledError Called with the raw
 *   error before it is replaced by the generic 500 result, so the caller can
 *   log it (with whatever context, e.g. requestId) without the error's
 *   detail ever reaching the response body.
 * @return {Promise<ApiResult>} The route's outcome, or a generic 500.
 */
export async function handleRequest(
  routes: readonly RouteDefinition[],
  request: NormalizedRequest,
  onUnhandledError: (error: unknown) => void,
): Promise<ApiResult> {
  try {
    return await dispatch(routes, request);
  } catch (error) {
    onUnhandledError(error);
    return {
      kind: "error",
      status: 500,
      code: "internal",
      message: "An unexpected error occurred.",
    };
  }
}

import type {ApiResult} from "./types";

/** The `api` function's success response body: `{"data": ...}`. */
export interface SuccessBody {
  data: unknown;
}

/** The `api` function's error response body: `{"error": {...}}`. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/**
 * Builds the JSON response body for a route result, per the API's response
 * envelope: `{"data": ...}` on success, `{"error": {code, message,
 * requestId}} ` on failure. `requestId` is injected here rather than carried
 * on `ApiResult` so every response gets exactly one, assigned by the caller.
 *
 * @param {ApiResult} result The route's outcome.
 * @param {string} requestId This request's ID.
 * @return {SuccessBody | ErrorBody} The response body to send.
 */
export function toResponseBody(
  result: ApiResult,
  requestId: string,
): SuccessBody | ErrorBody {
  if (result.kind === "success") {
    return {data: result.data};
  }
  return {
    error: {
      code: result.code,
      message: result.message,
      requestId,
    },
  };
}

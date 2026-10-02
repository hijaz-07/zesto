import {normalizePath} from "./router";
import type {NormalizedRequest} from "./types";

/**
 * The slice of an incoming Functions/Express request `toNormalizedRequest`
 * reads. A structural type (rather than Express's own `Request`) so it can
 * be satisfied by a plain object in tests — and by the real
 * `firebase-functions` `Request`, which has exactly these members.
 */
export interface IncomingRequest {
  method: string;
  path: string;
  headers: NormalizedRequest["headers"];
  query: Record<string, unknown>;
  /** The runtime's already-parsed body (JSON object, text, ...). */
  body: unknown;
  /**
   * The original, unparsed request body bytes. The Firebase Functions
   * runtime (both the deployed Functions Framework and the local emulator)
   * captures these through body-parser's `verify` hook BEFORE parsing, and
   * exposes them as `request.rawBody`.
   */
  rawBody?: Buffer;
}

/**
 * Reduces an incoming request to the router's contract.
 *
 * `rawBody` is passed through untouched — the same `Buffer` the runtime
 * captured, not a copy re-encoded from `body` — so a route that needs the
 * exact bytes Razorpay signed (the webhook route) gets them. Nothing in the
 * `api` function re-parses or re-serializes the body before a handler runs:
 * `body` is simply the runtime's own parse, and `rawBody` sits beside it.
 *
 * @param {IncomingRequest} request The incoming request.
 * @return {NormalizedRequest} The request reduced to the router's contract.
 */
export function toNormalizedRequest(request: IncomingRequest): NormalizedRequest {
  return {
    method: request.method,
    path: normalizePath(request.path),
    headers: request.headers,
    query: request.query,
    body: request.body,
    rawBody: request.rawBody,
  };
}

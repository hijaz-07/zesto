import type {Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  receiveRazorpayWebhook,
  WEBHOOK_EVENT_ID_HEADER,
  type ReceiveWebhookResult,
} from "../domain/razorpayWebhooks";
import type {
  ApiResult,
  LogContext,
  NormalizedRequest,
  RouteContext,
  RouteDefinition,
} from "../http/types";
import {verifyWebhookSignature} from "../providers/razorpay";

export interface WebhookRouteDeps {
  db: Firestore;
}

/** Razorpay's documented signature header (lower-cased, as Express exposes it). */
const SIGNATURE_HEADER = "x-razorpay-signature";

/**
 * Builds the provider-webhook routes (see docs/architecture/http-api.md's
 * "Razorpay webhook" section).
 *
 * These are the ONLY routes in the `api` function that do not authenticate a
 * Descope session — Razorpay has no Zesto user. They are authenticated by
 * Razorpay's own HMAC signature instead (`providers/razorpay.ts`'s
 * `verifyWebhookSignature`), checked against the raw request bytes BEFORE
 * anything in the body is parsed or trusted. They live on the existing `api`
 * function and router; there is no second function.
 *
 * @param {WebhookRouteDeps} deps The routes' dependencies.
 * @return {RouteDefinition[]} The routes to register with the router.
 */
export function createWebhookRoutes(deps: WebhookRouteDeps): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/webhooks/razorpay",
      handler: (ctx) => handlePostRazorpayWebhook(ctx, deps),
    },
  ];
}

/**
 * @param {NormalizedRequest} request The incoming request.
 * @param {string} name A lower-cased header name.
 * @return {string | undefined} The header's first value, if present.
 */
function headerValue(request: NormalizedRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @param {number} status The HTTP status.
 * @param {string} code A stable machine-readable code.
 * @param {string} message A short, fixed, non-sensitive message.
 * @param {LogContext} logContext Safe fields for the request log line.
 * @return {ApiResult} The error result.
 */
function failure(status: number, code: string, message: string, logContext: LogContext): ApiResult {
  return {kind: "error", status, code, message, logContext};
}

/** Outcomes that mean Zesto's and Razorpay's records disagree in a way that
 * needs a human. Still acknowledged (retrying can't change the answer), but
 * logged at error severity so they're alertable. */
const ANOMALOUS_OUTCOMES: ReadonlySet<string> = new Set([
  "rejected_ambiguous_payment",
  "rejected_currency_mismatch",
  "rejected_amount_mismatch",
  "rejected_missing_order",
  "rejected_order_not_payable",
  "success_conflicting_payment_id",
]);

/**
 * `POST /webhooks/razorpay`: receives a Razorpay webhook delivery.
 *
 * 1. Needs the raw body (`request.rawBody`) and an `X-Razorpay-Signature`
 *    header; otherwise 400/401.
 * 2. Verifies the HMAC over the RAW bytes — never over a re-serialized
 *    parse. Invalid → 401, with no Firestore access and nothing recorded.
 *    A missing webhook secret is a server misconfiguration and surfaces as
 *    the generic 500 (never as "invalid signature").
 * 3. Only then parses and reconciles (`domain/razorpayWebhooks.ts`).
 *
 * Responses:
 * - `200` — processed, a safe duplicate, or a valid event Zesto
 *   intentionally ignores (unknown type / not one of its payments).
 *   Acknowledging these stops Razorpay retrying something no retry can fix.
 * - `400` — signed but malformed payload.
 * - `401` — missing/invalid signature.
 * - `409` — the same event is being processed right now, or its ID was
 *   re-used with a different body: retryable, never silently dropped.
 * - `500` — transient/unexpected failure (e.g. Firestore): Razorpay retries,
 *   and reconciliation is idempotent.
 *
 * The response never contains anything from the request or any secret.
 *
 * @param {RouteContext} ctx The route context.
 * @param {WebhookRouteDeps} deps The route's dependencies.
 * @return {Promise<ApiResult>} The route's outcome.
 */
async function handlePostRazorpayWebhook(
  ctx: RouteContext,
  deps: WebhookRouteDeps,
): Promise<ApiResult> {
  const {rawBody} = ctx.request;
  if (!rawBody || rawBody.length === 0) {
    return failure(400, "invalid_argument", "The request body is missing.", {outcome: "missing_body"});
  }

  const signature = headerValue(ctx.request, SIGNATURE_HEADER);
  if (!signature || !verifyWebhookSignature({rawBody, signature})) {
    return failure(401, "invalid_signature", "The webhook signature is missing or invalid.", {
      outcome: "invalid_signature",
    });
  }

  const result = await receiveRazorpayWebhook(deps.db, {
    rawBody,
    eventIdHeader: ctx.request.headers[WEBHOOK_EVENT_ID_HEADER],
  });
  return toApiResult(result);
}

/**
 * @param {ReceiveWebhookResult} result The domain outcome for a verified delivery.
 * @return {ApiResult} The HTTP result, with safe log context.
 */
function toApiResult(result: ReceiveWebhookResult): ApiResult {
  switch (result.kind) {
  case "malformed":
    return failure(400, "invalid_argument", "The webhook payload is malformed.", {outcome: "malformed"});

  case "ignored":
    return {
      kind: "success",
      status: 200,
      data: {received: true, outcome: "ignored_unknown_event"},
      logContext: {eventType: result.eventType, outcome: "ignored_unknown_event"},
    };

  case "duplicate":
    return {
      kind: "success",
      status: 200,
      data: {received: true, outcome: "duplicate"},
      logContext: {
        eventKey: result.eventKey,
        outcome: "duplicate",
        originalOutcome: result.originalOutcome,
      },
    };

  case "in_progress":
    return failure(409, "event_in_progress", "This event is currently being processed. Retry later.", {
      eventKey: result.eventKey,
      outcome: "in_progress",
    });

  case "event_id_conflict":
    logger.error("razorpay webhook event id reused with a different body", {eventKey: result.eventKey});
    return failure(409, "event_id_conflict", "This event ID was already used for a different payload.", {
      eventKey: result.eventKey,
      outcome: "event_id_conflict",
    });

  case "processed": {
    const context: Record<string, string | number | boolean> = {
      eventKey: result.eventKey,
      eventType: result.eventType,
      outcome: result.outcome,
      providerPaymentId: result.providerPaymentId,
    };
    if (result.providerOrderId) {
      context.providerOrderId = result.providerOrderId;
    }
    if (ANOMALOUS_OUTCOMES.has(result.outcome)) {
      logger.error("razorpay webhook reconciliation anomaly", context);
    }
    return {kind: "success", status: 200, data: {received: true, outcome: result.outcome}, logContext: context};
  }
  }
}

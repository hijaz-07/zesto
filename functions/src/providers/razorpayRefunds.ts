import * as logger from "firebase-functions/logger";
import {z} from "zod";
import {getRazorpayKeyId, getRazorpayKeySecret} from "./razorpay";
import {
  ProviderConfigurationError,
  ProviderOutcomeUnknownError,
  ProviderRefundRejectedError,
  ProviderRetryableError,
  type CreateProviderRefundInput,
  type ProviderPayment,
  type ProviderRefund,
  type RefundProviderError,
  type RefundProviderGateway,
} from "./refundGateway";

/**
 * The Razorpay implementation of `RefundProviderGateway`.
 *
 * It talks to Razorpay over plain HTTPS rather than through the `razorpay` SDK,
 * because the SDK (2.9.8) cannot do what refunds need:
 * - it sets NO request timeout (a hung connection would hang the caller);
 * - it drops every request header except `X-Razorpay-Account`/`Content-Type`, so
 *   `X-Refund-Idempotency` can never be sent;
 * - on a network failure it throws a bare `TypeError` (it reads `err.response.status`
 *   on an error that has no response), losing the very fact the caller must know:
 *   that the outcome is UNKNOWN.
 * Order creation and signature checks stay on the SDK in `razorpay.ts`; this file
 * only adds the refund/payment-lookup calls, behind the provider-neutral interface.
 *
 * Verified provider facts this relies on (Razorpay API docs, retrieved while building
 * checkpoint 7.4 — see the checkpoint report for the unverified remainder):
 * - `POST /v1/payments/{id}/refund` `{amount, speed, receipt, notes}`; `speed: "normal"` is the default;
 * - `GET /v1/refunds/{id}`, `GET /v1/payments/{id}/refunds?count&skip&from&to`
 *   (`count` 1–100, default 10), `GET /v1/payments/{id}`;
 * - a refund's `status` is `pending` | `processed` | `failed`; `amount` is in the
 *   smallest currency unit;
 * - Basic auth with `key_id:key_secret`;
 * - `X-Refund-Idempotency`: 10+ characters of `A-Za-z0-9_-`; a retry must carry the
 *   SAME key and the SAME body; the same key with a different body is a 409, and so is
 *   a request that arrives while the first is still in progress;
 * - `receipt` is documented as unique per payment: a repeat is a 400 "Duplicate receipt".
 *
 * Every call has an explicit timeout. The gateway NEVER retries by itself and NEVER
 * turns a timeout or an unreadable answer into a definitive failure — see
 * `classifyHttpFailure` and `transportFailure`.
 */

export const RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1";
/** The default per-request timeout. */
export const DEFAULT_REFUND_REQUEST_TIMEOUT_MS = 10_000;
/** The longest timeout a caller may configure. */
export const MAX_REFUND_REQUEST_TIMEOUT_MS = 30_000;

const LIST_PAGE_SIZE = 100;
/** A payment cannot plausibly have this many refunds; hitting it means something is wrong. */
const MAX_LIST_PAGES = 20;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_CONTEXT_CHARS = 60;

/** The provider's idempotency-key alphabet and minimum length (see the file header). */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{10,255}$/;
/** What a provider ID looks like — and the only thing ever placed in a URL path. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_]{1,100}$/;

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

/** The part of a `fetch` response this module reads. */
export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}

/** The part of `fetch` this module uses — satisfied by the global `fetch`, and by a test double. */
export type FetchLike = (url: string, init: {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  redirect: "manual";
  signal: AbortSignal;
}) => Promise<FetchResponseLike>;

export interface RazorpayRefundGatewayOptions {
  /** Read lazily on every request, so a missing credential surfaces as a typed error, never at import. */
  getCredentials: () => RazorpayCredentials;
  /** Defaults to the global `fetch`. */
  fetchFn?: FetchLike;
  /** Defaults to `RAZORPAY_API_BASE_URL`. */
  baseUrl?: string;
  /** Per-request timeout, 1 – `MAX_REFUND_REQUEST_TIMEOUT_MS`; defaults to `DEFAULT_REFUND_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface RequestSpec<T> {
  operation: "createRefund" | "fetchRefund" | "listPaymentRefunds" | "fetchPayment" | "listOrderPayments";
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
  /** A write may have been applied even when it fails ambiguously; a read changes nothing. */
  isWrite: boolean;
  parse: (json: unknown) => T;
}

const refundStatusSchema = z.enum(["pending", "processed", "failed"]);

const refundSchema = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().min(1),
  status: refundStatusSchema,
  receipt: z.string().nullish(),
  notes: z.unknown().optional(),
  created_at: z.number().int().nullish(),
  speed_requested: z.string().nullish(),
  speed_processed: z.string().nullish(),
});

const paymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().nullish(),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  captured: z.boolean(),
  amount_refunded: z.number().int().nonnegative(),
});

const collectionSchema = z.object({items: z.array(z.unknown())});

/**
 * Razorpay returns an EMPTY ARRAY for notes that were never set, an object otherwise.
 *
 * @param {unknown} value The `notes` field.
 * @return {Record<string, string>} Only the string/number entries, as strings.
 */
function normalizeNotes(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const notes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      notes[key] = entry;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      notes[key] = String(entry);
    }
  }
  return notes;
}

/**
 * @param {unknown} json One refund object from the provider.
 * @return {ProviderRefund} The normalized refund — never the raw provider object.
 * @throws {z.ZodError} If the object is not a well-formed refund.
 */
function toProviderRefund(json: unknown): ProviderRefund {
  const raw = refundSchema.parse(json);
  const refund: ProviderRefund = {
    id: raw.id,
    providerPaymentId: raw.payment_id,
    amountInPaise: raw.amount,
    currency: raw.currency,
    status: raw.status,
    notes: normalizeNotes(raw.notes),
  };
  if (typeof raw.receipt === "string") {
    refund.receipt = raw.receipt;
  }
  if (raw.speed_requested === "normal" || raw.speed_requested === "optimum") {
    refund.speedRequested = raw.speed_requested;
  }
  if (raw.speed_processed === "normal" || raw.speed_processed === "instant") {
    refund.speedProcessed = raw.speed_processed;
  }
  if (typeof raw.created_at === "number") {
    refund.createdAtEpochSeconds = raw.created_at;
  }
  return refund;
}

/**
 * @param {unknown} json A payment object from the provider.
 * @return {ProviderPayment} The normalized payment.
 * @throws {z.ZodError} If the object is not a well-formed payment.
 */
function toProviderPayment(json: unknown): ProviderPayment {
  const raw = paymentSchema.parse(json);
  return {
    id: raw.id,
    providerOrderId: raw.order_id ?? null,
    amountInPaise: raw.amount,
    currency: raw.currency,
    status: raw.status,
    captured: raw.captured,
    amountRefundedInPaise: raw.amount_refunded,
  };
}

/**
 * @param {unknown} text A provider-supplied string.
 * @param {RazorpayCredentials | undefined} credentials Redacted from the result if echoed.
 * @return {string} A short, single-line, credential-free version, safe in an error message.
 */
function safeText(text: unknown, credentials?: RazorpayCredentials): string {
  if (typeof text !== "string") {
    return "";
  }
  let result = text;
  for (const secret of [credentials?.keySecret, credentials?.keyId]) {
    if (secret) {
      result = result.split(secret).join("[redacted]");
    }
  }
  result = Array.from(result, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("").replace(/ {2,}/g, " ").trim();
  return result.length > MAX_DESCRIPTION_CHARS ? `${result.slice(0, MAX_DESCRIPTION_CHARS)}…` : result;
}

/**
 * @param {unknown} code A provider error code.
 * @return {string} The code if it is a short identifier, else a generic one.
 */
function safeCode(code: unknown): string {
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "provider_error";
}

/**
 * Classifies a non-2xx answer. Nothing here ever returns a DEFINITIVE failure for
 * anything but a response that clearly refuses the request.
 *
 * @param {RequestSpec<unknown>} spec The request that was made.
 * @param {number} status The HTTP status received.
 * @param {string} bodyText The response body (may not be JSON).
 * @param {RazorpayCredentials} credentials To redact from any echoed text.
 * @return {RefundProviderError} The typed failure to throw.
 */
function classifyHttpFailure(
  spec: RequestSpec<unknown>, status: number, bodyText: string, credentials: RazorpayCredentials,
): RefundProviderError {
  let providerCode: unknown;
  let description: unknown;
  let context: Array<[string, unknown]> = [];
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const error = (parsed as {error?: {code?: unknown; description?: unknown; field?: unknown; reason?: unknown; step?: unknown}} | null)?.error;
    providerCode = error?.code;
    description = error?.description;
    context = [["field", error?.field], ["reason", error?.reason], ["step", error?.step]];
  } catch {
    // A non-JSON error body is fine: the status alone classifies it.
  }
  const code = safeCode(providerCode);
  const detail = safeText(description, credentials);
  // Razorpay names the offending field / reason / step on a 400; "NA" means "not applicable".
  const extra = context
    .map(([name, value]) => [name, safeText(value, credentials).slice(0, MAX_CONTEXT_CHARS)])
    .filter(([, value]) => value && value !== "NA")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const message = `Razorpay ${spec.operation} failed (HTTP ${status}${detail ? `: ${detail}` : ""}${extra ? `; ${extra}` : ""}).`;

  if (status === 401 || status === 403) {
    return new ProviderConfigurationError("provider_auth_rejected", `Razorpay rejected the credentials (HTTP ${status}).`, status);
  }
  if (status === 429) {
    return new ProviderRetryableError("rate_limited", message, {httpStatus: status, mayHaveBeenApplied: false});
  }
  if (status >= 500 && status <= 599) {
    return new ProviderRetryableError("provider_server_error", message, {httpStatus: status, mayHaveBeenApplied: spec.isWrite});
  }
  if (status === 408) {
    return spec.isWrite ?
      new ProviderOutcomeUnknownError(message, "request_timeout", status) :
      new ProviderRetryableError("request_timeout", message, {httpStatus: status, mayHaveBeenApplied: false});
  }
  if (status === 409) {
    if (!spec.isWrite) {
      return new ProviderRetryableError("conflict", message, {httpStatus: status, mayHaveBeenApplied: false});
    }
    // Documented: a different body under the same key, or the first request still running.
    return /different/i.test(detail) ?
      new ProviderRefundRejectedError("idempotency_key_conflict", message, status) :
      new ProviderOutcomeUnknownError(message, "request_in_progress", status);
  }
  if (spec.isWrite && status === 400) {
    // The refund may ALREADY EXIST: Zesto's receipt is its own refund ID, so a "duplicate
    // receipt" is the provider telling us an earlier attempt landed. Never a failure.
    if (/duplicate receipt/i.test(detail)) {
      return new ProviderOutcomeUnknownError(message, "duplicate_receipt", status);
    }
    if (/concurrent/i.test(detail)) {
      return new ProviderRetryableError("concurrent_operation", message, {httpStatus: status, mayHaveBeenApplied: true});
    }
  }
  if (status >= 400 && status <= 499) {
    return new ProviderRefundRejectedError(code, message, status);
  }
  // 1xx / 3xx: not an answer we understand.
  return spec.isWrite ?
    new ProviderOutcomeUnknownError(message, "unexpected_status", status) :
    new ProviderRetryableError("unexpected_status", message, {httpStatus: status, mayHaveBeenApplied: false});
}

/**
 * @param {RequestSpec<unknown>} spec The request that failed in transit.
 * @param {boolean} timedOut Whether our own timeout fired.
 * @return {RefundProviderError} A timeout or a dropped connection is AMBIGUOUS for a
 *   write (the request may have landed) and merely retryable for a read.
 */
function transportFailure(spec: RequestSpec<unknown>, timedOut: boolean): RefundProviderError {
  const code = timedOut ? "timeout" : "network_error";
  const message = timedOut ?
    `Razorpay ${spec.operation} timed out.` :
    `Razorpay ${spec.operation} did not complete (network error).`;
  return spec.isWrite ?
    new ProviderOutcomeUnknownError(message, code) :
    new ProviderRetryableError(code, message, {mayHaveBeenApplied: false});
}

/**
 * @param {RequestSpec<unknown>} spec The request whose answer was unreadable.
 * @param {number} status The HTTP status of the unreadable answer.
 * @return {RefundProviderError} AMBIGUOUS for a write: the provider answered 2xx, so it
 *   may well have created the refund.
 */
function malformedFailure(spec: RequestSpec<unknown>, status: number): RefundProviderError {
  const message = `Razorpay ${spec.operation} returned an unreadable answer.`;
  return spec.isWrite ?
    new ProviderOutcomeUnknownError(message, "malformed_response", status) :
    new ProviderRetryableError("malformed_response", message, {httpStatus: status, mayHaveBeenApplied: false});
}

/**
 * @param {unknown} value A caller-supplied provider ID.
 * @param {string} label What it is, for the error.
 * @return {string} The ID, if it is safe to place in a URL path.
 * @throws {ProviderRefundRejectedError} If it is not (a local bug; nothing is sent).
 */
export function requireProviderId(value: string, label: string): string {
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new ProviderRefundRejectedError("invalid_input", `The ${label} is not a valid provider ID.`);
  }
  return value;
}

/**
 * The one bounded HTTP request Razorpay's server API is called through: credentials →
 * timeout → send → classify → parse. Shared by the refund gateway below and the payment
 * lookup gateway (`razorpayPayments.ts`), so both get the same timeout, the same
 * credential redaction and the same typed failures.
 *
 * @param {RazorpayRefundGatewayOptions} options Credentials, and test seams.
 * @return {<T>(spec: RequestSpec<T>) => Promise<T>} The request function.
 * @throws {Error} If `timeoutMs` is out of range.
 */
export function createRazorpayRequester(
  options: RazorpayRefundGatewayOptions,
): <T>(spec: RequestSpec<T>) => Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REFUND_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REFUND_REQUEST_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be a whole number from 1 to ${MAX_REFUND_REQUEST_TIMEOUT_MS}.`);
  }
  const baseUrl = options.baseUrl ?? RAZORPAY_API_BASE_URL;
  const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));

  /**
   * @param {RequestSpec<T>} spec The request.
   * @return {Promise<T>} The parsed, normalized answer.
   * @template T
   */
  async function send<T>(spec: RequestSpec<T>): Promise<T> {
    let credentials: RazorpayCredentials;
    try {
      credentials = options.getCredentials();
    } catch {
      // The underlying message names which setting is missing — never a value.
      throw new ProviderConfigurationError("credentials_missing", "Razorpay credentials are not configured.");
    }
    if (!credentials.keyId || !credentials.keySecret) {
      throw new ProviderConfigurationError("credentials_missing", "Razorpay credentials are not configured.");
    }

    const query = spec.query ? `?${new URLSearchParams(spec.query).toString()}` : "";
    const url = `${baseUrl}${spec.path}${query}`;
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Authorization": `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
      ...spec.headers,
    };
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let status: number;
    let bodyText: string;
    try {
      const response = await fetchFn(url, {
        method: spec.method,
        headers,
        body: spec.body,
        redirect: "manual",
        signal: controller.signal,
      });
      status = response.status;
      bodyText = await response.text();
    } catch {
      const failure = transportFailure(spec, timedOut);
      logger.warn("razorpay request did not complete", {
        operation: spec.operation, category: failure.category, code: failure.code,
      });
      throw failure;
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status > 299) {
      const failure = classifyHttpFailure(spec, status, bodyText, credentials);
      logger.warn("razorpay request failed", {
        operation: spec.operation, category: failure.category, code: failure.code, httpStatus: status,
      });
      throw failure;
    }
    try {
      if (bodyText.length > MAX_RESPONSE_CHARS) {
        throw new Error("response too large");
      }
      return spec.parse(JSON.parse(bodyText));
    } catch {
      const failure = malformedFailure(spec, status);
      logger.warn("razorpay response unreadable", {
        operation: spec.operation, category: failure.category, code: failure.code, httpStatus: status,
      });
      throw failure;
    }
  }

  return send;
}

/**
 * @param {RazorpayRefundGatewayOptions} options Credentials, and test seams.
 * @return {RefundProviderGateway} The Razorpay refund gateway.
 * @throws {Error} If `timeoutMs` is out of range.
 */
export function createRazorpayRefundGateway(options: RazorpayRefundGatewayOptions): RefundProviderGateway {
  const send = createRazorpayRequester(options);

  return {
    async createRefund(input: CreateProviderRefundInput): Promise<ProviderRefund> {
      const paymentId = requireProviderId(input.providerPaymentId, "payment ID");
      if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
        throw new ProviderRefundRejectedError("invalid_input", "The idempotency key is not valid.");
      }
      if (!Number.isSafeInteger(input.amountInPaise) || input.amountInPaise < 1) {
        throw new ProviderRefundRejectedError("invalid_input", "The refund amount must be a whole number of paise.");
      }
      if (!input.receipt) {
        throw new ProviderRefundRejectedError("invalid_input", "The refund needs a receipt.");
      }
      // Fixed key order: a retry sends a byte-identical body, which the provider's
      // idempotency requires.
      const body = JSON.stringify({
        amount: input.amountInPaise,
        speed: input.speed,
        receipt: input.receipt,
        notes: {zestoRefundId: input.notes.zestoRefundId, zestoOrderId: input.notes.zestoOrderId},
      });
      return send({
        operation: "createRefund",
        method: "POST",
        path: `/payments/${paymentId}/refund`,
        body,
        headers: {"X-Refund-Idempotency": input.idempotencyKey},
        isWrite: true,
        parse: (json) => {
          const refund = toProviderRefund(json);
          // A refund for another payment or amount is not the answer to THIS request.
          if (refund.providerPaymentId !== paymentId || refund.amountInPaise !== input.amountInPaise) {
            throw new Error("response does not match the request");
          }
          return refund;
        },
      });
    },

    async fetchRefund(providerRefundId: string): Promise<ProviderRefund> {
      return send({
        operation: "fetchRefund",
        method: "GET",
        path: `/refunds/${requireProviderId(providerRefundId, "refund ID")}`,
        isWrite: false,
        parse: toProviderRefund,
      });
    },

    async listPaymentRefunds(providerPaymentId: string): Promise<ProviderRefund[]> {
      const paymentId = requireProviderId(providerPaymentId, "payment ID");
      const refunds: ProviderRefund[] = [];
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const items = await send({
          operation: "listPaymentRefunds",
          method: "GET",
          path: `/payments/${paymentId}/refunds`,
          query: {count: String(LIST_PAGE_SIZE), skip: String(page * LIST_PAGE_SIZE)},
          isWrite: false,
          // One unreadable item fails the whole listing: skipping it could skip OUR refund.
          parse: (json) => collectionSchema.parse(json).items.map(toProviderRefund),
        });
        refunds.push(...items);
        if (items.length < LIST_PAGE_SIZE) {
          return refunds;
        }
      }
      throw new ProviderRetryableError(
        "pagination_limit_exceeded",
        "Razorpay listPaymentRefunds returned more refunds than expected.",
        {mayHaveBeenApplied: false},
      );
    },

    async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
      return send({
        operation: "fetchPayment",
        method: "GET",
        path: `/payments/${requireProviderId(providerPaymentId, "payment ID")}`,
        isWrite: false,
        parse: toProviderPayment,
      });
    },
  };
}

let razorpayRefundGateway: RefundProviderGateway | undefined;

/**
 * The process-wide real refund gateway, created on first use, reading the existing
 * server-side `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (the secret must be declared
 * on whichever function calls this). Tests inject a fake instead of calling it.
 *
 * @return {RefundProviderGateway} The shared gateway.
 */
export function getRazorpayRefundGateway(): RefundProviderGateway {
  if (!razorpayRefundGateway) {
    razorpayRefundGateway = createRazorpayRefundGateway({
      getCredentials: () => ({keyId: getRazorpayKeyId(), keySecret: getRazorpayKeySecret()}),
    });
  }
  return razorpayRefundGateway;
}

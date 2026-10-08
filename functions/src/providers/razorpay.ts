import {createHash, createHmac, timingSafeEqual} from "node:crypto";
import RazorpaySdk from "razorpay";
import {defineSecret, defineString} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

/**
 * The Razorpay provider boundary (see root CLAUDE.md's "Never trust the
 * frontend for security" and this checkpoint's "Razorpay provider boundary"
 * notes). Everything Razorpay-specific — its SDK, its request/response
 * shapes, its credentials — lives here. `domain/payments.ts` depends only on
 * the small `PaymentProviderGateway` abstraction this module exports, never
 * on the Razorpay SDK directly, so a future second provider (or a test)
 * never needs to touch the domain layer.
 *
 * TEST MODE ONLY for this checkpoint: whatever `key_id`/`key_secret` are
 * configured are whatever the deployer put there — this module has no
 * concept of "test" vs "live" beyond that (Razorpay Test Mode keys are just
 * regular keys scoped to a test account). Never process a real payment or
 * add live-mode credentials as part of this checkpoint.
 */

/**
 * Razorpay's public Checkout `key_id`. Not a secret — it's meant to be
 * embedded in client-side Checkout code (a later checkpoint) — so a string
 * param is sufficient, the same reasoning `auth/descopeClient.ts`'s
 * `descopeProjectId` uses for the Descope Project ID. Read from
 * `functions/.env`/`.env.<project>`/`.env.local` (see `functions/.env.example`).
 */
export const razorpayKeyId = defineString("RAZORPAY_KEY_ID", {
  description: "Razorpay key_id (Test Mode for now). Public — safe to return to the client Checkout SDK.",
});

/**
 * Razorpay's `key_secret`. A REAL secret: stored in Cloud Secret Manager in
 * production (declared on the `api` function's `secrets` array — see
 * `index.ts`) and, for the local emulator, in `functions/.secret.local`
 * (gitignored by the existing `*.local` rule, exactly like `.env.local` —
 * see Firebase's secret-params emulator docs). Never read from `.env.local`,
 * never logged, never returned in any API response.
 */
export const razorpayKeySecret = defineSecret("RAZORPAY_KEY_SECRET", {
  description: "Razorpay key_secret (Test Mode for now). Server-only — never log or return this value.",
});

/**
 * The secret Razorpay signs WEBHOOK deliveries with. Configured independently
 * in the Razorpay Dashboard (Accounts & Settings → Webhooks) and DELIBERATELY
 * a different secret from `RAZORPAY_KEY_SECRET` above: the API key secret
 * authenticates Zesto to Razorpay (and signs Checkout results), this one
 * authenticates Razorpay to Zesto. Never reuse one for the other, so that a
 * leak of either does not compromise both directions.
 *
 * A REAL secret, handled exactly like `razorpayKeySecret`: Cloud Secret
 * Manager in production (declared on the `api` function's `secrets` array in
 * `index.ts`), `functions/.secret.local` for the local emulator. Never in
 * source control, Firestore, an API response, or a log line.
 */
export const razorpayWebhookSecret = defineSecret("RAZORPAY_WEBHOOK_SECRET", {
  description: "Razorpay webhook signing secret (Test Mode for now). Server-only — never log or return this value.",
});

/**
 * @return {string} The configured Razorpay `key_id`, trimmed.
 * @throws {Error} If `RAZORPAY_KEY_ID` is missing or blank.
 */
export function getRazorpayKeyId(): string {
  const value = razorpayKeyId.value().trim();
  if (!value) {
    throw new Error("RAZORPAY_KEY_ID is not configured.");
  }
  return value;
}

/**
 * @return {string} The configured Razorpay `key_secret`, trimmed.
 * @throws {Error} If `RAZORPAY_KEY_SECRET` is missing or blank.
 */
export function getRazorpayKeySecret(): string {
  const value = razorpayKeySecret.value().trim();
  if (!value) {
    throw new Error("RAZORPAY_KEY_SECRET is not configured.");
  }
  return value;
}

/**
 * @return {string} The configured Razorpay webhook signing secret, trimmed.
 * @throws {Error} If `RAZORPAY_WEBHOOK_SECRET` is missing or blank — a
 *   server misconfiguration, deliberately never reported to the caller as
 *   "signature invalid", and never containing the secret itself.
 */
export function getRazorpayWebhookSecret(): string {
  const value = razorpayWebhookSecret.value().trim();
  if (!value) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET is not configured.");
  }
  return value;
}

/**
 * Input to `verifyCheckoutSignature`: the trusted server-side Razorpay order
 * ID for this payment (see that function's doc comment — NEVER a
 * client-supplied `razorpay_order_id` taken at face value), and the
 * `razorpay_payment_id`/`razorpay_signature` the browser received from
 * Razorpay Checkout and submitted to
 * `POST /orders/{orderId}/payment/verify`.
 */
export interface VerifyCheckoutSignatureInput {
  providerOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

/**
 * @param {string} a One hex string.
 * @param {string} b Another hex string.
 * @return {boolean} Whether `a` and `b` are equal, compared in constant
 *   time. Both are hashed to a fixed-length digest first, so this never has
 *   to branch on a length mismatch (which `crypto.timingSafeEqual` itself
 *   would throw on) before comparing — an attacker learns nothing about
 *   either string's length, let alone its content, from response timing.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Verifies a Razorpay Checkout payment signature — the exact algorithm
 * Razorpay's current documentation requires: an HMAC-SHA256 of
 * `"{order_id}|{payment_id}"`, keyed with the server-side `key_secret`, must
 * equal the `razorpay_signature` value Checkout handed the browser.
 *
 * `input.providerOrderId` MUST be the TRUSTED, server-stored
 * `payment.providerOrderId` (see `domain/payments.ts`'s
 * `verifyCheckoutPayment`, the only caller) — never a client-supplied
 * `razorpay_order_id` taken at face value. Using an untrusted order ID here
 * would let a caller compute a self-consistent but meaningless signature
 * over an order ID of their own choosing; the entire point of this check is
 * that the order ID came from OUR OWN prior `ensureProviderOrder` call, not
 * from the request being verified.
 *
 * A pure, synchronous, local computation — no network call, and (unlike
 * `createOrder`/`fetchOrder`) not part of the `PaymentProviderGateway`
 * abstraction: it needs only the server-side key secret (via
 * `getRazorpayKeySecret`), not a Razorpay SDK client instance, and tests can
 * make it deterministic the same way `razorpay.test.ts` already does for
 * `getRazorpayKeyId`/`getRazorpayKeySecret` — by stubbing
 * `RAZORPAY_KEY_SECRET` — without needing a fake gateway.
 *
 * @param {VerifyCheckoutSignatureInput} input The trusted provider order ID
 *   and the submitted payment ID/signature.
 * @return {boolean} Whether the signature is valid for these exact values.
 * @throws {Error} If `RAZORPAY_KEY_SECRET` is not configured (see
 *   `getRazorpayKeySecret`) — a server misconfiguration, deliberately not
 *   reported to the caller as "signature invalid", and never containing the
 *   secret itself.
 */
export function verifyCheckoutSignature(input: VerifyCheckoutSignatureInput): boolean {
  const expectedSignature = createHmac("sha256", getRazorpayKeySecret())
    .update(`${input.providerOrderId}|${input.razorpayPaymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expectedSignature, input.razorpaySignature);
}

/**
 * Input to `verifyWebhookSignature`: the EXACT bytes of the webhook request
 * body as Razorpay sent them, and the value of its `X-Razorpay-Signature`
 * header.
 */
export interface VerifyWebhookSignatureInput {
  /** The raw request body, untouched — see `verifyWebhookSignature`. */
  rawBody: Buffer | string;
  signature: string;
}

/**
 * Verifies a Razorpay WEBHOOK signature, per Razorpay's current webhook
 * validation guidance: the `X-Razorpay-Signature` header must equal the
 * hex-encoded HMAC-SHA256 of the webhook request body, keyed with the
 * webhook secret configured for that webhook in the Razorpay Dashboard.
 *
 * `input.rawBody` MUST be the raw request body exactly as received — never
 * the result of `JSON.parse`/`JSON.stringify`. Razorpay signs the bytes it
 * sent; any whitespace, key-order, escaping, or number-formatting change
 * introduced by parsing and re-serializing makes a genuine delivery fail
 * verification (and, conversely, would let a differently-formatted body be
 * compared against a signature that was never computed over it). Callers
 * must therefore read the body from the runtime's raw-body facility
 * (`request.rawBody` — see `http/request.ts`), and only parse JSON AFTER
 * this returns true.
 *
 * This is a DIFFERENT operation from `verifyCheckoutSignature`: that one
 * proves a browser's Checkout result (HMAC over `orderId|paymentId`, keyed
 * with the API key secret); this one proves a request really came from
 * Razorpay (HMAC over the whole raw body, keyed with the separate webhook
 * secret). Neither secret, input, nor result is interchangeable with the
 * other's, and they are tested separately.
 *
 * A pure, synchronous, local computation — no network call.
 *
 * @param {VerifyWebhookSignatureInput} input The raw body and the
 *   submitted signature.
 * @return {boolean} Whether the signature is valid for exactly this body.
 * @throws {Error} If `RAZORPAY_WEBHOOK_SECRET` is not configured (see
 *   `getRazorpayWebhookSecret`).
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  const expectedSignature = createHmac("sha256", getRazorpayWebhookSecret())
    .update(input.rawBody)
    .digest("hex");
  return timingSafeEqualHex(expectedSignature, input.signature);
}

/**
 * A provider order, reduced to what the payment domain needs — never the
 * raw Razorpay SDK response object (which carries many fields this app has
 * no use for; see this checkpoint's "do not expose raw provider SDK objects
 * throughout the domain").
 */
export interface ProviderOrder {
  id: string;
  amountInPaise: number;
  currency: string;
  receipt?: string;
  status: string;
}

/** Input to `PaymentProviderGateway.createOrder`. Deliberately just
 * `amount`/`currency`/`receipt` — see this checkpoint's "Razorpay order
 * fields" notes: no customer PII, no notes, nothing beyond the minimum. */
export interface CreateProviderOrderInput {
  amountInPaise: number;
  currency: string;
  receipt: string;
}

/**
 * The small typed abstraction `domain/payments.ts` depends on instead of the
 * Razorpay SDK. A future second provider would implement this same
 * interface; a test replaces it with a fake — either way, the domain layer
 * never changes.
 */
export interface PaymentProviderGateway {
  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder>;
  fetchOrder(providerOrderId: string): Promise<ProviderOrder>;
}

/**
 * A provider failure, safe to convert into a customer-facing error (see
 * `domain/payments.ts`'s `ensureProviderOrder`). Never carries the raw
 * Razorpay error as its own `message` — that's logged server-side (see
 * `createRazorpayGateway`) and kept out of anything that could reach an API
 * response.
 */
export class PaymentProviderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

/** The minimal shape of a Razorpay SDK order response this module reads —
 * satisfied structurally by the real `razorpay` package's `Orders.RazorpayOrder`,
 * and by a small fake in tests. */
interface RazorpayOrderLike {
  id: string;
  amount: number | string;
  currency: string;
  receipt?: string;
  status: string;
}

/** The minimal shape of the Razorpay SDK client this module calls —
 * satisfied structurally by a real `Razorpay` instance, and by a fake in
 * tests (see this checkpoint's "unit tests should mock the provider
 * abstraction" requirement). */
interface RazorpayClientLike {
  orders: {
    create(params: {amount: number; currency: string; receipt?: string}): Promise<RazorpayOrderLike>;
    fetch(orderId: string): Promise<RazorpayOrderLike>;
  };
}

/**
 * @param {RazorpayOrderLike} order A raw Razorpay SDK order response.
 * @return {ProviderOrder} The reduced shape `PaymentProviderGateway` returns.
 */
function toProviderOrder(order: RazorpayOrderLike): ProviderOrder {
  return {
    id: order.id,
    amountInPaise: typeof order.amount === "string" ? Number(order.amount) : order.amount,
    currency: order.currency,
    receipt: order.receipt,
    status: order.status,
  };
}

/**
 * @param {unknown} error Whatever the Razorpay SDK rejected with — typically
 *   an `INormalizeError`-shaped object (`{statusCode, error: {code,
 *   description}}`), never containing `key_secret`.
 * @return {{code?: string; description?: string; statusCode?: string | number}}
 *   The safe-to-log fields, if the error has that shape; otherwise `{}`.
 */
function safeErrorFields(error: unknown): {code?: string; description?: string; statusCode?: string | number} {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const {statusCode, error: inner} = error as {statusCode?: string | number; error?: {code?: string; description?: string}};
  return {statusCode, code: inner?.code, description: inner?.description};
}

/**
 * How long an order create/fetch may take before it is given up on. The `razorpay` SDK
 * sets no request timeout of its own (see `razorpayRefunds.ts`'s file header), so
 * without this a hung connection would hold a customer's request until the function's
 * own 60 s timeout. Giving up is safe here: an order is created once per payment and a
 * retry simply creates a fresh, unpaid provider order (`ensureProviderOrder`).
 */
export const ORDER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * @param {Promise<T>} promise A provider call.
 * @param {number} timeoutMs How long to wait for it.
 * @return {Promise<T>} The call's result, or a rejection if it takes longer than
 *   `timeoutMs`. The abandoned call is not cancelled (the SDK offers no way to).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Razorpay request timed out.")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {string} keyId A Razorpay `key_id`.
 * @return {"test" | "live" | "unknown"} The mode its public prefix names (`rzp_test_` /
 *   `rzp_live_`). Razorpay keys are mode-scoped, so this is the one reliable signal of
 *   which environment the deployed credentials belong to.
 */
export function razorpayModeOf(keyId: string): "test" | "live" | "unknown" {
  if (keyId.startsWith("rzp_test_")) {
    return "test";
  }
  return keyId.startsWith("rzp_live_") ? "live" : "unknown";
}

/**
 * Wraps an already-constructed Razorpay-SDK-shaped client into the
 * `PaymentProviderGateway` abstraction. A pure factory — no config reading,
 * no memoization — so tests can pass a fake client directly (see this
 * checkpoint's "unit tests should mock the provider abstraction").
 *
 * @param {RazorpayClientLike} client The Razorpay SDK client (or a test
 *   double structurally matching it).
 * @return {PaymentProviderGateway} The gateway.
 */
export function createRazorpayGateway(
  client: RazorpayClientLike,
  timeoutMs: number = ORDER_REQUEST_TIMEOUT_MS,
): PaymentProviderGateway {
  return {
    async createOrder(input) {
      try {
        const order = await withTimeout(client.orders.create({
          amount: input.amountInPaise,
          currency: input.currency,
          receipt: input.receipt,
        }), timeoutMs);
        return toProviderOrder(order);
      } catch (error) {
        logger.error("razorpay order creation failed", safeErrorFields(error));
        throw new PaymentProviderError("Razorpay order creation failed.", error);
      }
    },
    async fetchOrder(providerOrderId) {
      try {
        const order = await withTimeout(client.orders.fetch(providerOrderId), timeoutMs);
        return toProviderOrder(order);
      } catch (error) {
        logger.error("razorpay order fetch failed", safeErrorFields(error));
        throw new PaymentProviderError("Razorpay order fetch failed.", error);
      }
    },
  };
}

let razorpayClient: RazorpayClientLike | undefined;

/**
 * @return {RazorpayClientLike} The shared real Razorpay SDK client, created
 *   on first use (deferred for the same reason
 *   `auth/descopeClient.ts`'s `getDescopeClient` defers: param values are
 *   only available at runtime, not while deploy tooling loads this module).
 * @throws {Error} If `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are not configured.
 */
function getRazorpayClient(): RazorpayClientLike {
  if (!razorpayClient) {
    const keyId = getRazorpayKeyId();
    razorpayClient = new RazorpaySdk({
      key_id: keyId,
      key_secret: getRazorpayKeySecret(),
    });
    // The mode only (a public prefix), never a key: lets an operator confirm from the logs
    // which Razorpay environment a deployment is talking to.
    logger.info("razorpay client initialised", {mode: razorpayModeOf(keyId)});
  }
  return razorpayClient;
}

let razorpayGateway: PaymentProviderGateway | undefined;

/**
 * The process-wide real Razorpay gateway, created on first use. Production
 * code's default; tests inject `createRazorpayGateway(fakeClient)` (or a
 * hand-built `PaymentProviderGateway`) instead of ever calling this.
 *
 * @return {PaymentProviderGateway} The shared gateway.
 */
export function getRazorpayGateway(): PaymentProviderGateway {
  if (!razorpayGateway) {
    razorpayGateway = createRazorpayGateway(getRazorpayClient());
  }
  return razorpayGateway;
}

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
 * Wraps an already-constructed Razorpay-SDK-shaped client into the
 * `PaymentProviderGateway` abstraction. A pure factory — no config reading,
 * no memoization — so tests can pass a fake client directly (see this
 * checkpoint's "unit tests should mock the provider abstraction").
 *
 * @param {RazorpayClientLike} client The Razorpay SDK client (or a test
 *   double structurally matching it).
 * @return {PaymentProviderGateway} The gateway.
 */
export function createRazorpayGateway(client: RazorpayClientLike): PaymentProviderGateway {
  return {
    async createOrder(input) {
      try {
        const order = await client.orders.create({
          amount: input.amountInPaise,
          currency: input.currency,
          receipt: input.receipt,
        });
        return toProviderOrder(order);
      } catch (error) {
        logger.error("razorpay order creation failed", safeErrorFields(error));
        throw new PaymentProviderError("Razorpay order creation failed.", error);
      }
    },
    async fetchOrder(providerOrderId) {
      try {
        const order = await client.orders.fetch(providerOrderId);
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
    razorpayClient = new RazorpaySdk({
      key_id: getRazorpayKeyId(),
      key_secret: getRazorpayKeySecret(),
    });
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

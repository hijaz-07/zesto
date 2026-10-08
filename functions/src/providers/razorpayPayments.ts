import {z} from "zod";
import {getRazorpayKeyId, getRazorpayKeySecret} from "./razorpay";
import type {PaymentLookupGateway, ProviderOrderPayment} from "./paymentLookupGateway";
import {
  createRazorpayRequester,
  requireProviderId,
  type RazorpayRefundGatewayOptions,
} from "./razorpayRefunds";

/**
 * The Razorpay implementation of `PaymentLookupGateway`, over the same bounded HTTPS
 * requester the refund gateway uses (explicit timeout, credential redaction, typed
 * failures; never an automatic retry — see `razorpayRefunds.ts`).
 *
 * Provider facts relied on (Razorpay API docs, "Fetch Payments for an Order", read while
 * building checkpoint 4.6):
 * - `GET /v1/orders/{id}/payments` returns `{entity: "collection", count, items: [payment]}`;
 * - each payment has `id`, `order_id`, `amount` and `amount_refunded` (smallest currency unit),
 *   `currency`, `status` (`created` | `authorized` | `captured` | `refunded` | `failed`),
 *   `captured` (boolean) and `created_at` (epoch seconds);
 * - the docs list NO pagination or filter parameters, so none is sent.
 *
 * Unverified: how the list behaves for an order with a very large number of attempts
 * (no limit is documented), and whether an `authorized`-only payment is included in every
 * account configuration. Neither can make the reconciler mark a payment paid wrongly: it
 * adopts only a payment that the provider itself reports `captured`.
 *
 * Strictness: ONE unreadable item fails the whole listing (`malformed_response`, retryable),
 * because skipping it could skip the very payment Zesto is looking for.
 */

const orderPaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().nullish(),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  captured: z.boolean(),
  amount_refunded: z.number().int().nonnegative().nullish(),
  created_at: z.number().int().nullish(),
});

const collectionSchema = z.object({items: z.array(z.unknown())});

/** More attempts than this against one order means something is wrong; the listing is refused. */
const MAX_ITEMS = 500;

/**
 * @param {unknown} json A provider payment object.
 * @return {ProviderOrderPayment} The normalized payment (never the raw provider object).
 * @throws {z.ZodError} If it is not a well-formed payment.
 */
function toOrderPayment(json: unknown): ProviderOrderPayment {
  const raw = orderPaymentSchema.parse(json);
  return {
    id: raw.id,
    providerOrderId: raw.order_id ?? null,
    amountInPaise: raw.amount,
    currency: raw.currency,
    status: raw.status,
    captured: raw.captured,
    amountRefundedInPaise: raw.amount_refunded ?? 0,
    ...(typeof raw.created_at === "number" ? {createdAtEpochSeconds: raw.created_at} : {}),
  };
}

/**
 * @param {RazorpayRefundGatewayOptions} options Credentials, and test seams.
 * @return {PaymentLookupGateway} The Razorpay payment lookup gateway.
 */
export function createRazorpayPaymentLookupGateway(options: RazorpayRefundGatewayOptions): PaymentLookupGateway {
  const send = createRazorpayRequester(options);
  return {
    async listOrderPayments(providerOrderId: string): Promise<ProviderOrderPayment[]> {
      const orderId = requireProviderId(providerOrderId, "order ID");
      return send({
        operation: "listOrderPayments",
        method: "GET",
        path: `/orders/${orderId}/payments`,
        isWrite: false,
        parse: (json) => {
          const items = collectionSchema.parse(json).items;
          if (items.length > MAX_ITEMS) {
            throw new Error("too many payments");
          }
          return items.map(toOrderPayment);
        },
      });
    },
  };
}

let razorpayPaymentLookupGateway: PaymentLookupGateway | undefined;

/**
 * The process-wide real payment lookup gateway, created on first use from the existing
 * server-side `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (the secret must be declared on
 * whichever function calls this). Tests inject a fake instead.
 *
 * @return {PaymentLookupGateway} The shared gateway.
 */
export function getRazorpayPaymentLookupGateway(): PaymentLookupGateway {
  if (!razorpayPaymentLookupGateway) {
    razorpayPaymentLookupGateway = createRazorpayPaymentLookupGateway({
      getCredentials: () => ({keyId: getRazorpayKeyId(), keySecret: getRazorpayKeySecret()}),
    });
  }
  return razorpayPaymentLookupGateway;
}

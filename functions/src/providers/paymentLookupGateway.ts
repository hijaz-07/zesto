import type {ProviderPayment} from "./refundGateway";

/**
 * The provider-neutral contract for asking the provider what became of the payments
 * made against one of Zesto's provider orders. Types only: no HTTP, no SDK, no secret.
 * The real implementation is `razorpayPayments.ts`; `paymentLookupGateway.fake.ts` is
 * the deterministic double the tests use.
 *
 * It is a READ-ONLY capability: reconciliation never creates, captures or refunds
 * anything at the provider. Its failures are the same typed errors the refund gateway
 * uses (`refundGateway.ts`): a lookup that fails proves nothing about the payment, and
 * the caller must treat every failure as "try again later", never as "not paid".
 *
 * The question it answers is "which payments exist for THIS provider order?" — keyed by
 * the provider order ID Zesto itself stored before the customer could pay, never by an
 * amount, a customer detail or anything client-supplied.
 */

/** One payment attempt the provider holds for an order. */
export interface ProviderOrderPayment extends ProviderPayment {
  /** Epoch seconds the attempt was created, when the provider says (orders attempts from oldest to newest). */
  createdAtEpochSeconds?: number;
}

export interface PaymentLookupGateway {
  /**
   * Lists EVERY payment attempt the provider holds for a provider order (captured,
   * authorized, failed, ...), as the provider reports them. An order nobody has tried
   * to pay yields an empty list — which is an answer, not an error.
   */
  listOrderPayments(providerOrderId: string): Promise<ProviderOrderPayment[]>;
}

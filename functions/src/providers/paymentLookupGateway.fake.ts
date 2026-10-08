import {
  ProviderConfigurationError,
  ProviderOutcomeUnknownError,
  ProviderRetryableError,
} from "./refundGateway";
import type {PaymentLookupGateway, ProviderOrderPayment} from "./paymentLookupGateway";

/**
 * A deterministic, in-memory `PaymentLookupGateway` for tests — never shipped (excluded
 * from the build with the other `*.fake.ts`) and never talking to anything.
 *
 * It returns exactly what a test put there: `setPayments(orderId, [...])` is what the
 * provider "holds" for that order, INCLUDING items a test makes deliberately wrong (a
 * payment of another order, a mismatched amount, an inconsistent status) so the
 * reconciler's matching rules can be proven against hostile or buggy answers.
 *
 * Faults are scripted once each, in order, then calls behave normally:
 * - `"timeout"`: throws `ProviderRetryableError` (a read that did not complete);
 * - `"unknown"`: throws `ProviderOutcomeUnknownError`;
 * - `"rate_limited"` / `"server_error"`: `ProviderRetryableError`;
 * - `"auth_failure"`: `ProviderConfigurationError`;
 * - `"plain_error"`: an untyped `Error` (an unexpected local failure);
 * - `{beforeAnswer}`: runs the callback (e.g. to let a webhook win the race) and then answers normally.
 */

export type FakePaymentLookupFault =
  | "timeout"
  | "unknown"
  | "rate_limited"
  | "server_error"
  | "auth_failure"
  | "plain_error"
  | {beforeAnswer: () => Promise<void>};

export interface FakePaymentLookupGateway extends PaymentLookupGateway {
  /** Replaces what the provider holds for a provider order. */
  setPayments(providerOrderId: string, payments: ProviderOrderPayment[]): void;
  /** Queues faults for the next `listOrderPayments` calls. */
  script(...faults: FakePaymentLookupFault[]): void;
  /** Every provider order ID asked about, in order (including calls made to fail). */
  readonly calls: readonly string[];
}

/**
 * @param {Partial<ProviderOrderPayment> & Pick<ProviderOrderPayment, "id" | "providerOrderId">} fields
 *   What to override; the rest is a valid captured Rs 100 payment.
 * @return {ProviderOrderPayment} A provider payment.
 */
export function providerOrderPayment(
  fields: Partial<ProviderOrderPayment> & Pick<ProviderOrderPayment, "id" | "providerOrderId">,
): ProviderOrderPayment {
  return {
    amountInPaise: 10000,
    currency: "INR",
    status: "captured",
    captured: true,
    amountRefundedInPaise: 0,
    ...fields,
  };
}

/**
 * @return {FakePaymentLookupGateway} A fresh fake holding nothing.
 */
export function createFakePaymentLookupGateway(): FakePaymentLookupGateway {
  const held = new Map<string, ProviderOrderPayment[]>();
  const faults: FakePaymentLookupFault[] = [];
  const calls: string[] = [];

  return {
    setPayments(providerOrderId, payments) {
      held.set(providerOrderId, payments.map((p) => ({...p})));
    },
    script(...next) {
      faults.push(...next);
    },
    get calls() {
      return calls;
    },
    async listOrderPayments(providerOrderId) {
      calls.push(providerOrderId);
      const fault = faults.shift();
      if (fault === "timeout") {
        throw new ProviderRetryableError("timeout", "The fake provider timed out.", {mayHaveBeenApplied: false});
      }
      if (fault === "unknown") {
        throw new ProviderOutcomeUnknownError("The fake provider did not answer.");
      }
      if (fault === "rate_limited") {
        throw new ProviderRetryableError("rate_limited", "The fake provider is rate limiting.", {
          httpStatus: 429, mayHaveBeenApplied: false,
        });
      }
      if (fault === "server_error") {
        throw new ProviderRetryableError("provider_server_error", "The fake provider failed.", {
          httpStatus: 500, mayHaveBeenApplied: false,
        });
      }
      if (fault === "auth_failure") {
        throw new ProviderConfigurationError("provider_auth_rejected", "The fake provider rejected the credentials.", 401);
      }
      if (fault === "plain_error") {
        throw new Error("unexpected local failure");
      }
      if (typeof fault === "object") {
        await fault.beforeAnswer();
      }
      return (held.get(providerOrderId) ?? []).map((p) => ({...p}));
    },
  };
}

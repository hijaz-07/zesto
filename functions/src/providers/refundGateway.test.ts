// @vitest-environment node
import {describe, expect, it} from "vitest";
import {
  ProviderConfigurationError,
  ProviderOutcomeUnknownError,
  ProviderRefundRejectedError,
  ProviderRetryableError,
  isRefundProviderError,
  type CreateProviderRefundInput,
  type RefundProviderGateway,
} from "./refundGateway";
import {createFakeRefundGateway, type FakeRefundGateway} from "./refundGateway.fake";
import {findMatchingProviderRefund} from "./refundLookup";

const PAYMENT = "pay_Test1";

function setup(): FakeRefundGateway {
  const gateway = createFakeRefundGateway();
  gateway.addPayment({id: PAYMENT, providerOrderId: "order_Test1", amountInPaise: 24000, currency: "INR"});
  return gateway;
}

function request(overrides: Partial<CreateProviderRefundInput> = {}): CreateProviderRefundInput {
  return {
    providerPaymentId: PAYMENT,
    amountInPaise: 24000,
    speed: "normal",
    idempotencyKey: "order-1-r1",
    receipt: "order-1-r1",
    notes: {zestoRefundId: "order-1-r1", zestoOrderId: "order-1"},
    ...overrides,
  };
}

/** The rejection a call throws, failing the test if it resolved or threw anything else. */
async function rejectionOf(promise: Promise<unknown>): Promise<ProviderRefundRejectedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderRefundRejectedError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a ProviderRefundRejectedError.");
}

describe("RefundProviderGateway contract (fake)", () => {
  it("satisfies the provider-neutral interface", () => {
    const gateway: RefundProviderGateway = setup();
    expect(Object.keys(gateway)).toEqual(expect.arrayContaining([
      "createRefund", "fetchRefund", "listPaymentRefunds", "fetchPayment",
    ]));
  });

  describe("createRefund", () => {
    it("creates a pending refund that echoes the receipt and notes, at normal speed", async () => {
      const gateway = setup();
      const refund = await gateway.createRefund(request());
      expect(refund).toMatchObject({
        id: "rfnd_fake_1",
        providerPaymentId: PAYMENT,
        amountInPaise: 24000,
        currency: "INR",
        status: "pending",
        receipt: "order-1-r1",
        notes: {zestoRefundId: "order-1-r1", zestoOrderId: "order-1"},
        speedRequested: "normal",
      });
    });

    it("is deterministic: refund IDs follow creation order", async () => {
      const gateway = setup();
      const first = await gateway.createRefund(request({amountInPaise: 100}));
      const second = await gateway.createRefund(request({
        amountInPaise: 100, idempotencyKey: "order-1-r2", receipt: "order-1-r2",
        notes: {zestoRefundId: "order-1-r2", zestoOrderId: "order-1"},
      }));
      expect([first.id, second.id]).toEqual(["rfnd_fake_1", "rfnd_fake_2"]);
    });

    it("replays the original refund for the same idempotency key and request: one refund, not two", async () => {
      const gateway = setup();
      const first = await gateway.createRefund(request());
      const replay = await gateway.createRefund(request());
      expect(replay).toEqual(first);
      expect(gateway.refunds()).toHaveLength(1);
    });

    it("rejects the same idempotency key with a different request", async () => {
      const gateway = setup();
      await gateway.createRefund(request());
      const error = await rejectionOf(gateway.createRefund(request({amountInPaise: 100})));
      expect(error.code).toBe("idempotency_conflict");
      expect(gateway.refunds()).toHaveLength(1);
    });

    it.each(["short", "has space 123", "bad/char/12345", ""])("rejects an invalid idempotency key (%j)", async (key) => {
      const error = await rejectionOf(setup().createRefund(request({idempotencyKey: key})));
      expect(error.code).toBe("invalid_idempotency_key");
    });

    it("rejects a refund that exceeds the payment", async () => {
      const error = await rejectionOf(setup().createRefund(request({amountInPaise: 24001})));
      expect(error.code).toBe("refund_amount_exceeds_remaining");
    });

    it("rejects a second refund beyond what remains, counting an unsettled refund against it", async () => {
      const gateway = setup();
      await gateway.createRefund(request({amountInPaise: 20000}));
      const error = await rejectionOf(gateway.createRefund(request({
        amountInPaise: 4001, idempotencyKey: "order-1-r2", receipt: "order-1-r2",
        notes: {zestoRefundId: "order-1-r2", zestoOrderId: "order-1"},
      })));
      expect(error.code).toBe("refund_amount_exceeds_remaining");
    });

    it("lets a failed refund's amount be refunded again by a NEW request", async () => {
      const gateway = setup();
      const first = await gateway.createRefund(request());
      gateway.settleRefund(first.id, "failed");
      const second = await gateway.createRefund(request({
        idempotencyKey: "order-1-r2", receipt: "order-1-r2",
        notes: {zestoRefundId: "order-1-r2", zestoOrderId: "order-1"},
      }));
      expect(second.id).not.toBe(first.id);
    });

    it.each([0, -5, 1.5, NaN])("rejects an invalid amount (%j)", async (amountInPaise) => {
      const error = await rejectionOf(setup().createRefund(request({amountInPaise})));
      expect(["invalid_amount", "refund_amount_exceeds_remaining"]).toContain(error.code);
    });

    it("rejects an unknown payment and a payment that was not captured", async () => {
      expect((await rejectionOf(setup().createRefund(request({providerPaymentId: "pay_nope"})))).code)
        .toBe("payment_not_found");
      const gateway = createFakeRefundGateway();
      gateway.addPayment({id: "pay_failed", providerOrderId: null, amountInPaise: 100, currency: "INR", status: "failed"});
      expect((await rejectionOf(gateway.createRefund(request({providerPaymentId: "pay_failed", amountInPaise: 100})))).code)
        .toBe("payment_not_captured");
    });
  });

  describe("response loss (the dangerous case)", () => {
    it("an unknown outcome BEFORE the request applied leaves nothing at the provider", async () => {
      const gateway = setup();
      gateway.script("createRefund", "unknown_before_apply");
      await expect(gateway.createRefund(request())).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      expect(await gateway.listPaymentRefunds(PAYMENT)).toEqual([]);
    });

    it("an unknown outcome AFTER the request applied leaves the refund at the provider, findable by notes", async () => {
      const gateway = setup();
      gateway.script("createRefund", "unknown_after_apply");
      await expect(gateway.createRefund(request())).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);

      const listed = await gateway.listPaymentRefunds(PAYMENT);
      expect(listed).toHaveLength(1);
      expect(listed[0].notes.zestoRefundId).toBe("order-1-r1");
      expect(listed[0].receipt).toBe("order-1-r1");
    });

    it("repeating the request with the same key after a lost response returns the same refund, never a second", async () => {
      const gateway = setup();
      gateway.script("createRefund", "unknown_after_apply");
      await expect(gateway.createRefund(request())).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      const retried = await gateway.createRefund(request());
      expect(retried.id).toBe("rfnd_fake_1");
      expect(gateway.refunds()).toHaveLength(1);
    });

    it("tells an unknown outcome apart from a definitive rejection by type", async () => {
      const gateway = setup();
      gateway.script("createRefund", "unknown_before_apply", {rejectWith: "BAD_REQUEST_ERROR"});
      const unknown = await gateway.createRefund(request()).catch((error: unknown) => error);
      const rejected = await gateway.createRefund(request()).catch((error: unknown) => error);
      expect(unknown).toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((unknown as ProviderOutcomeUnknownError).kind).toBe("unknown");
      expect(rejected).toBeInstanceOf(ProviderRefundRejectedError);
      expect((rejected as ProviderRefundRejectedError).kind).toBe("rejected");
      expect((rejected as ProviderRefundRejectedError).code).toBe("BAD_REQUEST_ERROR");
    });

    it("scripted faults are used once, in order, and then calls behave normally", async () => {
      const gateway = setup();
      gateway.script("fetchPayment", "unknown_before_apply");
      await expect(gateway.fetchPayment(PAYMENT)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      await expect(gateway.fetchPayment(PAYMENT)).resolves.toMatchObject({id: PAYMENT});
    });
  });

  describe("fetchRefund and listPaymentRefunds", () => {
    it("fetches a refund by its provider ID", async () => {
      const gateway = setup();
      const created = await gateway.createRefund(request());
      expect(await gateway.fetchRefund(created.id)).toEqual(created);
    });

    it("reports a refund moving to processed, as a webhook-less reconciliation would see it", async () => {
      const gateway = setup();
      const created = await gateway.createRefund(request());
      gateway.settleRefund(created.id, "processed");
      expect((await gateway.fetchRefund(created.id)).status).toBe("processed");
      expect((await gateway.listPaymentRefunds(PAYMENT))[0].status).toBe("processed");
    });

    it("rejects an unknown refund ID", async () => {
      expect((await rejectionOf(setup().fetchRefund("rfnd_nope"))).code).toBe("refund_not_found");
    });

    it("lists only the refunds of the asked-for payment", async () => {
      const gateway = setup();
      gateway.addPayment({id: "pay_other", providerOrderId: "order_Other", amountInPaise: 500, currency: "INR"});
      await gateway.createRefund(request());
      await gateway.createRefund(request({
        providerPaymentId: "pay_other", amountInPaise: 500, idempotencyKey: "order-2-r1", receipt: "order-2-r1",
        notes: {zestoRefundId: "order-2-r1", zestoOrderId: "order-2"},
      }));
      expect((await gateway.listPaymentRefunds(PAYMENT)).map((refund) => refund.providerPaymentId)).toEqual([PAYMENT]);
      expect(await gateway.listPaymentRefunds("pay_none")).toEqual([]);
    });
  });

  describe("fetchPayment", () => {
    it("reports a captured payment with nothing refunded", async () => {
      expect(await setup().fetchPayment(PAYMENT)).toEqual({
        id: PAYMENT, providerOrderId: "order_Test1", amountInPaise: 24000, currency: "INR",
        status: "captured", captured: true, amountRefundedInPaise: 0,
      });
    });

    it("counts unsettled refunds as refunded, and reports a full refund as refunded", async () => {
      const gateway = setup();
      await gateway.createRefund(request({amountInPaise: 10000}));
      expect(await gateway.fetchPayment(PAYMENT)).toMatchObject({status: "captured", amountRefundedInPaise: 10000});
      await gateway.createRefund(request({
        amountInPaise: 14000, idempotencyKey: "order-1-r2", receipt: "order-1-r2",
        notes: {zestoRefundId: "order-1-r2", zestoOrderId: "order-1"},
      }));
      expect(await gateway.fetchPayment(PAYMENT)).toMatchObject({
        status: "refunded", captured: true, amountRefundedInPaise: 24000,
      });
    });

    it("stops counting a failed refund", async () => {
      const gateway = setup();
      const created = await gateway.createRefund(request());
      gateway.settleRefund(created.id, "failed");
      expect(await gateway.fetchPayment(PAYMENT)).toMatchObject({status: "captured", amountRefundedInPaise: 0});
    });

    it("rejects an unknown payment", async () => {
      expect((await rejectionOf(setup().fetchPayment("pay_nope"))).code).toBe("payment_not_found");
    });
  });

  describe("call log", () => {
    it("records every call, including ones made to fail, in order", async () => {
      const gateway = setup();
      gateway.script("createRefund", "unknown_before_apply");
      await gateway.createRefund(request()).catch(() => undefined);
      await gateway.listPaymentRefunds(PAYMENT);
      expect(gateway.calls.map((call) => call.method)).toEqual(["createRefund", "listPaymentRefunds"]);
    });

    it("never needs a network, a secret or the Razorpay SDK: a fresh fake has no calls and no refunds", () => {
      const gateway = createFakeRefundGateway();
      expect(gateway.calls).toEqual([]);
      expect(gateway.refunds()).toEqual([]);
    });
  });

  describe("error types", () => {
    it("carry a kind, a category, a safe message and, for a rejection, a code", () => {
      const rejected = new ProviderRefundRejectedError("CODE", "Refused.");
      const unknown = new ProviderOutcomeUnknownError("Lost.");
      expect(rejected).toMatchObject({
        kind: "rejected", category: "DEFINITIVE_FAILURE", code: "CODE", message: "Refused.",
        name: "ProviderRefundRejectedError", mayHaveBeenApplied: false,
      });
      expect(unknown).toMatchObject({
        kind: "unknown", category: "AMBIGUOUS", code: "outcome_unknown", message: "Lost.",
        name: "ProviderOutcomeUnknownError", mayHaveBeenApplied: true,
      });
      expect(rejected).toBeInstanceOf(Error);
      expect(unknown).toBeInstanceOf(Error);
    });

    it("keeps all four categories distinguishable by type, category and kind", () => {
      const errors = [
        new ProviderRefundRejectedError("c", "m"),
        new ProviderRetryableError("c", "m", {httpStatus: 429, mayHaveBeenApplied: false}),
        new ProviderOutcomeUnknownError("m"),
        new ProviderConfigurationError("c", "m"),
      ];
      expect(errors.map((error) => error.category)).toEqual([
        "DEFINITIVE_FAILURE", "RETRYABLE_FAILURE", "AMBIGUOUS", "AUTH_CONFIGURATION",
      ]);
      expect(errors.map((error) => error.kind)).toEqual(["rejected", "retryable", "unknown", "configuration"]);
      expect(errors.map((error) => error.mayHaveBeenApplied)).toEqual([false, false, true, false]);
      expect(errors.every(isRefundProviderError)).toBe(true);
      expect(isRefundProviderError(new Error("plain"))).toBe(false);
    });
  });

  describe("scripted scenarios", () => {
    const lookup = {providerPaymentId: PAYMENT, zestoRefundId: "order-1-r1", amountInPaise: 24000};

    it("a refund comes back pending by default, or already processed when scripted", async () => {
      const gateway = setup();
      gateway.nextRefundStatus("processed");
      expect((await gateway.createRefund(request({amountInPaise: 100}))).status).toBe("processed");
      expect((await gateway.createRefund(request({
        amountInPaise: 100, idempotencyKey: "order-1-r2", receipt: "order-1-r2",
        notes: {zestoRefundId: "order-1-r2", zestoOrderId: "order-1"},
      }))).status).toBe("pending");
    });

    it("a definitive rejection is a DEFINITIVE_FAILURE that created nothing", async () => {
      const gateway = setup();
      gateway.script("createRefund", {rejectWith: "BAD_REQUEST_ERROR"});
      const error = await rejectionOf(gateway.createRefund(request()));
      expect(error).toMatchObject({category: "DEFINITIVE_FAILURE", mayHaveBeenApplied: false});
      expect(gateway.refunds()).toEqual([]);
    });

    it("rate limiting is RETRYABLE and nothing was applied", async () => {
      const gateway = setup();
      gateway.script("createRefund", "rate_limited");
      const error = await gateway.createRefund(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderRetryableError);
      expect(error).toMatchObject({category: "RETRYABLE_FAILURE", httpStatus: 429, mayHaveBeenApplied: false});
      expect(gateway.refunds()).toEqual([]);
    });

    it("a server error is RETRYABLE but may have been applied — before or after the fact", async () => {
      const gateway = setup();
      gateway.script("createRefund", "server_error", "server_error_after_apply");
      const before = await gateway.createRefund(request()).catch((e: unknown) => e);
      expect(before).toMatchObject({category: "RETRYABLE_FAILURE", httpStatus: 500, mayHaveBeenApplied: true});
      expect(gateway.refunds()).toEqual([]);
      await gateway.createRefund(request()).catch(() => undefined);
      expect(gateway.refunds()).toHaveLength(1);
    });

    it("a timeout, a reset connection and a malformed answer are AMBIGUOUS, with their cause as the code", async () => {
      for (const unknown of ["timeout", "connection_reset", "malformed_response"] as const) {
        const gateway = setup();
        gateway.script("createRefund", {unknown, applied: true});
        const error = await gateway.createRefund(request()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderOutcomeUnknownError);
        expect(error).toMatchObject({category: "AMBIGUOUS", code: unknown, mayHaveBeenApplied: true});
        expect(gateway.refunds()).toHaveLength(1);
      }
      const gateway = setup();
      gateway.script("createRefund", {unknown: "timeout", applied: false});
      await gateway.createRefund(request()).catch(() => undefined);
      expect(gateway.refunds()).toEqual([]);
    });

    it("a matching refund is found after a lost response", async () => {
      const gateway = setup();
      gateway.script("createRefund", "unknown_after_apply");
      await gateway.createRefund(request()).catch(() => undefined);
      expect(findMatchingProviderRefund(await gateway.listPaymentRefunds(PAYMENT), lookup))
        .toMatchObject({kind: "matched", refund: {id: "rfnd_fake_1"}});
    });

    it("no matching refund is found when the request never landed", async () => {
      const gateway = setup();
      gateway.script("createRefund", "unknown_before_apply");
      await gateway.createRefund(request()).catch(() => undefined);
      expect(findMatchingProviderRefund(await gateway.listPaymentRefunds(PAYMENT), lookup))
        .toEqual({kind: "none", unattributedSameAmount: []});
    });

    it("the lookup itself can fail — as a typed failure, never as 'no refund'", async () => {
      const gateway = setup();
      gateway.script("listPaymentRefunds", "unknown_before_apply", "server_error", "auth_failure");
      await expect(gateway.listPaymentRefunds(PAYMENT)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      await expect(gateway.listPaymentRefunds(PAYMENT)).rejects.toBeInstanceOf(ProviderRetryableError);
      await expect(gateway.listPaymentRefunds(PAYMENT)).rejects.toBeInstanceOf(ProviderConfigurationError);
      await expect(gateway.listPaymentRefunds(PAYMENT)).resolves.toEqual([]);
    });

    it("a duplicate idempotency key replays; a duplicate receipt under another key is ambiguous", async () => {
      const gateway = setup();
      const first = await gateway.createRefund(request());
      expect(await gateway.createRefund(request())).toEqual(first);
      const error = await gateway.createRefund(request({idempotencyKey: "order-1-other"})).catch((e: unknown) => e);
      expect(error).toMatchObject({category: "AMBIGUOUS", code: "duplicate_receipt"});
      expect(gateway.refunds()).toHaveLength(1);
    });

    it("payment lookup succeeds, or fails with each category", async () => {
      const gateway = setup();
      expect(await gateway.fetchPayment(PAYMENT)).toMatchObject({id: PAYMENT, status: "captured", captured: true});
      gateway.script("fetchPayment", "unknown_before_apply", "rate_limited", "auth_failure", {rejectWith: "BAD_REQUEST_ERROR"});
      const categories: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const error = await gateway.fetchPayment(PAYMENT).catch((e: unknown) => e);
        categories.push((error as {category: string}).category);
      }
      expect(categories).toEqual(["AMBIGUOUS", "RETRYABLE_FAILURE", "AUTH_CONFIGURATION", "DEFINITIVE_FAILURE"]);
    });

    it("an auth failure is AUTH_CONFIGURATION and applies nothing", async () => {
      const gateway = setup();
      gateway.script("createRefund", "auth_failure");
      await expect(gateway.createRefund(request())).rejects.toMatchObject({category: "AUTH_CONFIGURATION"});
      expect(gateway.refunds()).toEqual([]);
    });
  });
});

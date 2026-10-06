// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import type {Order} from "./orders";
import {
  cancelOrderBodySchema,
  toCancellationResponse,
  toRefundSummary,
  type CancelOrderResult,
} from "./orderCancellation";
import type {Refund} from "./refunds";

const CREATED = Timestamp.fromDate(new Date("2026-09-24T10:00:00Z"));
const PROCESSED = Timestamp.fromDate(new Date("2026-09-25T12:30:00Z"));

function refund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: "order1234567890-r1",
    paymentId: "order1234567890",
    orderId: "order1234567890",
    organizationId: "org-1",
    outletId: "outlet-1",
    menuId: "menu-1",
    userId: "U-customer",
    providerPaymentId: "pay_secret_123",
    amountInPaise: 25000,
    currency: "INR",
    status: "requested",
    reason: "customer_cancelled",
    source: "cancellation",
    initiatedBy: "U-customer",
    initiatedByRole: "customer",
    idempotencyKey: "order1234567890-r1",
    submitAttempts: 0,
    createdAt: CREATED,
    updatedAt: CREATED,
    attentionRequired: false,
    ...overrides,
  };
}

describe("toRefundSummary", () => {
  it("is null when the order has no refund", () => {
    expect(toRefundSummary(null)).toBeNull();
  });

  it("carries exactly status, amount, currency and initiatedAt for a refund not yet settled", () => {
    expect(toRefundSummary(refund())).toEqual({
      status: "requested", amountInPaise: 25000, currency: "INR", initiatedAt: "2026-09-24T10:00:00.000Z",
    });
  });

  it("adds completedAt only once the refund is processed", () => {
    const processed = refund({status: "processed", providerRefundId: "rfnd_secret_1", processedAt: PROCESSED});

    expect(toRefundSummary(processed)).toEqual({
      status: "processed",
      amountInPaise: 25000,
      currency: "INR",
      initiatedAt: "2026-09-24T10:00:00.000Z",
      completedAt: "2026-09-25T12:30:00.000Z",
    });
  });

  it("does not report a failed refund as completed", () => {
    const failed = refund({status: "failed", failedAt: PROCESSED, failureCode: "bank_declined", failureMessage: "declined"});

    const summary = toRefundSummary(failed);

    expect(summary?.status).toBe("failed");
    expect(summary).not.toHaveProperty("completedAt");
  });

  it("never carries a provider, payment, webhook, audit or idempotency field, whatever the refund holds", () => {
    const loaded = refund({
      status: "processed",
      providerRefundId: "rfnd_secret_1",
      providerStatus: "processed",
      processedAt: PROCESSED,
      lastWebhookEventKey: "evt_secret",
      failureCode: "x",
      failureMessage: "internal detail",
      attentionRequired: true,
    });

    const serialized = JSON.stringify(toRefundSummary(loaded));

    for (const forbidden of [
      "rfnd_secret_1", "pay_secret_123", "evt_secret", "internal detail", "idempotency", "initiatedBy", "U-customer",
      "order1234567890", "org-1", "attentionRequired", "providerRefundId", "providerPaymentId", "submitAttempts",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(JSON.parse(serialized)).sort()).toEqual(["amountInPaise", "completedAt", "currency", "initiatedAt", "status"]);
  });
});

describe("toCancellationResponse", () => {
  function result(refundSummary: CancelOrderResult["refundSummary"]): CancelOrderResult {
    return {
      order: {} as Order,
      changed: true,
      previousStatus: "confirmed",
      refund: {refundId: "internal-r1", amountInPaise: 1},
      refundSummary,
    };
  }

  it("says cancelled and not cancellable again, with no refund key when none exists", () => {
    const response = toCancellationResponse(result(null));

    expect(response).toEqual({cancellation: {state: "cancelled", canCancel: false}});
    expect(response).not.toHaveProperty("refund");
  });

  it("adds the refund summary, and not the internal created-refund detail", () => {
    const summary = toRefundSummary(refund());

    const response = toCancellationResponse(result(summary));

    expect(response).toEqual({cancellation: {state: "cancelled", canCancel: false}, refund: summary});
    expect(JSON.stringify(response)).not.toContain("internal-r1");
  });
});

describe("cancelOrderBodySchema", () => {
  it("reads only `reason`, whatever else is sent", () => {
    expect(cancelOrderBodySchema.parse({reason: "other", amountInPaise: 1, status: "confirmed", refund: {}}))
      .toEqual({reason: "other"});
    expect(cancelOrderBodySchema.parse({})).toEqual({});
  });
});

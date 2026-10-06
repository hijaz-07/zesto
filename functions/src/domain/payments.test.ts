// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {parsePayment, toPaymentResponse, type Payment} from "./payments";
import {assessPaymentRefundability, capturedAmountInPaise, readRefundAggregates} from "./refundAmounts";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
const MENU_ID = "menu-1";
const ORDER_ID = "order-1";
const USER_ID = "U-customer";

function validPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: ORDER_ID,
    orderId: ORDER_ID,
    userId: USER_ID,
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuId: MENU_ID,
    amountInPaise: 24000,
    currency: "INR",
    status: "pending",
    provider: "none",
    createdAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
    ...overrides,
  };
}

describe("parsePayment", () => {
  it("parses a well-formed document matching its path", () => {
    const payment = parsePayment(
      validPayment(), ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID,
    );
    expect(payment.id).toBe(ORDER_ID);
    expect(payment.status).toBe("pending");
  });

  it("accepts a payment with a providerPaymentId set", () => {
    const payment = parsePayment(
      validPayment({providerPaymentId: "provider-ref-1"}),
      ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID,
    );
    expect(payment.providerPaymentId).toBe("provider-ref-1");
  });

  it("accepts a payment with no providerPaymentId at all", () => {
    const payment = parsePayment(validPayment(), ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);
    expect(payment.providerPaymentId).toBeUndefined();
  });

  it("accepts a razorpay payment with a providerOrderId set", () => {
    const payment = parsePayment(
      validPayment({provider: "razorpay", providerOrderId: "order_RazorpayTest1"}),
      ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID,
    );
    expect(payment.provider).toBe("razorpay");
    expect(payment.providerOrderId).toBe("order_RazorpayTest1");
  });

  it("accepts a payment with no providerOrderId at all", () => {
    const payment = parsePayment(validPayment(), ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);
    expect(payment.providerOrderId).toBeUndefined();
  });

  it.each([
    ["id", "payment-other"],
    ["orderId", "order-other"],
    ["organizationId", "org-other"],
    ["outletId", "outlet-other"],
    ["menuId", "menu-other"],
  ])("throws when the stored %s does not match the path it was read from", (field, badValue) => {
    const payment = validPayment({[field]: badValue} as Partial<Payment>);
    expect(() => parsePayment(payment, ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });

  it("throws for a malformed document", () => {
    expect(() => parsePayment({not: "a payment"}, ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });

  it("throws for an unknown status value", () => {
    const payment = validPayment({status: "refunded"} as unknown as Partial<Payment>);
    expect(() => parsePayment(payment, ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });

  it("throws for an unknown provider value", () => {
    const payment = validPayment({provider: "stripe"} as unknown as Partial<Payment>);
    expect(() => parsePayment(payment, ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });

  it("throws for a negative amountInPaise", () => {
    const payment = validPayment({amountInPaise: -1});
    expect(() => parsePayment(payment, ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });

  it("throws for a non-INR currency", () => {
    const payment = validPayment({currency: "USD"} as unknown as Partial<Payment>);
    expect(() => parsePayment(payment, ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID)).toThrow();
  });
});

describe("toPaymentResponse", () => {
  it("maps to exactly the customer-safe fields, excluding internal Firestore path context", () => {
    const payment = validPayment();
    const response = toPaymentResponse(payment);

    expect(response).toEqual({
      paymentId: payment.id,
      orderId: payment.orderId,
      amountInPaise: payment.amountInPaise,
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
    });
    expect(response).not.toHaveProperty("userId");
    expect(response).not.toHaveProperty("organizationId");
    expect(response).not.toHaveProperty("outletId");
    expect(response).not.toHaveProperty("menuId");
    expect(response).not.toHaveProperty("providerPaymentId");
    expect(response).not.toHaveProperty("createdAt");
    expect(response).not.toHaveProperty("updatedAt");
  });

  it("reflects the current status (e.g. succeeded)", () => {
    const response = toPaymentResponse(validPayment({status: "succeeded"}));
    expect(response.status).toBe("succeeded");
  });

  it("includes providerOrderId when set", () => {
    const payment = validPayment({provider: "razorpay", providerOrderId: "order_RazorpayTest1"});
    const response = toPaymentResponse(payment);
    expect(response.provider).toBe("razorpay");
    expect(response.providerOrderId).toBe("order_RazorpayTest1");
  });

  it("omits providerOrderId when not set", () => {
    const response = toPaymentResponse(validPayment());
    expect(response).not.toHaveProperty("providerOrderId");
  });

  it("includes providerPaymentId when set (e.g. after verifyCheckoutPayment)", () => {
    const payment = validPayment({provider: "razorpay", providerPaymentId: "pay_RazorpayTest1"});
    const response = toPaymentResponse(payment);
    expect(response.providerPaymentId).toBe("pay_RazorpayTest1");
  });

  it("omits providerPaymentId when not set", () => {
    const response = toPaymentResponse(validPayment());
    expect(response).not.toHaveProperty("providerPaymentId");
  });

  it("includes providerKeyId when given one, omits it otherwise", () => {
    const payment = validPayment();
    expect(toPaymentResponse(payment, "rzp_test_public_key").providerKeyId).toBe("rzp_test_public_key");
    expect(toPaymentResponse(payment)).not.toHaveProperty("providerKeyId");
  });

  it("never exposes anything secret-shaped regardless of input", () => {
    const response = toPaymentResponse(
      validPayment({provider: "razorpay", providerOrderId: "order_RazorpayTest1"}),
      "rzp_test_public_key",
    );
    const serialized = JSON.stringify(response).toLowerCase();
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("key_secret");
  });
});

describe("parsePayment: refund aggregates (legacy compatible)", () => {
  const parse = (payment: unknown) => parsePayment(payment, ORDER_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);
  const succeeded = (overrides: Partial<Payment> = {}): Payment =>
    validPayment({provider: "razorpay", status: "succeeded", providerPaymentId: "pay_Test1", ...overrides});

  it("still parses every legacy payment, with no refund fields", () => {
    for (const status of ["pending", "failed", "succeeded"] as const) {
      const payment = validPayment({status});
      expect(parse(payment)).toEqual(payment);
    }
  });

  it("does not add refund keys to a payment that has none", () => {
    const parsed = parse(succeeded());
    for (const key of ["capturedAmountInPaise", "refundedAmountInPaise", "refundPendingInPaise", "refundSeq", "refundState"]) {
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it("parses an old succeeded payment without capturedAmountInPaise, and reads it as captured in full", () => {
    const parsed = parse(succeeded());
    expect(parsed.capturedAmountInPaise).toBeUndefined();
    expect(capturedAmountInPaise(parsed)).toBe(24000);
    expect(readRefundAggregates(parsed)).toEqual({capturedInPaise: 24000, refundedInPaise: 0, refundPendingInPaise: 0});
  });

  it("parses a succeeded payment with a captured amount", () => {
    const parsed = parse(succeeded({capturedAmountInPaise: 24000}));
    expect(parsed.capturedAmountInPaise).toBe(24000);
    expect(capturedAmountInPaise(parsed)).toBe(24000);
  });

  it("parses a payment mid-refund and a fully refunded one", () => {
    const midway = parse(succeeded({
      capturedAmountInPaise: 24000, refundedAmountInPaise: 10000, refundPendingInPaise: 14000, refundSeq: 2, refundState: "in_progress",
    }));
    expect(midway).toMatchObject({refundedAmountInPaise: 10000, refundPendingInPaise: 14000, refundSeq: 2});

    const refunded = parse(succeeded({
      capturedAmountInPaise: 24000, refundedAmountInPaise: 24000, refundPendingInPaise: 0, refundSeq: 1, refundState: "refunded",
    }));
    expect(refunded.refundState).toBe("refunded");
  });

  it("accepts every approved refundState, and rejects any other", () => {
    for (const refundState of ["none", "in_progress", "partially_refunded", "refunded", "attention_required"] as const) {
      expect(parse(succeeded({refundState})).refundState).toBe(refundState);
    }
    expect(() => parse({...succeeded(), refundState: "refund_pending"})).toThrow();
  });

  it("accepts refunded + pending exactly equal to captured, and rejects one paisa over", () => {
    expect(() => parse(succeeded({refundedAmountInPaise: 10000, refundPendingInPaise: 14000}))).not.toThrow();
    expect(() => parse(succeeded({refundedAmountInPaise: 10000, refundPendingInPaise: 14001}))).toThrow();
  });

  it("applies that rule to a legacy payment too (captured defaults to the amount)", () => {
    expect(() => parse(succeeded({refundedAmountInPaise: 24001}))).toThrow();
  });

  it("rejects a captured amount that differs from the payment amount", () => {
    expect(() => parse(succeeded({capturedAmountInPaise: 23999}))).toThrow();
    expect(() => parse(succeeded({capturedAmountInPaise: 24001}))).toThrow();
  });

  it("rejects negative, fractional and non-numeric amounts", () => {
    for (const bad of [-1, 0.5, NaN, Infinity, "100", null]) {
      for (const field of ["capturedAmountInPaise", "refundedAmountInPaise", "refundPendingInPaise", "refundSeq"]) {
        expect(() => parse({...succeeded(), [field]: bad}), `${field}=${String(bad)}`).toThrow();
      }
    }
  });

  it("rejects refund fields on a payment that did not succeed: nothing was captured", () => {
    for (const status of ["pending", "failed"] as const) {
      expect(() => parse(validPayment({status, capturedAmountInPaise: 24000}))).toThrow();
      expect(() => parse(validPayment({status, refundedAmountInPaise: 1}))).toThrow();
      expect(() => parse(validPayment({status, refundPendingInPaise: 1}))).toThrow();
      expect(() => parse(validPayment({status, refundSeq: 1}))).toThrow();
      expect(() => parse(validPayment({status, refundState: "in_progress"}))).toThrow();
    }
  });

  it("treats a failed payment with a missing provider payment ID as readable but not refundable", () => {
    const parsed = parse(validPayment({status: "failed"}));
    expect(assessPaymentRefundability(parsed)).toEqual({kind: "not_refundable", reason: "payment_not_succeeded"});
  });

  it("treats a pending payment as readable but not refundable", () => {
    expect(assessPaymentRefundability(parse(validPayment()))).toEqual({kind: "not_refundable", reason: "payment_not_succeeded"});
  });

  it("treats an old succeeded payment with no provider payment ID as readable but not refundable", () => {
    const parsed = parse(validPayment({status: "succeeded"}));
    expect(assessPaymentRefundability(parsed)).toEqual({kind: "not_refundable", reason: "missing_provider_payment_id"});
  });

  it("treats an old succeeded payment WITH a provider payment ID as refundable in full", () => {
    expect(assessPaymentRefundability(parse(succeeded()))).toMatchObject({
      kind: "refundable", providerPaymentId: "pay_Test1", remainingInPaise: 24000,
    });
  });

  it("never exposes any refund field in the customer response", () => {
    const response = toPaymentResponse(succeeded({
      capturedAmountInPaise: 24000, refundedAmountInPaise: 1000, refundPendingInPaise: 2000, refundSeq: 1, refundState: "in_progress",
    }));
    for (const key of ["capturedAmountInPaise", "refundedAmountInPaise", "refundPendingInPaise", "refundSeq", "refundState"]) {
      expect(response).not.toHaveProperty(key);
    }
  });
});

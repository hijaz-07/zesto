// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {parsePayment, toPaymentResponse, type Payment} from "./payments";

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
    const payment = validPayment({providerPaymentId: "provider-ref-1"});
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

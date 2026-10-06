// @vitest-environment node
import {createHash} from "node:crypto";
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import type {Payment} from "./payments";
import {
  checkWebhookContext,
  deriveWebhookEventIdentity,
  parseWebhookBody,
  SUPPORTED_WEBHOOK_EVENT_TYPES,
  type PaymentWebhookEvent,
} from "./razorpayWebhooks";

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

/** A realistic payment.captured payload, including the card/customer/bank
 * fields Razorpay really sends and Zesto must never read or keep. */
function capturedPayload(entity: Record<string, unknown> = {}, event = "payment.captured") {
  return {
    entity: "event",
    account_id: "acc_TestAccount",
    event,
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: "pay_Test1",
          entity: "payment",
          amount: 24000,
          currency: "INR",
          status: event === "payment.failed" ? "failed" : "captured",
          order_id: "order_Test1",
          method: "card",
          email: "customer@example.com",
          contact: "+911234567890",
          card: {last4: "5449", network: "MasterCard", name: "A Customer"},
          bank: "HDFC",
          vpa: "someone@upi",
          fee: 566,
          notes: {anything: "goes here"},
          error_description: null,
          ...entity,
        },
      },
    },
    created_at: 1567674606,
  };
}

describe("parseWebhookBody", () => {
  it("subscribes to exactly the two payment events and the three refund events — not order.paid", () => {
    expect([...SUPPORTED_WEBHOOK_EVENT_TYPES]).toEqual([
      "payment.captured", "payment.failed", "refund.created", "refund.processed", "refund.failed",
    ]);
  });

  it("extracts exactly the fields reconciliation needs from payment.captured", () => {
    const parsed = parseWebhookBody(body(capturedPayload()));

    expect(parsed).toEqual({
      kind: "payment_event",
      event: {
        type: "payment.captured",
        providerPaymentId: "pay_Test1",
        providerOrderId: "order_Test1",
        amountInPaise: 24000,
        currency: "INR",
        providerPaymentStatus: "captured",
      },
    });
  });

  it("extracts exactly the fields reconciliation needs from payment.failed", () => {
    const parsed = parseWebhookBody(body(capturedPayload({error_code: "BAD_REQUEST_ERROR"}, "payment.failed")));

    expect(parsed).toMatchObject({
      kind: "payment_event",
      event: {type: "payment.failed", providerPaymentId: "pay_Test1", providerPaymentStatus: "failed"},
    });
  });

  it("never carries card, customer, bank, UPI, fee, or notes data out of the payload", () => {
    const parsed = parseWebhookBody(body(capturedPayload()));
    const serialized = JSON.stringify(parsed);

    for (const sensitive of ["customer@example.com", "+911234567890", "5449", "MasterCard", "A Customer", "HDFC", "someone@upi", "goes here"]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(Object.keys((parsed as {event: object}).event).sort()).toEqual([
      "amountInPaise", "currency", "providerOrderId", "providerPaymentId", "providerPaymentStatus", "type",
    ]);
  });

  it("treats a payment with no order (e.g. a payment link) as an event with a null order ID, not as malformed", () => {
    expect(parseWebhookBody(body(capturedPayload({order_id: null})))).toMatchObject({
      kind: "payment_event", event: {providerOrderId: null},
    });
    const withoutOrder = capturedPayload();
    delete (withoutOrder.payload.payment.entity as Record<string, unknown>).order_id;
    expect(parseWebhookBody(body(withoutOrder))).toMatchObject({kind: "payment_event", event: {providerOrderId: null}});
  });

  it("parses the amount as integer paise and never coerces a string or fraction", () => {
    expect(parseWebhookBody(body(capturedPayload({amount: "24000"})))).toEqual({kind: "malformed"});
    expect(parseWebhookBody(body(capturedPayload({amount: 240.5})))).toEqual({kind: "malformed"});
    expect(parseWebhookBody(body(capturedPayload({amount: -1})))).toEqual({kind: "malformed"});
  });

  it.each([
    ["order.paid"], ["payment.authorized"], ["refund.speed_changed"], ["payment.dispute.created"], ["settlement.processed"],
  ])("reports %s as an unsupported event — even when it carries a payment entity", (eventType) => {
    const parsed = parseWebhookBody(body(capturedPayload({}, eventType)));

    expect(parsed).toEqual({kind: "unsupported_event", eventType});
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["not JSON", Buffer.from("nope")],
    ["truncated JSON", Buffer.from("{\"event\":\"payment.captured\"")],
    ["a JSON array", Buffer.from("[]")],
    ["a JSON string", Buffer.from("\"payment.captured\"")],
    ["null", Buffer.from("null")],
    ["no event field", body({payload: {}})],
    ["an empty event string", body({event: ""})],
    ["a numeric event", body({event: 7})],
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
  ])("reports a body that is %s as malformed, without throwing", (_label, raw) => {
    expect(() => parseWebhookBody(raw)).not.toThrow();
    expect(parseWebhookBody(raw)).toEqual({kind: "malformed"});
  });

  it.each([
    ["no payload", {event: "payment.captured"}],
    ["no payment in the payload", {event: "payment.captured", payload: {order: {}}}],
    ["no entity", {event: "payment.captured", payload: {payment: {}}}],
    ["a missing payment id", capturedPayload({id: undefined})],
    ["a missing amount", capturedPayload({amount: undefined})],
    ["a missing currency", capturedPayload({currency: undefined})],
    ["a missing status", capturedPayload({status: undefined})],
    ["an empty payment id", capturedPayload({id: ""})],
  ])("reports a supported event with %s as malformed", (_label, value) => {
    expect(parseWebhookBody(body(value))).toEqual({kind: "malformed"});
  });

  it("does not mutate state or throw on a prototype-pollution style payload", () => {
    const raw = Buffer.from("{\"event\":\"payment.captured\",\"__proto__\":{\"polluted\":true},\"payload\":{\"payment\":{\"entity\":{\"id\":\"p\",\"amount\":1,\"currency\":\"INR\",\"status\":\"captured\",\"order_id\":\"o\"}}}}");

    parseWebhookBody(raw);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("deriveWebhookEventIdentity", () => {
  const raw = Buffer.from("{\"event\":\"payment.captured\"}");
  const fingerprint = createHash("sha256").update(raw).digest("hex");

  it("uses Razorpay's documented x-razorpay-event-id as the primary key when present", () => {
    const identity = deriveWebhookEventIdentity({eventIdHeader: "Evt_Abc123", rawBody: raw});

    expect(identity).toEqual({eventKey: "evt_Evt_Abc123", keySource: "event_id_header", bodyFingerprint: fingerprint});
  });

  it("falls back to the SHA-256 fingerprint of the raw body when the header is absent", () => {
    const identity = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: raw});

    expect(identity).toEqual({eventKey: `body_${fingerprint}`, keySource: "body_fingerprint", bodyFingerprint: fingerprint});
  });

  it("is deterministic: the same delivery always yields the same identity", () => {
    const first = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: Buffer.from(raw)});
    const second = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: Buffer.from(raw)});

    expect(first).toEqual(second);
  });

  it("gives a different key to a different body (fallback mode)", () => {
    const other = deriveWebhookEventIdentity({eventIdHeader: undefined, rawBody: Buffer.from("{\"event\":\"payment.failed\"}")});

    expect(other.eventKey).not.toBe(`body_${fingerprint}`);
  });

  it("namespaces the two key sources so they can never collide", () => {
    // A header value that merely LOOKS like a fingerprint key still lands under evt_.
    const identity = deriveWebhookEventIdentity({eventIdHeader: `body_${fingerprint}`, rawBody: raw});

    expect(identity.eventKey).toBe(`evt_body_${fingerprint}`);
    expect(identity.eventKey).not.toBe(`body_${fingerprint}`);
  });

  it("always records the body fingerprint, even when keyed by the header (so a reused event ID can be detected)", () => {
    const identity = deriveWebhookEventIdentity({eventIdHeader: "evt_1", rawBody: raw});

    expect(identity.bodyFingerprint).toBe(fingerprint);
  });

  it("takes the first value if the header repeats", () => {
    expect(deriveWebhookEventIdentity({eventIdHeader: ["first", "second"], rawBody: raw}).eventKey).toBe("evt_first");
  });

  it.each([
    ["an empty header", ""],
    ["a whitespace-only header", "   "],
    ["a header with a path separator", "a/b"],
    ["a header with a control character", "a\nb"],
    ["an over-long header", "x".repeat(101)],
    ["a header with non-ASCII characters", "événement"],
  ])("falls back to the body fingerprint for %s, so a hostile value can never become a Firestore path", (_label, header) => {
    const identity = deriveWebhookEventIdentity({eventIdHeader: header, rawBody: raw});

    expect(identity.keySource).toBe("body_fingerprint");
    expect(identity.eventKey).toBe(`body_${fingerprint}`);
    expect(identity.eventKey).not.toContain("/");
  });

  it("trims surrounding whitespace from a valid header", () => {
    expect(deriveWebhookEventIdentity({eventIdHeader: "  evt_1  ", rawBody: raw}).eventKey).toBe("evt_evt_1");
  });
});

describe("checkWebhookContext", () => {
  function payment(overrides: Partial<Payment> = {}): Payment {
    return {
      id: "order-1", orderId: "order-1", userId: "U-customer",
      organizationId: "org-1", outletId: "outlet-1", menuId: "menu-1",
      amountInPaise: 24000, currency: "INR", status: "pending",
      provider: "razorpay", providerOrderId: "order_Test1",
      createdAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
      updatedAt: Timestamp.fromDate(new Date("2026-09-27T04:00:00Z")),
      ...overrides,
    };
  }

  function event(overrides: Partial<PaymentWebhookEvent> = {}): PaymentWebhookEvent {
    return {
      type: "payment.captured", providerPaymentId: "pay_Test1", providerOrderId: "order_Test1",
      amountInPaise: 24000, currency: "INR", providerPaymentStatus: "captured",
      ...overrides,
    };
  }

  it("accepts a captured event consistent with the stored payment", () => {
    expect(checkWebhookContext(payment(), event())).toBeNull();
  });

  it("accepts a failed event consistent with the stored payment", () => {
    expect(checkWebhookContext(payment(), event({type: "payment.failed", providerPaymentStatus: "failed"}))).toBeNull();
  });

  it("rejects an amount mismatch — a webhook can never confirm an order for a different amount", () => {
    expect(checkWebhookContext(payment(), event({amountInPaise: 100}))).toBe("rejected_amount_mismatch");
    expect(checkWebhookContext(payment(), event({amountInPaise: 24001}))).toBe("rejected_amount_mismatch");
    expect(checkWebhookContext(payment(), event({amountInPaise: 0}))).toBe("rejected_amount_mismatch");
  });

  it("rejects a currency mismatch", () => {
    expect(checkWebhookContext(payment(), event({currency: "USD"}))).toBe("rejected_currency_mismatch");
    expect(checkWebhookContext(payment(), event({currency: "inr"}))).toBe("rejected_currency_mismatch");
  });

  it("treats a different provider order ID as not-ours rather than a match", () => {
    expect(checkWebhookContext(payment(), event({providerOrderId: "order_Other"}))).toBe("ignored_unrecognized_payment");
    expect(checkWebhookContext(payment(), event({providerOrderId: null}))).toBe("ignored_unrecognized_payment");
  });

  it("treats a payment that isn't a Razorpay payment as not-ours", () => {
    expect(checkWebhookContext(payment({provider: "none", providerOrderId: undefined}), event()))
      .toBe("ignored_unrecognized_payment");
  });

  it("ignores an event whose type disagrees with the payment status in its own snapshot", () => {
    expect(checkWebhookContext(payment(), event({providerPaymentStatus: "authorized"}))).toBe("ignored_status_mismatch");
    expect(checkWebhookContext(payment(), event({providerPaymentStatus: "failed"}))).toBe("ignored_status_mismatch");
    expect(checkWebhookContext(payment(), event({type: "payment.failed", providerPaymentStatus: "captured"})))
      .toBe("ignored_status_mismatch");
  });

  it("validates amount and currency for failure events too", () => {
    const failed = event({type: "payment.failed", providerPaymentStatus: "failed"});

    expect(checkWebhookContext(payment(), {...failed, amountInPaise: 1})).toBe("rejected_amount_mismatch");
    expect(checkWebhookContext(payment(), {...failed, currency: "USD"})).toBe("rejected_currency_mismatch");
  });

  it("takes the stored amount from Zesto's record, never from the event", () => {
    // The event claims a bigger amount; the stored (authoritative) one wins.
    expect(checkWebhookContext(payment({amountInPaise: 6000}), event({amountInPaise: 24000})))
      .toBe("rejected_amount_mismatch");
  });
});

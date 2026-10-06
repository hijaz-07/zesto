// @vitest-environment node
import {describe, expect, it} from "vitest";
import {parseWebhookBody} from "./razorpayWebhooks";
import {parseRefundWebhookEvent} from "./refundWebhooks";

const entity = (over: Record<string, unknown> = {}) => ({
  entity: "refund", id: "rfnd_1", payment_id: "pay_1", amount: 5000, currency: "INR", status: "processed",
  receipt: "ord1-r1", notes: {zestoRefundId: "ord1-r1", zestoOrderId: "ord1", memo: "ignored"},
  acquirer_data: {rrn: "1"}, speed_processed: "normal", ...over,
});
const event = (type = "refund.processed", over: Record<string, unknown> = {}) => ({
  entity: "event", event: type, payload: {refund: {entity: entity(over)}},
});
const body = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("parseRefundWebhookEvent", () => {
  it("extracts exactly the fields reconciliation needs and nothing else", () => {
    expect(parseRefundWebhookEvent(event())).toEqual({
      type: "refund.processed", providerRefundId: "rfnd_1", providerPaymentId: "pay_1", amountInPaise: 5000,
      currency: "INR", providerStatus: "processed", receipt: "ord1-r1", zestoRefundId: "ord1-r1", zestoOrderId: "ord1",
    });
  });

  it.each(["refund.created", "refund.processed", "refund.failed"])("accepts %s", (type) => {
    expect(parseRefundWebhookEvent(event(type))).toMatchObject({type});
  });

  it("reads an empty notes ARRAY (the provider's shape for no notes) and a null receipt", () => {
    expect(parseRefundWebhookEvent(event("refund.created", {notes: [], receipt: null}))).toEqual({
      type: "refund.created", providerRefundId: "rfnd_1", providerPaymentId: "pay_1", amountInPaise: 5000,
      currency: "INR", providerStatus: "processed",
    });
  });

  it("ignores notes that are not strings", () => {
    expect(parseRefundWebhookEvent(event("refund.created", {notes: {zestoRefundId: 7}}))).not.toHaveProperty("zestoRefundId");
  });

  it.each([
    ["no refund entity", {entity: "event", event: "refund.processed", payload: {}}],
    ["a payment-only payload", {entity: "event", event: "refund.processed", payload: {payment: {entity: {id: "pay_1"}}}}],
    ["no refund id", event("refund.processed", {id: undefined})],
    ["no payment id", event("refund.processed", {payment_id: undefined})],
    ["a string amount", event("refund.processed", {amount: "5000"})],
    ["a fractional amount", event("refund.processed", {amount: 50.5})],
    ["a negative amount", event("refund.processed", {amount: -1})],
    ["no currency", event("refund.processed", {currency: undefined})],
    ["no status", event("refund.processed", {status: undefined})],
    ["an unsupported event type", event("refund.speed_changed")],
  ])("rejects %s", (_name, payload) => {
    expect(parseRefundWebhookEvent(payload)).toBeNull();
  });
});

describe("parseWebhookBody — refund events", () => {
  it("routes the three refund events to the refund parser", () => {
    expect(parseWebhookBody(body(event("refund.failed", {status: "failed"})))).toMatchObject({
      kind: "refund_event", event: {type: "refund.failed", providerStatus: "failed"},
    });
  });

  it("calls a supported refund event with a broken payload malformed, not unsupported", () => {
    expect(parseWebhookBody(body({entity: "event", event: "refund.created", payload: {}}))).toEqual({kind: "malformed"});
  });

  it("still reports other refund-related events as unsupported (acknowledged, never acted on)", () => {
    expect(parseWebhookBody(body(event("refund.speed_changed")))).toEqual({
      kind: "unsupported_event", eventType: "refund.speed_changed",
    });
  });
});

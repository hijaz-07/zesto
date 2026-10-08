// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import type {ProviderOrderPayment} from "../providers/paymentLookupGateway";
import {providerOrderPayment} from "../providers/paymentLookupGateway.fake";
import {evaluateOrderPayments, paymentLocationFromPath} from "./paymentReconciliation";
import {parsePayment} from "./payments";
import {
  FIRST_CHECK_DELAY_MS,
  RECONCILE_WINDOW_MS,
  inconclusiveBackoffMs,
  initialReconciliation,
  nextCheckDelayMs,
  paymentReconciliationSchema,
  reconciliationWindowEnd,
} from "./paymentReconciliationState";

const ORDER = "order_Mine";
const PAYMENT = {providerOrderId: ORDER, amountInPaise: 10000, currency: "INR"} as const;
const mine = (fields: Partial<ProviderOrderPayment>): ProviderOrderPayment =>
  providerOrderPayment({id: "pay_1", providerOrderId: ORDER, ...fields});

describe("evaluateOrderPayments — the matching rules", () => {
  it("one captured payment of this order, same amount and currency, is adopted", () => {
    expect(evaluateOrderPayments(PAYMENT, [mine({})]).evaluation).toEqual({
      kind: "captured", providerPaymentId: "pay_1", amountInPaise: 10000, currency: "INR",
    });
  });

  it("an empty listing means nobody has paid yet", () => {
    expect(evaluateOrderPayments(PAYMENT, []).evaluation).toEqual({kind: "open", state: "no_payments"});
  });

  it("amount alone never matches: a captured payment of another order is ignored and reported", () => {
    const verdict = evaluateOrderPayments(PAYMENT, [mine({id: "pay_x", providerOrderId: "order_Other"})]);
    expect(verdict.evaluation).toEqual({kind: "open", state: "no_payments"});
    expect(verdict.foreignPaymentIds).toEqual(["pay_x"]);
  });

  it("an item with no order at all is treated as another order's, never this one's", () => {
    const verdict = evaluateOrderPayments(PAYMENT, [mine({id: "pay_y", providerOrderId: null})]);
    expect(verdict.evaluation.kind).toBe("open");
    expect(verdict.foreignPaymentIds).toEqual(["pay_y"]);
  });

  it.each([
    ["authorized", "authorized", false],
    ["created", "created", false],
  ] as const)("an %s payment is not paid", (status, state, captured) => {
    expect(evaluateOrderPayments(PAYMENT, [mine({status, captured})]).evaluation).toEqual({kind: "open", state});
  });

  it("authorized outranks created, and a capture outranks everything", () => {
    const listed = [
      mine({id: "pay_f", status: "failed", captured: false}),
      mine({id: "pay_c", status: "created", captured: false}),
      mine({id: "pay_a", status: "authorized", captured: false}),
    ];
    expect(evaluateOrderPayments(PAYMENT, listed).evaluation).toEqual({kind: "open", state: "authorized"});
    expect(evaluateOrderPayments(PAYMENT, [...listed, mine({id: "pay_k"})]).evaluation).toMatchObject({kind: "captured", providerPaymentId: "pay_k"});
  });

  it("only failed attempts: the newest by creation time is the one recorded", () => {
    const listed = [
      mine({id: "pay_old", status: "failed", captured: false, createdAtEpochSeconds: 100}),
      mine({id: "pay_new", status: "failed", captured: false, createdAtEpochSeconds: 300}),
      mine({id: "pay_mid", status: "failed", captured: false, createdAtEpochSeconds: 200}),
    ];
    expect(evaluateOrderPayments(PAYMENT, listed).evaluation).toEqual({kind: "failed", providerPaymentId: "pay_new"});
  });

  it.each([
    ["a different amount", {amountInPaise: 10001}, "captured_amount_mismatch"],
    ["a smaller amount", {amountInPaise: 9999}, "captured_amount_mismatch"],
    ["a different currency", {currency: "USD"}, "captured_amount_mismatch"],
    ["an external refund", {amountRefundedInPaise: 1}, "captured_with_external_refund"],
  ] as const)("a captured payment with %s is an anomaly, never adopted", (_name, overrides, code) => {
    expect(evaluateOrderPayments(PAYMENT, [mine(overrides)]).evaluation).toMatchObject({kind: "anomaly", code});
  });

  it("two captured payments, or a refunded one, are anomalies with a stable discriminator", () => {
    const two = evaluateOrderPayments(PAYMENT, [mine({id: "pay_b"}), mine({id: "pay_a"})]).evaluation;
    expect(two).toEqual({kind: "anomaly", code: "multiple_captured_payments", discriminator: "pay_a,pay_b"});
    const refunded = evaluateOrderPayments(PAYMENT, [mine({status: "refunded", amountRefundedInPaise: 10000})]).evaluation;
    expect(refunded).toMatchObject({kind: "anomaly", code: "captured_then_refunded"});
  });

  it.each([
    ["captured status with captured=false", [mine({status: "captured", captured: false})]],
    ["authorized with captured=true", [mine({status: "authorized", captured: true})]],
    ["failed with captured=true", [mine({status: "failed", captured: true})]],
    ["the same payment twice", [mine({id: "pay_d"}), mine({id: "pay_d"})]],
  ])("a self-contradicting listing (%s) is unusable, never acted on", (_name, listed) => {
    expect(evaluateOrderPayments(PAYMENT, listed).evaluation).toEqual({kind: "unusable"});
  });

  it("a contradiction in ANOTHER order's payment does not make this order's answer unusable", () => {
    const listed = [mine({id: "pay_z", providerOrderId: "order_Other", status: "authorized", captured: true}), mine({id: "pay_ok"})];
    expect(evaluateOrderPayments(PAYMENT, listed).evaluation).toMatchObject({kind: "captured", providerPaymentId: "pay_ok"});
  });
});

describe("paymentLocationFromPath", () => {
  const ok = "organizations/o1/outlets/ou1/menus/m1/orders/ord1/payments/ord1";

  it("accepts exactly an order's payment, whose ID is its order's", () => {
    expect(paymentLocationFromPath(ok)).toEqual({organizationId: "o1", outletId: "ou1", menuId: "m1", orderId: "ord1", paymentId: "ord1"});
  });

  it.each([
    ["a payment ID that is not its order's", "organizations/o1/outlets/ou1/menus/m1/orders/ord1/payments/other"],
    ["a refund path", `${ok}/refunds/ord1-r1`],
    ["a short path", "organizations/o1/payments/ord1"],
    ["a wrong collection", "organizations/o1/outlets/ou1/menus/m1/orders/ord1/items/ord1"],
    ["an empty segment", "organizations/o1/outlets//menus/m1/orders/ord1/payments/ord1"],
    ["a path-traversal segment", "organizations/o1/outlets/../menus/m1/orders/ord1/payments/ord1"],
  ])("rejects %s", (_name, path) => {
    expect(paymentLocationFromPath(path)).toBeNull();
  });
});

describe("the reconciliation schedule", () => {
  it("starts due 15 minutes after the provider order is attached, with nothing attempted", () => {
    const now = Timestamp.fromMillis(1_000_000);
    const initial = initialReconciliation(now);
    expect(initial.nextAttemptAt?.toMillis()).toBe(1_000_000 + FIRST_CHECK_DELAY_MS);
    expect(initial).toMatchObject({attempts: 0, inconclusiveStreak: 0});
    expect(() => paymentReconciliationSchema.parse(initial)).not.toThrow();
  });

  it("widens 15m, 30m, 1h, 2h, 4h, 8h and then holds at 12h — no hot loop", () => {
    const hours = [1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => nextCheckDelayMs(n) / 3_600_000);
    expect(hours).toEqual([0.25, 0.5, 1, 2, 4, 8, 12, 12, 12]);
    expect(nextCheckDelayMs(0)).toBe(nextCheckDelayMs(1));
  });

  it("backs off after an inconclusive lookup 2m, 4m, ... capped at one hour", () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 40].map((n) => inconclusiveBackoffMs(n) / 60_000);
    expect(minutes).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("the window is seven days from the payment's creation", () => {
    const created = Timestamp.fromMillis(5_000);
    expect(reconciliationWindowEnd(created).toMillis()).toBe(5_000 + RECONCILE_WINDOW_MS);
    expect(RECONCILE_WINDOW_MS).toBe(7 * 24 * 3_600_000);
  });

  it("rejects a malformed stored map instead of trusting it", () => {
    expect(paymentReconciliationSchema.safeParse({attempts: -1, inconclusiveStreak: 0}).success).toBe(false);
    expect(paymentReconciliationSchema.safeParse({attempts: 0, inconclusiveStreak: 0, nextAttemptAt: "soon"}).success).toBe(false);
    expect(paymentReconciliationSchema.safeParse({attempts: 0, inconclusiveStreak: 0, resolution: "paid"}).success).toBe(false);
  });
});

describe("a damaged reconciliation map never makes the payment unreadable", () => {
  const stored = (extra: Record<string, unknown>) => ({
    id: "ord1", orderId: "ord1", userId: "U-1", organizationId: "o1", outletId: "ou1", menuId: "m1",
    amountInPaise: 10000, currency: "INR", status: "pending", provider: "razorpay", providerOrderId: ORDER,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1), ...extra,
  });
  const parse = (data: unknown) => parsePayment(data, "ord1", "ord1", "o1", "ou1", "m1");

  it("a payment with no map parses (legacy payments)", () => {
    expect(parse(stored({})).reconciliation).toBeUndefined();
  });

  it("a valid map is kept", () => {
    const map = initialReconciliation(Timestamp.fromMillis(1_000));
    expect(parse(stored({reconciliation: map})).reconciliation).toEqual(map);
  });

  it.each([
    ["a string", "oops"],
    ["a number", 7],
    ["null", null],
    ["an array", []],
    ["a map with a bad field", {attempts: "many", inconclusiveStreak: 0}],
    ["a map with an unknown resolution", {attempts: 0, inconclusiveStreak: 0, resolution: "paid"}],
  ])("%s degrades to no bookkeeping instead of failing the payment", (_name, value) => {
    const payment = parse(stored({reconciliation: value}));
    expect(payment.reconciliation).toBeUndefined();
    expect(payment).toMatchObject({status: "pending", amountInPaise: 10000, providerOrderId: ORDER});
  });
});

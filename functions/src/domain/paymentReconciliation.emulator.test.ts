// @vitest-environment node
import {createHmac, randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {
  createFakePaymentLookupGateway,
  providerOrderPayment,
  type FakePaymentLookupGateway,
} from "../providers/paymentLookupGateway.fake";
import {createRazorpayPaymentLookupGateway} from "../providers/razorpayPayments";
import type {FetchLike} from "../providers/razorpayRefunds";
import {NOTIFICATION_EVENTS_COLLECTION} from "./notificationEvents";
import {
  RECONCILE_WINDOW_MS,
  inconclusiveBackoffMs,
  nextCheckDelayMs,
} from "./paymentReconciliationState";
import {reconcileDuePayments, reconcilePayment} from "./paymentReconciliation";
import {
  AFTER_FIRST_CHECK,
  AMOUNT,
  T0,
  capturedFor,
  cleanupPaymentScenarios,
  expectPaymentConsistency,
  loadPaymentState,
  seedUnresolvedPayment,
  type PaymentScenario,
} from "./paymentReconciliation.fake";
import {markPaymentFailed, markPaymentSucceeded, verifyCheckoutPayment} from "./payments";
import {receiveRazorpayWebhook} from "./razorpayWebhooks";

/**
 * Payment reconciliation against a Firestore emulator and the fake provider lookup. The
 * lookup is read-only, so every assertion is about what Zesto's own documents become — and
 * that the provider is asked only about genuinely unresolved payments.
 */

const PROJECT_ID = "demo-zesto-payment-reconciliation";
let db: Firestore;

vi.setConfig({testTimeout: 30000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

beforeEach(() => {
  vi.stubEnv("RAZORPAY_KEY_SECRET", "test_key_secret_for_reconciliation");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPaymentScenarios(db);
  const events = await db.collection(NOTIFICATION_EVENTS_COLLECTION).get();
  await Promise.all(events.docs.map((doc) => doc.ref.delete()));
});

/** A clock whose reading can be moved by hand. */
function clockAt(start: Timestamp = AFTER_FIRST_CHECK): {now: () => Timestamp; set: (to: Timestamp) => void; advance: (ms: number) => void} {
  let ms = start.toMillis();
  return {
    now: () => Timestamp.fromMillis(ms),
    set: (to) => {
      ms = to.toMillis();
    },
    advance: (by) => {
      ms += by;
    },
  };
}

function gatewayFor(...scenarios: PaymentScenario[]): FakePaymentLookupGateway {
  const gateway = createFakePaymentLookupGateway();
  for (const s of scenarios) {
    gateway.setPayments(s.providerOrderId, []);
  }
  return gateway;
}

async function confirmedEvents(s: PaymentScenario): Promise<string[]> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", s.orderId).get();
  return snapshot.docs.map((doc) => doc.id);
}

const payId = (): string => `pay_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

function webhookBody(s: PaymentScenario, id: string, event: "payment.captured" | "payment.failed", status: string): Buffer {
  return Buffer.from(JSON.stringify({
    entity: "event", event,
    payload: {payment: {entity: {id, order_id: s.providerOrderId, amount: s.amount, currency: "INR", status}}},
  }));
}

describe("a capture Zesto never heard about", () => {
  it("captured but the webhook was missed: the order is confirmed, once, and leaves the sweep", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "recovered", providerPaymentId: captured.id, lateCapture: false});
    const state = await expectPaymentConsistency(s);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: captured.id, capturedAmountInPaise: AMOUNT});
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
    expect(state.reconciliation).toMatchObject({resolution: "captured_recovered", lastProviderState: "captured"});
    expect(state.audit.filter((id) => id.startsWith("recovered_"))).toHaveLength(1);
    expect(await confirmedEvents(s)).toEqual([`${s.orderId}_order_confirmed`]);
  });

  it("captured but Checkout verification never arrived: a later verify with the same payment is an idempotent replay, a different one conflicts", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);
    await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    const sign = (id: string): string => createHmac("sha256", "test_key_secret_for_reconciliation")
      .update(`${s.providerOrderId}|${id}`).digest("hex");
    const replay = await verifyCheckoutPayment(db, s.userId, s.orderId, {
      razorpayPaymentId: captured.id, razorpayOrderId: s.providerOrderId, razorpaySignature: sign(captured.id),
    });
    expect(replay.payment).toMatchObject({status: "succeeded", providerPaymentId: captured.id});

    const other = payId();
    await expect(verifyCheckoutPayment(db, s.userId, s.orderId, {
      razorpayPaymentId: other, razorpayOrderId: s.providerOrderId, razorpaySignature: sign(other),
    })).rejects.toMatchObject({code: "already-exists"});
    await expectPaymentConsistency(s);
    expect(await confirmedEvents(s)).toHaveLength(1);
  });

  it("recovery then a replayed webhook for the same payment changes nothing", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);
    await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    const outcome = await receiveRazorpayWebhook(db, {
      rawBody: webhookBody(s, captured.id, "payment.captured", "captured"), eventIdHeader: "evt_late_replay",
    });

    expect(outcome).toMatchObject({kind: "processed", outcome: "success_noop_already_succeeded"});
    await expectPaymentConsistency(s);
    expect(await confirmedEvents(s)).toHaveLength(1);
  });

  it("the webhook landing first leaves nothing to reconcile: the provider is never asked", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const id = payId();
    expect(await receiveRazorpayWebhook(db, {
      rawBody: webhookBody(s, id, "payment.captured", "captured"), eventIdHeader: "evt_first",
    })).toMatchObject({outcome: "payment_succeeded"});

    const summary = await reconcileDuePayments(db, gateway, {now: clock.now});

    expect(summary.examined).toBe(0);
    expect(gateway.calls).toEqual([]);
    expect((await loadPaymentState(s)).reconciliation.nextAttemptAt).toBeUndefined();
  });

  it("an order cancelled meanwhile is a late capture: it stays cancelled, is marked paid, and one full refund is reserved", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db, {orderStatus: "cancelled"});
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "recovered", providerPaymentId: captured.id, lateCapture: true});
    const state = await expectPaymentConsistency(s);
    expect(state.order).toMatchObject({status: "cancelled", paymentStatus: "paid"});
    expect(Object.values(state.refunds)[0]).toMatchObject({status: "requested", amountInPaise: AMOUNT});
    // A cancelled order is never confirmed: no order_confirmed event, only the refund's.
    expect((await confirmedEvents(s)).some((id) => id.endsWith("_order_confirmed"))).toBe(false);
  });
});

describe("what the provider shows when nothing is captured", () => {
  it("every attempt failed: the payment is marked failed, the order stays payable, and watching continues", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const failed = providerOrderPayment({id: payId(), providerOrderId: s.providerOrderId, status: "failed", captured: false});
    gateway.setPayments(s.providerOrderId, [failed]);

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "pending", state: "failed", failedRecorded: true});
    const state = await expectPaymentConsistency(s);
    expect(state.payment).toMatchObject({status: "failed", providerPaymentId: failed.id});
    expect(state.order).toMatchObject({status: "pending_payment", paymentStatus: "pending"});
    expect((state.reconciliation.nextAttemptAt as Timestamp).toMillis()).toBe(clock.now().toMillis() + nextCheckDelayMs(1));

    // The customer retries against the same provider order and that attempt is captured, unseen.
    const retry = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [failed, retry]);
    clock.advance(nextCheckDelayMs(1) + 1000);
    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now}))
      .toEqual({kind: "recovered", providerPaymentId: retry.id, lateCapture: false});
    expect((await expectPaymentConsistency(s)).payment).toMatchObject({status: "succeeded", providerPaymentId: retry.id});
  });

  it("failed but the webhook was missed, with the payment already failed: nothing is rewritten", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db, {paymentStatus: "failed", payment: {providerPaymentId: "pay_old_failed"}});
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [
      providerOrderPayment({id: "pay_old_failed", providerOrderId: s.providerOrderId, status: "failed", captured: false}),
    ]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "pending", state: "failed", failedRecorded: false});

    expect((await expectPaymentConsistency(s)).payment).toMatchObject({status: "failed", providerPaymentId: "pay_old_failed"});
  });

  it.each([
    ["created", providerOrderPayment({id: "pay_created", providerOrderId: "X", status: "created", captured: false})],
    ["authorized", providerOrderPayment({id: "pay_auth", providerOrderId: "X", status: "authorized", captured: false})],
  ] as const)("a %s payment is NOT paid: nothing changes and the next look is scheduled", async (state, template) => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [{...template, providerOrderId: s.providerOrderId}]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "pending", state, failedRecorded: false});

    const after = await expectPaymentConsistency(s);
    expect(after.payment).toMatchObject({status: "pending"});
    expect(after.reconciliation).toMatchObject({lastProviderState: state, attempts: 1, inconclusiveStreak: 0});
    expect(after.reconciliation.leaseExpiresAt).toBeUndefined();
  });

  it("no payment at all (nobody paid): the check widens 15m, 30m, 1h, ... and never confirms", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});
      expect(result).toEqual({kind: "pending", state: "no_payments", failedRecorded: false});
      const next = (await loadPaymentState(s)).reconciliation.nextAttemptAt as Timestamp;
      gaps.push(next.toMillis() - clock.now().toMillis());
      clock.set(next);
    }
    expect(gaps).toEqual([15, 30, 60, 120].map((m) => m * 60 * 1000));
    await expectPaymentConsistency(s);
  });
});

describe("a lookup that proves nothing", () => {
  it.each([
    ["timeout", "timeout", "provider_unavailable"],
    ["unknown outcome", "unknown", "provider_unavailable"],
    ["rate limited", "rate_limited", "provider_unavailable"],
    ["server error", "server_error", "provider_unavailable"],
    ["unexpected local error", "plain_error", "unexpected_error"],
  ] as const)("%s: status and order are untouched, the lease is released, a retry is scheduled", async (_name, fault, reason) => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s)]);
    gateway.script(fault);

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "deferred", reason, streak: 1});
    const state = await expectPaymentConsistency(s);
    expect(state.payment.status).toBe("pending");
    expect(state.reconciliation.leaseExpiresAt).toBeUndefined();
    expect((state.reconciliation.nextAttemptAt as Timestamp).toMillis()).toBe(clock.now().toMillis() + inconclusiveBackoffMs(1));
  });

  it("retries with growing backoff, is not selected before it is due, and recovers when the provider answers", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);
    gateway.script("timeout", "timeout");

    await reconcilePayment(db, gateway, s.loc, {now: clock.now});
    clock.advance(60 * 1000);
    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "not_due"});
    expect((await reconcileDuePayments(db, gateway, {now: clock.now})).examined).toBe(0);
    expect(gateway.calls).toHaveLength(1);

    clock.advance(2 * 60 * 1000);
    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toMatchObject({kind: "deferred", streak: 2});
    expect((await loadPaymentState(s)).reconciliation).toMatchObject({inconclusiveStreak: 2});
    clock.advance(5 * 60 * 1000);
    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toMatchObject({kind: "recovered"});
    expect((await expectPaymentConsistency(s)).payment.status).toBe("succeeded");
    expect(gateway.calls).toHaveLength(3);
  });

  it("rejected credentials are an operator problem: quiet 15-minute retry, not counted as a failed lookup streak", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.script("auth_failure");

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now}))
      .toEqual({kind: "deferred", reason: "provider_configuration", streak: 0});

    const state = await expectPaymentConsistency(s);
    expect((state.reconciliation.nextAttemptAt as Timestamp).toMillis()).toBe(clock.now().toMillis() + 15 * 60 * 1000);
  });

  it.each([
    ["a payment whose status and captured flag disagree", [providerOrderPayment({id: "pay_x", providerOrderId: "X", status: "authorized", captured: true})]],
    ["the same payment listed twice", [
      providerOrderPayment({id: "pay_dup", providerOrderId: "X"}), providerOrderPayment({id: "pay_dup", providerOrderId: "X"}),
    ]],
    ["a captured status with captured=false", [providerOrderPayment({id: "pay_y", providerOrderId: "X", status: "captured", captured: false})]],
  ] as const)("an unusable listing (%s) is never adopted: deferred, nothing changes", async (_name, template) => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, template.map((p) => ({...p, providerOrderId: s.providerOrderId})));

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toMatchObject({kind: "deferred", reason: "unusable_answer"});

    expect((await expectPaymentConsistency(s)).payment.status).toBe("pending");
  });

  it("keeps failing: still never marks failed or confirmed, logs at error from the 8th straight failure", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db, {reconciliation: {inconclusiveStreak: 7}});
    const gateway = gatewayFor(s);
    gateway.script("server_error");

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toMatchObject({kind: "deferred", streak: 8});

    const state = await expectPaymentConsistency(s);
    expect(state.reconciliation.attentionRequired).toBeUndefined();
    expect((state.reconciliation.nextAttemptAt as Timestamp).toMillis()).toBe(clock.now().toMillis() + 60 * 60 * 1000);
  });
});

describe("matching: only the payment's own provider order, never the amount alone", () => {
  it("a captured payment of ANOTHER provider order with the same amount is ignored and recorded, never adopted", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const stranger = capturedFor(s, {providerOrderId: "order_someone_else"});
    gateway.setPayments(s.providerOrderId, [stranger]);

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "pending", state: "no_payments", failedRecorded: false});
    const state = await expectPaymentConsistency(s);
    expect(state.payment.status).toBe("pending");
    expect(state.payment.providerPaymentId).toBeUndefined();
    expect(state.audit.some((id) => id.startsWith("ignored_foreign_provider_payments_"))).toBe(true);
  });

  it("a foreign payment beside the real one does not stop the real one being adopted, and is never the one adopted", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const stranger = capturedFor(s, {providerOrderId: "order_someone_else"});
    const real = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [stranger, real]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toMatchObject({kind: "recovered", providerPaymentId: real.id});

    expect((await expectPaymentConsistency(s)).payment.providerPaymentId).toBe(real.id);
  });

  it.each([
    ["a different amount", {amountInPaise: AMOUNT + 100}, "captured_amount_mismatch"],
    ["a different currency", {currency: "USD"}, "captured_amount_mismatch"],
    ["money already refunded outside Zesto", {amountRefundedInPaise: 500}, "captured_with_external_refund"],
  ] as const)("a captured payment with %s is flagged, never confirmed, and the sweep stops", async (_name, overrides, code) => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s, overrides)]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "flagged", code});

    const state = await expectPaymentConsistency(s);
    expect(state.payment.status).toBe("pending");
    expect(state.reconciliation).toMatchObject({attentionRequired: true, attentionCode: code});
    expect(state.reconciliation.nextAttemptAt).toBeUndefined();
    expect(state.audit.filter((id) => id.startsWith(`anomaly_${code}_`))).toHaveLength(1);
    // Flagged payments leave the sweep and are never asked about again.
    clock.advance(24 * 3600 * 1000);
    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "attention_required"});
    expect((await reconcileDuePayments(db, gateway, {now: clock.now})).examined).toBe(0);
  });

  it("two captured payments for one order are a conflict: neither is adopted", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s), capturedFor(s)]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "flagged", code: "multiple_captured_payments"});

    expect((await expectPaymentConsistency(s)).payment.status).toBe("pending");
  });

  it("a payment the provider shows as captured-then-refunded is flagged, not confirmed", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s, {status: "refunded", amountRefundedInPaise: AMOUNT})]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "flagged", code: "captured_then_refunded"});

    expect((await expectPaymentConsistency(s)).payment.status).toBe("pending");
  });

  it("a provider payment ID already attached to a different Zesto payment is never adopted a second time", async () => {
    const clock = clockAt();
    const owner = await seedUnresolvedPayment(db, {paymentStatus: "failed"});
    const s = await seedUnresolvedPayment(db);
    const taken = payId();
    await owner.paymentRef.update({providerPaymentId: taken});
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s, {id: taken})]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now}))
      .toEqual({kind: "flagged", code: "provider_payment_claimed_elsewhere"});

    expect((await expectPaymentConsistency(s)).payment.status).toBe("pending");
    expect((await loadPaymentState(owner)).payment.providerPaymentId).toBe(taken);
  });

  it("a payment that succeeded with one provider payment while the lookup ran is never overwritten by a different capture", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const winner = payId();
    const intruder = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [intruder]);
    gateway.script({
      beforeAnswer: async () => {
        await markPaymentSucceeded(db, {
          orderId: s.orderId, paymentId: s.orderId, amountInPaise: AMOUNT, currency: "INR", providerPaymentId: winner,
        });
      },
    });

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "flagged", code: "conflicting_captured_payment"});
    const state = await expectPaymentConsistency(s);
    expect(state.payment.providerPaymentId).toBe(winner);
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
    expect(await confirmedEvents(s)).toHaveLength(1);
  });

  it("the same provider payment arriving by two routes is recognised, not reported as a conflict", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);
    gateway.script({
      beforeAnswer: async () => {
        await markPaymentSucceeded(db, {
          orderId: s.orderId, paymentId: s.orderId, amountInPaise: AMOUNT, currency: "INR", providerPaymentId: captured.id,
        });
      },
    });

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "already_resolved"});

    const state = await expectPaymentConsistency(s);
    expect(state.reconciliation).toMatchObject({resolution: "already_succeeded"});
    expect(state.audit).toEqual([]);
    expect(await confirmedEvents(s)).toHaveLength(1);
  });
});

describe("genuinely unresolved payments only", () => {
  it("an already-succeeded payment is taken out of the sweep without a provider call", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db, {
      payment: {status: "succeeded", providerPaymentId: payId()}, order: {status: "confirmed", paymentStatus: "paid"},
    });
    const gateway = gatewayFor(s);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "already_resolved"});

    expect(gateway.calls).toEqual([]);
    expect((await loadPaymentState(s)).reconciliation).toMatchObject({resolution: "already_succeeded"});
    expect((await loadPaymentState(s)).reconciliation.nextAttemptAt).toBeUndefined();
  });

  it("a payment with no provider order was never payable: out of the sweep, no provider call", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db, {payment: {provider: "none"}});
    const gateway = gatewayFor(s);
    await s.paymentRef.update({providerOrderId: FieldValue.delete()});

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "not_reconcilable"});

    expect(gateway.calls).toEqual([]);
  });

  it("the sweep never reads payments that carry no schedule (legacy payments, resolved ones)", async () => {
    const clock = clockAt();
    const legacy = await seedUnresolvedPayment(db, {reconciliation: null});
    const gateway = gatewayFor(legacy);
    gateway.setPayments(legacy.providerOrderId, [capturedFor(legacy)]);

    const summary = await reconcileDuePayments(db, gateway, {now: clock.now});

    expect(summary.examined).toBe(0);
    expect(gateway.calls).toEqual([]);
    expect((await loadPaymentState(legacy)).payment.status).toBe("pending");
    // A deliberate, direct call still works on it and starts a proper schedule.
    expect(await reconcilePayment(db, gateway, legacy.loc, {now: clock.now})).toMatchObject({kind: "recovered"});
  });

  it("inconsistent documents are parked and flagged so they cannot crowd the sweep", async () => {
    const clock = clockAt();
    const confirmedOrder = await seedUnresolvedPayment(db, {orderStatus: "confirmed"});
    const wrongUser = await seedUnresolvedPayment(db, {payment: {userId: "U-someone-else"}});
    const wrongAmount = await seedUnresolvedPayment(db, {payment: {amountInPaise: AMOUNT + 1}});
    const gateway = gatewayFor(confirmedOrder, wrongUser, wrongAmount);

    for (const s of [confirmedOrder, wrongUser, wrongAmount]) {
      expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "flagged", code: "inconsistent_documents"});
      const state = await loadPaymentState(s);
      expect(state.reconciliation).toMatchObject({attentionRequired: true, attentionCode: "inconsistent_documents"});
      expect(state.reconciliation.nextAttemptAt).toBeUndefined();
    }
    expect(gateway.calls).toEqual([]);
  });

  it("a malformed payment document is flagged, not acted on", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db, {payment: {amountInPaise: "ten rupees"}});
    const gateway = gatewayFor(s);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "malformed"});

    expect(gateway.calls).toEqual([]);
    expect((await loadPaymentState(s)).reconciliation).toMatchObject({attentionRequired: true});
  });

  it("a payment that does not exist is simply not found", async () => {
    const s = await seedUnresolvedPayment(db);
    await s.paymentRef.delete();
    expect(await reconcilePayment(db, gatewayFor(s), s.loc, {now: clockAt().now})).toEqual({kind: "not_found"});
  });
});

describe("duplicate and concurrent reconciliation", () => {
  it("running it again after recovery changes nothing and asks the provider nothing", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s)]);
    await reconcilePayment(db, gateway, s.loc, {now: clock.now});
    const before = await loadPaymentState(s);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "already_resolved"});
    expect((await reconcileDuePayments(db, gateway, {now: clock.now})).examined).toBe(0);

    expect(gateway.calls).toHaveLength(1);
    const after = await expectPaymentConsistency(s);
    expect(after.payment).toEqual(before.payment);
    expect(after.order).toEqual(before.order);
    expect(await confirmedEvents(s)).toHaveLength(1);
  });

  it("concurrent reconcilers: one takes the lease and asks the provider, the rest back off; one confirmation", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s)]);

    const results = await Promise.all([1, 2, 3, 4].map(() => reconcilePayment(db, gateway, s.loc, {now: clock.now})));

    const kinds = results.map((r) => r.kind).sort();
    expect(kinds.filter((k) => k === "recovered")).toHaveLength(1);
    expect(kinds.every((k) => ["recovered", "leased", "already_resolved"].includes(k))).toBe(true);
    expect(gateway.calls.length).toBeLessThanOrEqual(1);
    await expectPaymentConsistency(s);
    expect(await confirmedEvents(s)).toHaveLength(1);
  });

  it("two overlapping sweeps recover a payment once", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s)]);

    const [a, b] = await Promise.all([
      reconcileDuePayments(db, gateway, {now: clock.now}), reconcileDuePayments(db, gateway, {now: clock.now}),
    ]);

    expect((a.results.recovered ?? 0) + (b.results.recovered ?? 0)).toBe(1);
    expect(gateway.calls).toHaveLength(1);
    await expectPaymentConsistency(s);
    expect(await confirmedEvents(s)).toHaveLength(1);
  });

  it("a worker that died holding the lease is replaced once the lease lapses, never before", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s)]);
    // A hard crash leaves a lease behind; simulate it by leasing by hand.
    await s.paymentRef.update({
      "reconciliation.leaseExpiresAt": Timestamp.fromMillis(clock.now().toMillis() + 2 * 60 * 1000),
      "reconciliation.nextAttemptAt": Timestamp.fromMillis(clock.now().toMillis() + 2 * 60 * 1000),
    });

    clock.advance(60 * 1000);
    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "leased"});
    clock.advance(2 * 60 * 1000);
    expect((await reconcileDuePayments(db, gateway, {now: clock.now})).examined).toBe(1);
  });

  it("a recovery racing a webhook for the same payment ends with one confirmation and consistent accounting", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);

    await Promise.all([
      reconcilePayment(db, gateway, s.loc, {now: clock.now}),
      receiveRazorpayWebhook(db, {rawBody: webhookBody(s, captured.id, "payment.captured", "captured"), eventIdHeader: "evt_race"}),
    ]);

    const state = await expectPaymentConsistency(s);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: captured.id});
    expect(await confirmedEvents(s)).toEqual([`${s.orderId}_order_confirmed`]);
  });

  it("a payment failure racing a recovery never moves a succeeded payment backward", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    const captured = capturedFor(s);
    gateway.setPayments(s.providerOrderId, [captured]);

    await Promise.all([
      reconcilePayment(db, gateway, s.loc, {now: clock.now}),
      markPaymentFailed(db, {orderId: s.orderId, paymentId: s.orderId, providerPaymentId: payId()}),
    ]);

    // Whichever commits first, the capture ends the payment as succeeded (failed -> succeeded is
    // allowed) and a failure never undoes a success.
    const state = await expectPaymentConsistency(s);
    expect(state.payment).toMatchObject({status: "succeeded", providerPaymentId: captured.id});
  });
});

describe("the sweep's bounds", () => {
  it("takes the oldest due payments first, at most `limit`, and leaves the rest", async () => {
    const clock = clockAt();
    const mk = (minutes: number) => seedUnresolvedPayment(db, {
      reconciliation: {nextAttemptAt: Timestamp.fromMillis(T0.toMillis() + minutes * 60 * 1000)},
    });
    const newest = await mk(12);
    const oldest = await mk(2);
    const middle = await mk(7);
    const notDue = await mk(60 * 24);
    const gateway = gatewayFor(newest, oldest, middle, notDue);

    const summary = await reconcileDuePayments(db, gateway, {now: clock.now, limit: 2});

    expect(summary.examined).toBe(2);
    expect(gateway.calls).toEqual([oldest.providerOrderId, middle.providerOrderId]);
    expect((await loadPaymentState(newest)).reconciliation.attempts).toBe(0);
    expect((await loadPaymentState(notDue)).reconciliation.attempts).toBe(0);
  });

  it("one payment's unexpected failure never stops the rest, and each tenant's payment touches only its own documents", async () => {
    const clock = clockAt();
    const a = await seedUnresolvedPayment(db, {amount: 10000});
    const b = await seedUnresolvedPayment(db, {amount: 25000});
    const gateway = gatewayFor(a, b);
    gateway.setPayments(a.providerOrderId, [capturedFor(a)]);
    gateway.setPayments(b.providerOrderId, [capturedFor(b)]);
    gateway.script("plain_error");

    const summary = await reconcileDuePayments(db, gateway, {now: clock.now});

    expect(summary.examined).toBe(2);
    expect(summary.results.recovered).toBe(1);
    expect(summary.results.deferred).toBe(1);
    const [stateA, stateB] = [await loadPaymentState(a), await loadPaymentState(b)];
    const recovered = [stateA, stateB].filter((st) => st.payment.status === "succeeded");
    expect(recovered).toHaveLength(1);
    for (const [s, st] of [[a, stateA], [b, stateB]] as const) {
      if (st.payment.status === "succeeded") {
        expect(st.payment.amountInPaise).toBe(s.amount);
        expect(st.payment.capturedAmountInPaise).toBe(s.amount);
      }
    }
  });

  it("stops at its time budget and leaves the remainder due", async () => {
    const clock = clockAt();
    const s1 = await seedUnresolvedPayment(db);
    const s2 = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s1, s2);

    const summary = await reconcileDuePayments(db, gateway, {now: clock.now, budgetMs: -1});

    expect(summary).toMatchObject({examined: 0, stoppedForBudget: true});
    expect(gateway.calls).toEqual([]);
  });
});

describe("the reconciliation window", () => {
  const nearEnd = Timestamp.fromMillis(T0.toMillis() + RECONCILE_WINDOW_MS - 10 * 60 * 1000);

  it("the evaluation that would be the last closes the payment: no further attempt is scheduled", async () => {
    const s = await seedUnresolvedPayment(db, {reconciliation: {nextAttemptAt: T0}});
    const gateway = gatewayFor(s);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clockAt(nearEnd).now})).toEqual({kind: "window_closed"});

    const state = await expectPaymentConsistency(s);
    expect(state.reconciliation).toMatchObject({resolution: "window_closed"});
    expect(state.reconciliation.nextAttemptAt).toBeUndefined();
    expect(state.audit.some((id) => id.startsWith("closed_window_"))).toBe(true);
  });

  it("the last look still adopts a capture it finds", async () => {
    const s = await seedUnresolvedPayment(db, {reconciliation: {nextAttemptAt: T0}});
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s)]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clockAt(nearEnd).now})).toMatchObject({kind: "recovered"});

    expect((await expectPaymentConsistency(s)).payment.status).toBe("succeeded");
  });

  it("an authorized-but-never-captured payment at the end is flagged for a person", async () => {
    const s = await seedUnresolvedPayment(db, {reconciliation: {nextAttemptAt: T0}});
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [
      providerOrderPayment({id: payId(), providerOrderId: s.providerOrderId, status: "authorized", captured: false}),
    ]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clockAt(nearEnd).now}))
      .toEqual({kind: "flagged", code: "authorized_not_captured"});

    expect((await loadPaymentState(s)).reconciliation).toMatchObject({attentionRequired: true, resolution: "window_closed"});
  });

  it("lookups that never succeeded by the end are flagged as unverified, not treated as unpaid", async () => {
    const s = await seedUnresolvedPayment(db, {reconciliation: {nextAttemptAt: T0, inconclusiveStreak: 6}});
    const gateway = gatewayFor(s);
    gateway.script("timeout");

    expect(await reconcilePayment(db, gateway, s.loc, {now: clockAt(nearEnd).now}))
      .toEqual({kind: "flagged", code: "window_closed_unverified"});

    const state = await expectPaymentConsistency(s);
    expect(state.reconciliation).toMatchObject({attentionRequired: true, attentionCode: "window_closed_unverified"});
  });
});

describe("accounting invariants across a mixed batch", () => {
  it("every payment ends consistent with its order, whatever the provider said", async () => {
    const clock = clockAt();
    const scenarios = {
      captured: await seedUnresolvedPayment(db),
      lateCapture: await seedUnresolvedPayment(db, {orderStatus: "cancelled"}),
      failed: await seedUnresolvedPayment(db),
      untouched: await seedUnresolvedPayment(db),
      mismatch: await seedUnresolvedPayment(db),
      timeout: await seedUnresolvedPayment(db),
    };
    const gateway = gatewayFor(...Object.values(scenarios));
    gateway.setPayments(scenarios.captured.providerOrderId, [capturedFor(scenarios.captured)]);
    gateway.setPayments(scenarios.lateCapture.providerOrderId, [capturedFor(scenarios.lateCapture)]);
    gateway.setPayments(scenarios.failed.providerOrderId, [
      providerOrderPayment({id: payId(), providerOrderId: scenarios.failed.providerOrderId, status: "failed", captured: false}),
    ]);
    gateway.setPayments(scenarios.mismatch.providerOrderId, [capturedFor(scenarios.mismatch, {amountInPaise: 1})]);
    gateway.setPayments(scenarios.timeout.providerOrderId, [capturedFor(scenarios.timeout)]);

    // The sweep order is the order of nextAttemptAt; make the timeout one deterministic.
    await scenarios.timeout.paymentRef.update({"reconciliation.nextAttemptAt": Timestamp.fromMillis(T0.toMillis())});
    gateway.script("timeout");
    const summary = await reconcileDuePayments(db, gateway, {now: clock.now});

    expect(summary.examined).toBe(6);
    for (const s of Object.values(scenarios)) {
      await expectPaymentConsistency(s);
    }
    const statuses = Object.fromEntries(await Promise.all(Object.entries(scenarios)
      .map(async ([name, s]) => [name, (await loadPaymentState(s)).payment.status])));
    expect(statuses).toEqual({
      captured: "succeeded", lateCapture: "succeeded", failed: "failed", untouched: "pending", mismatch: "pending", timeout: "pending",
    });
  });

  it("an order in a state a payment can never confirm is flagged before the provider is asked", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const gateway = gatewayFor(s);
    gateway.setPayments(s.providerOrderId, [capturedFor(s)]);
    // The order moves on to a state a payment cannot confirm (picked up) before reconciliation runs.
    await s.orderRef.update({status: "completed"});

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "flagged", code: "inconsistent_documents"});
    expect(gateway.calls).toEqual([]);
    expect((await loadPaymentState(s)).payment.status).toBe("pending");
  });
});

describe("the real Razorpay adapter feeding the driver (Razorpay-shaped JSON over a faked transport)", () => {
  /** A Razorpay payment object as the API returns it, including fields the adapter must drop. */
  const razorpayPayment = (s: PaymentScenario, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "pay_RealShape000001", entity: "payment", amount: s.amount, currency: "INR", status: "captured",
    order_id: s.providerOrderId, method: "card", captured: true, amount_refunded: 0, refund_status: null,
    email: "customer@example.com", contact: "+910000000000", created_at: 1790000000, card_id: "card_x", notes: [], ...over,
  });

  function adapterFor(items: Record<string, unknown>[]): {gateway: ReturnType<typeof createRazorpayPaymentLookupGateway>; urls: string[]; methods: string[]} {
    const urls: string[] = [];
    const methods: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      urls.push(url);
      methods.push(init.method);
      return {status: 200, text: async () => JSON.stringify({entity: "collection", count: items.length, items})};
    };
    const gateway = createRazorpayPaymentLookupGateway({
      getCredentials: () => ({keyId: "rzp_test_FakeKeyForTests", keySecret: "fake-secret-for-tests"}), fetchFn,
    });
    return {gateway, urls, methods};
  }

  it("a captured payment in Razorpay's own shape is adopted through one read-only GET", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db);
    const {gateway, urls, methods} = adapterFor([razorpayPayment(s)]);

    const result = await reconcilePayment(db, gateway, s.loc, {now: clock.now});

    expect(result).toEqual({kind: "recovered", providerPaymentId: "pay_RealShape000001", lateCapture: false});
    expect(methods).toEqual(["GET"]);
    expect(urls).toEqual([`https://api.razorpay.com/v1/orders/${s.providerOrderId}/payments`]);
    const state = await expectPaymentConsistency(s);
    expect(state.order).toMatchObject({status: "confirmed", paymentStatus: "paid"});
    // Nothing from the provider's raw object (contact, e-mail, card) reaches Zesto's documents.
    const stored = JSON.stringify(state.payment);
    for (const leaked of ["customer@example.com", "+910000000000", "card_x"]) {
      expect(stored).not.toContain(leaked);
    }
  });

  it("authorized or created in Razorpay's shape is never paid", async () => {
    const clock = clockAt();
    const authorized = await seedUnresolvedPayment(db);
    const created = await seedUnresolvedPayment(db);

    expect(await reconcilePayment(db, adapterFor([razorpayPayment(authorized, {status: "authorized", captured: false})]).gateway, authorized.loc, {now: clock.now}))
      .toMatchObject({kind: "pending", state: "authorized"});
    expect(await reconcilePayment(db, adapterFor([razorpayPayment(created, {status: "created", captured: false})]).gateway, created.loc, {now: clock.now}))
      .toMatchObject({kind: "pending", state: "created"});

    for (const s of [authorized, created]) {
      const state = await expectPaymentConsistency(s);
      expect(state.payment.status).toBe("pending");
      expect(state.order).toMatchObject({status: "pending_payment", paymentStatus: "pending"});
    }
  });

  it("evidence for a different provider order, or a different amount, is rejected", async () => {
    const clock = clockAt();
    const wrongOrder = await seedUnresolvedPayment(db);
    const wrongAmount = await seedUnresolvedPayment(db);

    const foreign = await reconcilePayment(
      db, adapterFor([razorpayPayment(wrongOrder, {order_id: "order_SomebodyElse0001"})]).gateway, wrongOrder.loc, {now: clock.now},
    );
    const mismatched = await reconcilePayment(
      db, adapterFor([razorpayPayment(wrongAmount, {amount: wrongAmount.amount - 100})]).gateway, wrongAmount.loc, {now: clock.now},
    );

    expect(foreign).toMatchObject({kind: "pending", state: "no_payments"});
    expect(mismatched).toEqual({kind: "flagged", code: "captured_amount_mismatch"});
    for (const s of [wrongOrder, wrongAmount]) {
      const state = await expectPaymentConsistency(s);
      expect(state.payment.status).toBe("pending");
      expect(state.order).toMatchObject({status: "pending_payment", paymentStatus: "pending"});
    }
  });

  it("a late capture on a cancelled order reserves exactly one refund, and a second run creates nothing more", async () => {
    const clock = clockAt();
    const s = await seedUnresolvedPayment(db, {orderStatus: "cancelled"});
    const {gateway, urls} = adapterFor([razorpayPayment(s)]);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now}))
      .toEqual({kind: "recovered", providerPaymentId: "pay_RealShape000001", lateCapture: true});
    const first = await expectPaymentConsistency(s);
    expect(Object.keys(first.refunds)).toHaveLength(1);

    expect(await reconcilePayment(db, gateway, s.loc, {now: clock.now})).toEqual({kind: "already_resolved"});
    expect((await reconcileDuePayments(db, gateway, {now: clock.now})).examined).toBe(0);
    const second = await expectPaymentConsistency(s);
    expect(Object.keys(second.refunds)).toEqual(Object.keys(first.refunds));
    expect(second.payment).toEqual(first.payment);
    expect(urls).toHaveLength(1);
  });
});

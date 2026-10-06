// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {OrganizationMembership} from "../auth/membership";
import {createFakeRefundGateway, type FakeRefundGateway} from "../providers/refundGateway.fake";
import {NOTIFICATION_EVENTS_COLLECTION} from "./notificationEvents";
import {cancelOrder} from "./orderCancellation";
import {markPaymentSucceeded} from "./payments";
import {receiveRazorpayWebhook} from "./razorpayWebhooks";
import {handleRefundCreated, reconcileDueRefunds} from "./refundReconciliation";
import {createRefundRetry} from "./refundRetry";
import {
  AMOUNT,
  auditNames,
  cleanupScenarios,
  expectAccounting,
  loadRefund,
  loadState,
  manualClock,
  providerPaymentFor,
  seedScenario,
  type Scenario,
} from "./refundScenario.fake";
import {submitRefund} from "./refundSubmission";
import {applyRefundEvidence} from "./refundTransitions";

/**
 * The scheduled reconciliation sweep, the creation trigger's handler, safe retry of a
 * failed refund, and the end-to-end flows that feed them (a cancellation's refund, a
 * late capture) — against a Firestore emulator and the fake provider. All drivers go
 * through `submitRefund`; these tests prove the sweep is bounded, skips what it must,
 * is safe when run twice at once, and that every flow ends with consistent accounting.
 */

const PROJECT_ID = "demo-zesto-refund-reconciliation";
let db: Firestore;

vi.setConfig({testTimeout: 30000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

const strayPaths: string[] = [];

afterEach(async () => {
  await cleanupScenarios(db);
  for (const path of strayPaths.splice(0)) {
    await db.doc(path).delete();
  }
  const events = await db.collection(NOTIFICATION_EVENTS_COLLECTION).get();
  await Promise.all(events.docs.map((doc) => doc.ref.delete()));
});

/** Outbox ORDER events for the order: a late capture never confirms it, so none (the refund has its own event). */
async function orderEventIds(s: Scenario): Promise<string[]> {
  const snapshot = await db.collection(NOTIFICATION_EVENTS_COLLECTION).where("orderId", "==", s.orderId).get();
  return snapshot.docs.filter((doc) => !String(doc.data().type).startsWith("refund_")).map((doc) => doc.id);
}

function gatewayFor(...scenarios: Scenario[]): FakeRefundGateway {
  const gateway = createFakeRefundGateway();
  for (const s of scenarios) {
    gateway.addPayment(providerPaymentFor(s));
  }
  return gateway;
}

const createCalls = (gateway: FakeRefundGateway) => gateway.calls.filter((c) => c.method === "createRefund");

describe("reconcileDueRefunds — selection and bounds", () => {
  it("advances only refunds that are due, live, unflagged and unleased", async () => {
    const clock = manualClock();
    const due = await seedScenario(db);
    const duePending = await seedScenario(db, {refundStatus: "pending"});
    const future = await seedScenario(db, {nextAttemptAt: Timestamp.fromMillis(clock.now().toMillis() + 60_000)});
    const flagged = await seedScenario(db, {refund: {attentionRequired: true}});
    const terminal = await seedScenario(db, {refundStatus: "processed"});
    const leased = await seedScenario(db, {refund: {
      submitAttempts: 1, submitLeaseExpiresAt: Timestamp.fromMillis(clock.now().toMillis() + 60_000),
    }});
    const gateway = gatewayFor(due, duePending, future, flagged, terminal, leased);

    const summary = await reconcileDueRefunds(db, gateway, {now: clock.now});

    // The query itself leaves out the future one and the terminal one.
    expect(summary.examined).toBe(4);
    expect(summary.results).toMatchObject({applied: 1, leased: 1});
    expect((await loadRefund(due)).status).toBe("pending");
    expect(await loadRefund(future)).toMatchObject({status: "requested", submitAttempts: 0});
    expect(await loadRefund(flagged)).toMatchObject({status: "requested", submitAttempts: 0});
    expect(await loadRefund(terminal)).toMatchObject({status: "processed"});
    expect(await loadRefund(leased)).toMatchObject({status: "requested", submitAttempts: 1});
    // Only `due` was created at the provider; `duePending` (no provider refund known to the fake) was looked up.
    expect(createCalls(gateway)).toHaveLength(1);
    for (const s of [due, future, terminal]) {
      await expectAccounting(s);
    }
  });

  it("is bounded by its limit and takes the oldest due refunds first", async () => {
    const clock = manualClock();
    const scenarios: Scenario[] = [];
    for (let i = 0; i < 8; i++) {
      scenarios.push(await seedScenario(db, {nextAttemptAt: Timestamp.fromMillis(clock.now().toMillis() - (100 - i) * 1000)}));
    }
    const gateway = gatewayFor(...scenarios);

    const summary = await reconcileDueRefunds(db, gateway, {now: clock.now, limit: 3});

    expect(summary.examined).toBe(3);
    expect(createCalls(gateway)).toHaveLength(3);
    const touched = [];
    for (const s of scenarios) {
      touched.push((await loadRefund(s)).submitAttempts);
    }
    expect(touched).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it("stops at its time budget and leaves the rest for the next run", async () => {
    const clock = manualClock();
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);

    const summary = await reconcileDueRefunds(db, gateway, {now: clock.now, budgetMs: -1});

    expect(summary).toMatchObject({examined: 0, stoppedForBudget: true});
    expect(gateway.calls).toEqual([]);
  });

  it("skips a document at an unexpected path, or one whose content is malformed, without acting or stopping", async () => {
    const clock = manualClock();
    const good = await seedScenario(db);
    const bad = await seedScenario(db, {refund: {amountInPaise: -1}});
    // A "refund" at a path that is not an order's payment's: never acted on.
    const stray = db.doc(`stray${randomUUID().slice(0, 6)}/x/refunds/y-r1`);
    strayPaths.push(stray.path);
    await stray.set({status: "requested", nextAttemptAt: Timestamp.fromMillis(0), attentionRequired: false});
    // Right path shape, but the refund ID does not encode the order it sits under.
    const confused = good.paymentRef.collection("refunds").doc("some-other-order-r1");
    await confused.set({status: "requested", nextAttemptAt: Timestamp.fromMillis(0), attentionRequired: false});
    const gateway = gatewayFor(good, bad);

    const summary = await reconcileDueRefunds(db, gateway, {now: clock.now});

    expect(summary.results.skipped_malformed_path).toBe(2);
    expect(summary.results.malformed).toBe(1);
    expect(summary.results.applied).toBe(1);
    expect((await loadRefund(good)).status).toBe("pending");
    expect(await loadRefund(bad)).toMatchObject({status: "requested", submitAttempts: 0});
    expect(createCalls(gateway)).toHaveLength(1);
  });

  it("never creates a refund: a paid, cancelled payment with no refund document is not touched", async () => {
    const clock = manualClock();
    const s = await seedScenario(db, {noRefund: true});
    const gateway = gatewayFor(s);

    const summary = await reconcileDueRefunds(db, gateway, {now: clock.now});

    expect(summary.examined).toBe(0);
    expect(gateway.calls).toEqual([]);
    expect(Object.keys((await loadState(s)).refunds)).toHaveLength(0);
  });

  it("keeps tenants apart: each refund is submitted for its own provider payment and touches only its own documents", async () => {
    const clock = manualClock();
    const a = await seedScenario(db, {amount: 10000});
    const b = await seedScenario(db, {amount: 25000});
    const gateway = gatewayFor(a, b);

    await reconcileDueRefunds(db, gateway, {now: clock.now});

    const sent = createCalls(gateway).map((c) => c.input as {providerPaymentId: string; amountInPaise: number; receipt: string});
    expect(sent.map((i) => [i.providerPaymentId, i.amountInPaise, i.receipt]).sort()).toEqual([
      [a.providerPaymentId, 10000, a.loc.refundId],
      [b.providerPaymentId, 25000, b.loc.refundId],
    ].sort());
    expect((await expectAccounting(a)).payment).toMatchObject({refundPendingInPaise: 10000});
    expect((await expectAccounting(b)).payment).toMatchObject({refundPendingInPaise: 25000});
  });

  it("one refund's unexpected failure does not stop the sweep", async () => {
    const clock = manualClock();
    const first = await seedScenario(db, {nextAttemptAt: Timestamp.fromMillis(clock.now().toMillis() - 5000)});
    const second = await seedScenario(db, {nextAttemptAt: Timestamp.fromMillis(clock.now().toMillis() - 1000)});
    const gateway = gatewayFor(first, second);
    const original = gateway.createRefund.bind(gateway);
    let calls = 0;
    gateway.createRefund = async (input) => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("unexpected");
      }
      return original(input);
    };

    const summary = await reconcileDueRefunds(db, gateway, {now: clock.now});

    // An unexpected exception is an inconclusive attempt: recorded, recoverable, never a failure.
    expect(summary.results).toMatchObject({deferred: 1, applied: 1});
    expect(await loadRefund(first)).toMatchObject({status: "requested", failureCode: "unexpected_error"});
    expect((await loadRefund(second)).status).toBe("pending");
  });
});

describe("reconcileDueRefunds — concurrency", () => {
  it("two sweeps running at once never create a refund twice (G)", {timeout: 60000}, async () => {
    const clock = manualClock();
    const scenarios: Scenario[] = [];
    for (let i = 0; i < 6; i++) {
      scenarios.push(await seedScenario(db));
    }
    const gateway = gatewayFor(...scenarios);

    const [one, two] = await Promise.all([
      reconcileDueRefunds(db, gateway, {now: clock.now}),
      reconcileDueRefunds(db, gateway, {now: clock.now}),
    ]);

    expect(createCalls(gateway)).toHaveLength(6);
    expect(gateway.refunds()).toHaveLength(6);
    expect((one.results.applied ?? 0) + (two.results.applied ?? 0)).toBe(6);
    for (const s of scenarios) {
      expect(await loadRefund(s)).toMatchObject({status: "pending", submitAttempts: 1});
      await expectAccounting(s);
    }
  });

  it("a refund settled by a webhook while the sweep is looking it up stays settled exactly once (H)", async () => {
    const clock = manualClock();
    const s = await seedScenario(db, {refundStatus: "pending"});
    const gateway = gatewayFor(s);
    const providerRefundId = (await loadRefund(s)).providerRefundId as string;
    // The provider still reports it pending to the sweep, while the webhook settles it in between.
    gateway.fetchRefund = async () => {
      await applyRefundEvidence(db, s.loc, {
        kind: "provider_refund", source: "webhook", providerEventKey: "evt_mid",
        providerRefund: {
          id: providerRefundId, providerPaymentId: s.providerPaymentId, amountInPaise: AMOUNT, currency: "INR", status: "processed",
        },
      }, clock.now());
      return {
        id: providerRefundId, providerPaymentId: s.providerPaymentId, amountInPaise: AMOUNT, currency: "INR",
        status: "pending", notes: {},
      };
    };

    await reconcileDueRefunds(db, gateway, {now: clock.now});

    expect(await loadRefund(s)).toMatchObject({status: "processed"});
    const state = await expectAccounting(s);
    expect(state.payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0});
    expect((await auditNames(s)).transitions).toEqual(["pending_to_processed"]);
  });

  it("a duplicate creation trigger and a sweep together send one request (B)", async () => {
    const clock = manualClock();
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);

    await Promise.all([
      handleRefundCreated(db, gateway, s.refundRef.path),
      handleRefundCreated(db, gateway, s.refundRef.path),
      reconcileDueRefunds(db, gateway, {now: clock.now}),
    ]);

    expect(createCalls(gateway)).toHaveLength(1);
    await expectAccounting(s);
  });

  it("the trigger ignores a path that is not a refund's", async () => {
    const gateway = createFakeRefundGateway();
    expect(await handleRefundCreated(db, gateway, "organizations/o/outlets/x")).toBeNull();
    expect(gateway.calls).toEqual([]);
  });
});

describe("retrying a failed refund — a NEW attempt, never a reopening", () => {
  async function failedScenario() {
    const s = await seedScenario(db);
    const gateway = gatewayFor(s);
    gateway.script("createRefund", {rejectWith: "BAD_REQUEST_ERROR"});
    await submitRefund(db, gateway, s.loc, {now: manualClock().now});
    expect(await loadRefund(s)).toMatchObject({status: "failed"});
    return {s, gateway};
  }

  it("creates the next deterministic refund, preserves the failed one, re-reserves the money and clears the failure flag", async () => {
    const {s, gateway} = await failedScenario();
    const failedBefore = await loadRefund(s);

    const result = await createRefundRetry(db, {
      location: s.loc, initiatedBy: "U-manager-1", initiatedByRole: "organization",
    });

    expect(result).toEqual({kind: "created", refundId: `${s.orderId}-r2`});
    const state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toEqual(failedBefore);
    expect(state.refunds[`${s.orderId}-r2`]).toMatchObject({
      status: "requested", source: "retry", reason: "customer_cancelled", amountInPaise: AMOUNT,
      initiatedBy: "U-manager-1", initiatedByRole: "organization", idempotencyKey: `${s.orderId}-r2`,
      submitAttempts: 0, attentionRequired: false,
    });
    expect(state.payment).toMatchObject({refundSeq: 2, refundPendingInPaise: AMOUNT, refundedAmountInPaise: 0, refundState: "in_progress"});
    expect(state.order.refundStatus).toBe("in_progress");

    // The new attempt flows through the SAME driver, with its own idempotency key and receipt.
    await submitRefund(db, gateway, {...s.loc, refundId: `${s.orderId}-r2`}, {now: manualClock().now});
    expect(createCalls(gateway).map((c) => (c.input as {idempotencyKey: string}).idempotencyKey)).toEqual([
      s.loc.refundId, `${s.orderId}-r2`,
    ]);
    expect(await loadRefund(s, `${s.orderId}-r2`)).toMatchObject({status: "pending"});
    expect(await loadRefund(s)).toMatchObject({status: "failed"});
    await expectAccounting(s);
  });

  it("is refused unless the LATEST refund failed, and never for an external one", async () => {
    for (const refundStatus of ["requested", "pending", "processed"] as const) {
      const s = await seedScenario(db, {refundStatus});
      expect(await createRefundRetry(db, {location: s.loc, initiatedBy: "system", initiatedByRole: "system"}))
        .toEqual({kind: "not_retryable", reason: "latest_not_failed"});
      expect(Object.keys((await loadState(s)).refunds)).toHaveLength(1);
    }
    const none = await seedScenario(db, {noRefund: true});
    expect(await createRefundRetry(db, {location: none.loc, initiatedBy: "system", initiatedByRole: "system"}))
      .toEqual({kind: "not_retryable", reason: "no_refund"});
    const external = await seedScenario(db, {refundStatus: "failed", refund: {reason: "external", source: "reconciliation"}});
    expect(await createRefundRetry(db, {location: external.loc, initiatedBy: "system", initiatedByRole: "system"}))
      .toEqual({kind: "not_retryable", reason: "external_refund"});
  });

  it("two concurrent retries create exactly one new refund", async () => {
    const {s} = await failedScenario();

    const results = await Promise.all([
      createRefundRetry(db, {location: s.loc, initiatedBy: "U-a", initiatedByRole: "organization"}),
      createRefundRetry(db, {location: s.loc, initiatedBy: "U-b", initiatedByRole: "organization"}),
    ]);

    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "not_retryable")).toHaveLength(1);
    const state = await expectAccounting(s);
    expect(Object.keys(state.refunds)).toHaveLength(2);
    expect(state.payment.refundPendingInPaise).toBe(AMOUNT);
  });

  it("a retry racing the failure of the previous attempt converges on one consistent outcome (I)", async () => {
    const s = await seedScenario(db);
    const clock = manualClock();

    const [applied, retried] = await Promise.all([
      applyRefundEvidence(db, s.loc, {kind: "definitive_rejection", code: "BAD_REQUEST_ERROR", message: "no", source: "submit"}, clock.now()),
      createRefundRetry(db, {location: s.loc, initiatedBy: "U-a", initiatedByRole: "organization"}),
    ]);

    expect(applied).toMatchObject({kind: "applied", to: "failed"});
    // Either the retry saw the refund still live (refused) or already failed (created) — never both states at once.
    expect(["not_retryable", "created"]).toContain(retried.kind);
    const state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "failed"});
    expect(state.payment.refundPendingInPaise).toBe(retried.kind === "created" ? AMOUNT : 0);
    if (retried.kind === "not_retryable") {
      expect(await createRefundRetry(db, {location: s.loc, initiatedBy: "U-a", initiatedByRole: "organization"}))
        .toMatchObject({kind: "created"});
      await expectAccounting(s);
    }
  });

  it("never reserves more than was captured: a retry takes only what remains", async () => {
    const s = await seedScenario(db, {
      amount: 20000, refundStatus: "failed", refundedInPaise: 15000,
      refund: {amountInPaise: 5000},
    });

    const result = await createRefundRetry(db, {location: s.loc, initiatedBy: "system", initiatedByRole: "system"});

    expect(result.kind).toBe("created");
    const state = await loadState(s);
    expect(state.payment).toMatchObject({refundedAmountInPaise: 15000, refundPendingInPaise: 5000, capturedAmountInPaise: 20000});
    expect(state.refunds[`${s.orderId}-r2`]).toMatchObject({amountInPaise: 5000});
    // Nothing left for yet another attempt once that one is reserved.
    await failRefund(s, `${s.orderId}-r2`);
    expect((await createRefundRetry(db, {location: s.loc, initiatedBy: "system", initiatedByRole: "system"})).kind).toBe("created");
  });

  it("a payment with nothing left to refund yields nothing_to_refund", async () => {
    const s = await seedScenario(db, {refundStatus: "failed", refundedInPaise: AMOUNT, pendingInPaise: 0});

    expect(await createRefundRetry(db, {location: s.loc, initiatedBy: "system", initiatedByRole: "system"}))
      .toEqual({kind: "nothing_to_refund"});
  });
});

/** Turns a seeded paid order back into one whose payment the provider has not captured yet. */
async function makeUncaptured(s: Scenario): Promise<void> {
  await s.orderRef.update({paymentStatus: "pending"});
  await s.paymentRef.update({
    status: "pending",
    providerPaymentId: FieldValue.delete(),
    capturedAmountInPaise: FieldValue.delete(),
    refundedAmountInPaise: FieldValue.delete(),
    refundPendingInPaise: FieldValue.delete(),
    refundSeq: FieldValue.delete(),
    refundState: FieldValue.delete(),
  });
}

async function failRefund(s: Scenario, refundId: string): Promise<void> {
  await applyRefundEvidence(db, {...s.loc, refundId}, {
    kind: "definitive_rejection", code: "BAD_REQUEST_ERROR", message: "no", source: "submit",
  }, manualClock().now());
}

describe("the flows that feed the pipeline", () => {
  const owner = (organizationId: string): OrganizationMembership => ({
    userId: `U-${randomUUID().slice(0, 8)}`, organizationId, role: "owner", status: "active",
  });

  it("a cancellation's refund is submitted by the trigger, a duplicate trigger and the sweep add nothing (A)", async () => {
    const clock = manualClock();
    const s = await seedScenario(db, {noRefund: true, orderStatus: "confirmed"});
    const gateway = gatewayFor(s);

    const cancelled = await cancelOrder(db, {
      actor: {kind: "organization", membership: owner(s.organizationId)}, orderId: s.orderId, reason: "outlet_closed",
    });
    expect(cancelled.refund).toMatchObject({refundId: s.loc.refundId, amountInPaise: AMOUNT});
    expect(await loadRefund(s)).toMatchObject({status: "requested", submitAttempts: 0});

    await Promise.all([
      handleRefundCreated(db, gateway, s.refundRef.path),
      handleRefundCreated(db, gateway, s.refundRef.path),
      reconcileDueRefunds(db, gateway, {now: () => Timestamp.fromMillis(Date.now() + 10 * 60 * 1000)}),
    ]);

    void clock;
    expect(createCalls(gateway)).toHaveLength(1);
    const state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "pending", reason: "outlet_cancelled"});
    expect(state.order).toMatchObject({status: "cancelled", refundStatus: "in_progress"});
  });

  it("a payment captured AFTER cancellation is refunded through the same pipeline, once, however often it is reported (K)", async () => {
    const s = await seedScenario(db, {noRefund: true, orderStatus: "cancelled"});
    await makeUncaptured(s);
    const gateway = gatewayFor(s);
    const input = {
      orderId: s.orderId, paymentId: s.orderId, amountInPaise: AMOUNT, currency: "INR", providerPaymentId: s.providerPaymentId,
    };

    const [first, second] = await Promise.all([markPaymentSucceeded(db, input), markPaymentSucceeded(db, input)]);
    const third = await markPaymentSucceeded(db, input);

    expect([first.refundId, second.refundId, third.refundId].filter((id) => id !== undefined)).toEqual([s.loc.refundId]);
    let state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({
      reason: "late_capture_after_cancel", source: "cancellation", initiatedBy: "system", status: "requested",
    });
    expect(state.order).toMatchObject({status: "cancelled", paymentStatus: "paid"});
    // No order_confirmed notification: the order is never confirmed again.
    expect(await orderEventIds(s)).toEqual([]);

    await handleRefundCreated(db, gateway, s.refundRef.path);

    state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "pending"});
    expect(createCalls(gateway)).toHaveLength(1);
  });

  it("a late capture reported by webhook, then refund settled by webhook, ends refunded with no confirmation", async () => {
    const s = await seedScenario(db, {noRefund: true, orderStatus: "cancelled"});
    await makeUncaptured(s);
    const captured = Buffer.from(JSON.stringify({
      entity: "event", event: "payment.captured",
      payload: {payment: {entity: {
        id: s.providerPaymentId, order_id: s.providerOrderId, amount: AMOUNT, currency: "INR", status: "captured",
      }}},
    }));
    expect(await receiveRazorpayWebhook(db, {rawBody: captured, eventIdHeader: "evt_cap"})).toMatchObject({outcome: "payment_succeeded"});
    const gateway = gatewayFor(s);
    await handleRefundCreated(db, gateway, s.refundRef.path);
    const providerRefundId = (await loadRefund(s)).providerRefundId as string;
    gateway.settleRefund(providerRefundId, "processed");
    const processed = Buffer.from(JSON.stringify({
      entity: "event", event: "refund.processed",
      payload: {refund: {entity: {
        id: providerRefundId, payment_id: s.providerPaymentId, amount: AMOUNT, currency: "INR", status: "processed",
        receipt: s.loc.refundId, notes: {zestoRefundId: s.loc.refundId},
      }}},
    }));

    expect(await receiveRazorpayWebhook(db, {rawBody: processed, eventIdHeader: "evt_proc"})).toMatchObject({outcome: "refund_processed"});

    const state = await expectAccounting(s);
    expect(state.order).toMatchObject({status: "cancelled", paymentStatus: "paid", refundStatus: "refunded"});
    expect(state.payment).toMatchObject({status: "succeeded", refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0});
    expect(await orderEventIds(s)).toEqual([]);
  });
});

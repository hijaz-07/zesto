// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {createFakeRefundGateway} from "../providers/refundGateway.fake";
import {receiveRazorpayWebhook, WEBHOOK_EVENTS_COLLECTION} from "./razorpayWebhooks";
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

/**
 * Razorpay refund webhooks through the REAL pipeline entry point
 * (`receiveRazorpayWebhook`: parse, claim/dedupe, reconcile, record) against a Firestore
 * emulator: valid transitions, duplicates, out-of-order and contradictory events, a webhook
 * that beats the API response, foreign / mismatched refunds, external refund adoption, and
 * the late `payment.failed` that must never regress a captured payment.
 *
 * The HMAC check lives in the route (`routes/webhooks.ts`) and is covered by its own tests;
 * what is proved here is everything after it.
 */

const PROJECT_ID = "demo-zesto-refund-webhooks";
let db: Firestore;

vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

afterEach(async () => {
  await cleanupScenarios(db);
});

interface EntityOverrides {
  id?: string;
  payment_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  receipt?: string | null;
  notes?: unknown;
}

function refundBody(type: string, s: Scenario, o: EntityOverrides = {}): Buffer {
  return Buffer.from(JSON.stringify({
    entity: "event",
    account_id: "acc_TEST",
    event: type,
    contains: ["refund"],
    payload: {
      refund: {
        entity: {
          entity: "refund",
          id: o.id ?? "rfnd_web_1",
          payment_id: o.payment_id ?? s.providerPaymentId,
          amount: o.amount ?? s.amount,
          currency: o.currency ?? "INR",
          status: o.status ?? "processed",
          receipt: o.receipt === undefined ? s.loc.refundId : o.receipt,
          notes: o.notes === undefined ? {zestoRefundId: s.loc.refundId, zestoOrderId: s.orderId} : o.notes,
          // Provider fields that must never be read, stored or logged.
          speed_processed: "normal",
          acquirer_data: {rrn: "123456789012"},
          batch_id: null,
          created_at: 1_700_000_000,
        },
      },
    },
    created_at: 1_700_000_000,
  }));
}

let eventSeq = 0;
const send = (body: Buffer, eventId = `evt_${++eventSeq}_${randomUUID().slice(0, 8)}`) =>
  receiveRazorpayWebhook(db, {rawBody: body, eventIdHeader: eventId});

async function seedPendingWithProviderId(extra: Parameters<typeof seedScenario>[1] = {}) {
  return seedScenario(db, {refundStatus: "pending", refund: {providerRefundId: "rfnd_web_1"}, ...extra});
}

describe("refund webhooks — valid transitions", () => {
  it("refund.created: a webhook that BEATS the create response finds the refund by Zesto's receipt and makes it pending", async () => {
    const s = await seedScenario(db);

    const result = await send(refundBody("refund.created", s, {status: "pending"}), "evt_created_1");

    expect(result).toMatchObject({kind: "processed", outcome: "refund_pending", providerRefundId: "rfnd_web_1"});
    expect(await loadRefund(s)).toMatchObject({
      status: "pending", providerRefundId: "rfnd_web_1", providerStatus: "pending", lastWebhookEventKey: "evt_evt_created_1",
    });
    await expectAccounting(s);
    const transitions = await s.paymentRef.collection("refunds").doc(s.loc.refundId).collection("transitions").get();
    expect(transitions.docs.map((d) => d.data())).toEqual([expect.objectContaining({
      from: "requested", to: "pending", source: "webhook", actor: "provider", providerEventKey: "evt_evt_created_1",
    })]);
  });

  it("refund.processed settles pending into refunded in one step across refund, payment and order", async () => {
    const s = await seedPendingWithProviderId();

    const result = await send(refundBody("refund.processed", s));

    expect(result).toMatchObject({kind: "processed", outcome: "refund_processed"});
    const state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "processed"});
    expect(state.payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0, refundState: "refunded"});
    expect(state.order).toMatchObject({refundStatus: "refunded", refundedInPaise: AMOUNT});
    expect(state.refunds[s.loc.refundId].nextAttemptAt).toBeUndefined();
  });

  it("refund.processed straight from requested (nothing seen before) is a valid move", async () => {
    const s = await seedScenario(db);

    const result = await send(refundBody("refund.processed", s));

    expect(result).toMatchObject({outcome: "refund_processed"});
    await expectAccounting(s);
    expect((await auditNames(s)).transitions).toEqual(["requested_to_processed"]);
  });

  it("refund.failed releases the reserved money and flags the order's refund for a person", async () => {
    const s = await seedPendingWithProviderId();

    const result = await send(refundBody("refund.failed", s, {status: "failed"}));

    expect(result).toMatchObject({outcome: "refund_failed"});
    const state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "failed", attentionRequired: true, failureCode: "provider_refund_failed"});
    expect(state.payment).toMatchObject({refundPendingInPaise: 0, refundedAmountInPaise: 0, refundState: "attention_required"});
  });

  it("an empty notes array (the provider's shape for no notes) is understood, and the receipt alone still finds the refund", async () => {
    const s = await seedScenario(db);

    const result = await send(refundBody("refund.processed", s, {notes: []}));

    expect(result).toMatchObject({outcome: "refund_processed"});
    await expectAccounting(s);
  });
});

describe("refund webhooks — duplicates and ordering", () => {
  it("the same event delivered twice is acknowledged as a duplicate and moves nothing", async () => {
    const s = await seedPendingWithProviderId();
    const body = refundBody("refund.processed", s);

    const first = await send(body, "evt_dup");
    const second = await send(body, "evt_dup");

    expect(first).toMatchObject({kind: "processed", outcome: "refund_processed"});
    expect(second).toMatchObject({kind: "duplicate", originalOutcome: "refund_processed"});
    expect((await expectAccounting(s)).payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0});
  });

  it("a reused event ID with a DIFFERENT body is a conflict and is never processed", async () => {
    const s = await seedPendingWithProviderId();
    await send(refundBody("refund.created", s, {status: "pending"}), "evt_same_id");

    const result = await send(refundBody("refund.processed", s), "evt_same_id");

    expect(result).toMatchObject({kind: "event_id_conflict"});
    expect(await loadRefund(s)).toMatchObject({status: "pending"});
  });

  it("two DIFFERENT events carrying the same terminal fact do not settle twice (monotonic state, not just dedupe)", async () => {
    const s = await seedPendingWithProviderId();

    await send(refundBody("refund.processed", s), "evt_a");
    const again = await send(refundBody("refund.processed", s), "evt_b");

    expect(again).toMatchObject({outcome: "refund_noop_already_in_state"});
    expect((await expectAccounting(s)).payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0});
    expect((await auditNames(s)).transitions).toEqual(["pending_to_processed"]);
  });

  it("an older `refund.created` (pending) delivered AFTER processed is a stale no-op", async () => {
    const s = await seedPendingWithProviderId();
    await send(refundBody("refund.processed", s));

    const late = await send(refundBody("refund.created", s, {status: "pending"}));

    expect(late).toMatchObject({outcome: "refund_noop_stale_event"});
    expect(await loadRefund(s)).toMatchObject({status: "processed"});
    await expectAccounting(s);
  });

  it("processed then a contradictory failed: refused, flagged, recorded as an anomaly, and the refund stays processed", async () => {
    const s = await seedPendingWithProviderId();
    await send(refundBody("refund.processed", s));

    const result = await send(refundBody("refund.failed", s, {status: "failed"}));

    expect(result).toMatchObject({outcome: "rejected_refund_contradicts_terminal_state"});
    const state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "processed", attentionRequired: true});
    expect(state.payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0, refundState: "attention_required"});
    const audit = await auditNames(s);
    expect(audit.transitions).toEqual(["pending_to_processed"]);
    expect(audit.anomalies).toHaveLength(1);
    expect(audit.anomalies[0]).toMatch(/^contradicts_terminal_state_/);
  });

  it("failed then a contradictory processed: refused and flagged; the failure is never reopened", async () => {
    const s = await seedPendingWithProviderId();
    await send(refundBody("refund.failed", s, {status: "failed"}));

    const result = await send(refundBody("refund.processed", s));

    expect(result).toMatchObject({outcome: "rejected_refund_contradicts_terminal_state"});
    const state = await expectAccounting(s);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "failed"});
    expect(state.payment).toMatchObject({refundedAmountInPaise: 0, refundPendingInPaise: 0});
  });

  it("a delivery the pipeline fails on releases its claim so the redelivery is processed", async () => {
    const s = await seedPendingWithProviderId();
    const body = refundBody("refund.processed", s);
    const spy = vi.spyOn(db, "runTransaction").mockRejectedValueOnce(new Error("transient"));
    // The first failing call is the claim itself: nothing was recorded, so the retry just works.
    await expect(send(body, "evt_retry")).rejects.toThrow("transient");
    spy.mockRestore();

    expect(await send(body, "evt_retry")).toMatchObject({outcome: "refund_processed"});
    await expectAccounting(s);
  });
});

describe("refund webhooks — validation against Zesto's own record", () => {
  it("an event whose payment differs from the stored refund's is refused and flags the refund", async () => {
    const s = await seedPendingWithProviderId();

    const result = await send(refundBody("refund.processed", s, {payment_id: "pay_someone_else"}));

    expect(result).toMatchObject({outcome: "rejected_refund_payment_mismatch"});
    expect(await loadRefund(s)).toMatchObject({status: "pending", attentionRequired: true});
    expect((await expectAccounting(s)).payment).toMatchObject({refundPendingInPaise: AMOUNT, refundedAmountInPaise: 0});
  });

  it("an amount that differs from the stored refund is refused (never settles a different amount)", async () => {
    const s = await seedPendingWithProviderId();

    const result = await send(refundBody("refund.processed", s, {amount: AMOUNT - 1}));

    expect(result).toMatchObject({outcome: "rejected_refund_amount_mismatch"});
    expect(await loadRefund(s)).toMatchObject({status: "pending", attentionRequired: true});
    await expectAccounting(s);
  });

  it("a currency other than the refund's is refused", async () => {
    const s = await seedPendingWithProviderId();

    expect(await send(refundBody("refund.processed", s, {currency: "USD"}))).toMatchObject({
      outcome: "rejected_refund_currency_mismatch",
    });
    expect(await loadRefund(s)).toMatchObject({status: "pending"});
  });

  it("an event whose status contradicts its type is ignored", async () => {
    const s = await seedPendingWithProviderId();

    expect(await send(refundBody("refund.processed", s, {status: "pending"}))).toMatchObject({
      outcome: "ignored_refund_status_mismatch",
    });
    expect(await send(refundBody("refund.failed", s, {status: "processed"}))).toMatchObject({
      outcome: "ignored_refund_status_mismatch",
    });
    expect(await send(refundBody("refund.processed", s, {status: "created"}))).toMatchObject({
      outcome: "ignored_refund_status_mismatch",
    });
    expect(await loadRefund(s)).toMatchObject({status: "pending"});
  });

  it("a malformed refund event is rejected before anything is recorded", async () => {
    const s = await seedPendingWithProviderId();
    const broken = JSON.parse(refundBody("refund.processed", s).toString());
    delete broken.payload.refund.entity.payment_id;

    expect(await send(Buffer.from(JSON.stringify(broken)))).toEqual({kind: "malformed"});
    expect((await db.collection(WEBHOOK_EVENTS_COLLECTION).get()).size).toBe(0);
  });

  it("a refund event for a payment Zesto has never seen is acknowledged and changes nothing", async () => {
    const s = await seedPendingWithProviderId();

    const result = await send(refundBody("refund.processed", s, {
      id: "rfnd_unknown", payment_id: "pay_not_ours", receipt: null, notes: [],
    }));

    expect(result).toMatchObject({kind: "processed", outcome: "ignored_unrecognized_refund"});
    await expectAccounting(s);
  });

  it("a receipt that names a refund of ANOTHER order's payment does not touch that other tenant", async () => {
    const a = await seedPendingWithProviderId();
    const b = await seedScenario(db, {refund: {}});

    // The event is about A's payment but claims B's refund ID as its receipt.
    const result = await send(refundBody("refund.processed", a, {
      id: "rfnd_confused", receipt: b.loc.refundId, notes: {zestoRefundId: b.loc.refundId},
    }));

    // B's refund ID is not evidence about A's payment, so this is an unknown refund on A: nothing of A's
    // is free to adopt it, so it is refused and A is flagged. B is untouched either way.
    expect(result).toMatchObject({outcome: "rejected_external_refund_not_applicable"});
    expect(await loadRefund(b)).toMatchObject({status: "requested", attentionRequired: false});
    expect((await loadState(b)).payment).toMatchObject({refundPendingInPaise: AMOUNT, refundedAmountInPaise: 0});
    expect(await loadRefund(a)).toMatchObject({status: "pending"});
    expect((await loadState(a)).payment.refundState).toBe("attention_required");
  });

  it("two refund documents claiming one provider refund ID are ambiguous: refused, nothing moves", async () => {
    const a = await seedPendingWithProviderId();
    const b = await seedPendingWithProviderId();

    const result = await send(refundBody("refund.processed", a));

    expect(result).toMatchObject({outcome: "rejected_ambiguous_refund"});
    expect(await loadRefund(a)).toMatchObject({status: "pending"});
    expect(await loadRefund(b)).toMatchObject({status: "pending"});
  });

  it("stores no provider payload fields (acquirer data, speed, batch) in the refund or its audit records", async () => {
    const s = await seedPendingWithProviderId();
    await send(refundBody("refund.processed", s));

    const serialized = JSON.stringify([
      await loadState(s),
      (await s.paymentRef.collection("refunds").doc(s.loc.refundId).collection("transitions").get()).docs.map((d) => d.data()),
      (await db.collection(WEBHOOK_EVENTS_COLLECTION).get()).docs.map((d) => d.data()),
    ]);
    expect(serialized).not.toContain("123456789012");
    expect(serialized).not.toContain("acquirer");
    expect(serialized).not.toContain("batch_id");
  });
});

describe("refund webhooks — external / manual refunds", () => {
  it("a refund nobody at Zesto asked for is ADOPTED as external, flagged, booked consistently, and the order is NOT cancelled", async () => {
    const s = await seedScenario(db, {
      amount: 20000, orderStatus: "confirmed", refundStatus: "processed", refundedInPaise: 5000,
      refund: {amountInPaise: 5000, reason: "outlet_cancelled", source: "cancellation"},
    });

    const result = await send(refundBody("refund.processed", s, {
      id: "rfnd_dashboard_1", amount: 7000, receipt: null, notes: [],
    }));

    expect(result).toMatchObject({outcome: "refund_adopted_external"});
    const state = await expectAccounting(s);
    const adopted = state.refunds[`${s.orderId}-r2`];
    expect(adopted).toMatchObject({
      reason: "external", source: "reconciliation", status: "processed", amountInPaise: 7000,
      providerRefundId: "rfnd_dashboard_1", attentionRequired: true, initiatedByRole: "system",
    });
    expect(state.payment).toMatchObject({refundedAmountInPaise: 12000, refundPendingInPaise: 0, refundState: "attention_required"});
    expect(state.order).toMatchObject({status: "confirmed", refundStatus: "attention_required", refundedInPaise: 12000});
    expect((await auditNames(s, `${s.orderId}-r2`)).transitions).toEqual(["adopted"]);
  });

  it("a pending external refund reserves its amount; a failed one moves no money", async () => {
    const s = await seedScenario(db, {amount: 20000, refundStatus: "processed", refundedInPaise: 5000, refund: {amountInPaise: 5000}});

    await send(refundBody("refund.created", s, {id: "rfnd_ext_p", amount: 4000, status: "pending", receipt: null, notes: []}));
    await send(refundBody("refund.failed", s, {id: "rfnd_ext_f", amount: 3000, status: "failed", receipt: null, notes: []}));

    const state = await expectAccounting(s);
    expect(state.payment).toMatchObject({refundedAmountInPaise: 5000, refundPendingInPaise: 4000});
    expect(Object.values(state.refunds).map((r) => r.status).sort()).toEqual(["failed", "pending", "processed"]);
  });

  it("the same external refund reported again is recognised, not adopted twice", async () => {
    const s = await seedScenario(db, {amount: 20000, refundStatus: "processed", refundedInPaise: 5000, refund: {amountInPaise: 5000}});
    await send(refundBody("refund.created", s, {id: "rfnd_ext", amount: 4000, status: "pending", receipt: null, notes: []}));

    const again = await send(refundBody("refund.created", s, {id: "rfnd_ext", amount: 4000, status: "pending", receipt: null, notes: []}));
    const settled = await send(refundBody("refund.processed", s, {id: "rfnd_ext", amount: 4000, receipt: null, notes: []}));

    expect(again).toMatchObject({outcome: "refund_noop_already_in_state"});
    expect(settled).toMatchObject({outcome: "refund_processed"});
    const state = await expectAccounting(s);
    expect(Object.keys(state.refunds)).toHaveLength(2);
    expect(state.payment).toMatchObject({refundedAmountInPaise: 9000, refundPendingInPaise: 0});
  });

  it("an external refund that would break the payment's invariant is NOT adopted: the payment is flagged, accounting untouched", async () => {
    // Everything captured is already reserved by Zesto's own pending refund.
    const s = await seedPendingWithProviderId({refund: {providerRefundId: "rfnd_ours"}});

    const result = await send(refundBody("refund.processed", s, {
      id: "rfnd_manual", amount: AMOUNT, receipt: null, notes: [],
    }));

    expect(result).toMatchObject({outcome: "rejected_external_refund_not_applicable"});
    const state = await loadState(s);
    expect(Object.keys(state.refunds)).toEqual([s.loc.refundId]);
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "pending"});
    expect(state.payment).toMatchObject({refundPendingInPaise: AMOUNT, refundedAmountInPaise: 0, refundSeq: 1});
    expect(state.payment.refundState).toBe("attention_required");
    expect(state.order.refundStatus).toBe("attention_required");
    const anomalies = await s.paymentRef.collection("anomalies").get();
    expect(anomalies.size).toBe(1);
    expect(anomalies.docs[0].data()).toMatchObject({code: "external_refund_not_applicable", providerRefundId: "rfnd_manual"});
  });
});

describe("late payment events and the refund pipeline", () => {
  it("a late payment.failed after the capture and its refund never regresses the payment or touches the refund", async () => {
    const s = await seedScenario(db, {refundStatus: "pending"});
    const failed = Buffer.from(JSON.stringify({
      entity: "event", event: "payment.failed",
      payload: {payment: {entity: {
        id: s.providerPaymentId, order_id: s.providerOrderId, amount: AMOUNT, currency: "INR", status: "failed",
      }}},
    }));

    const result = await send(failed);

    expect(result).toMatchObject({kind: "processed", outcome: "failure_ignored_already_succeeded"});
    const state = await expectAccounting(s);
    expect(state.payment).toMatchObject({status: "succeeded", capturedAmountInPaise: AMOUNT, refundPendingInPaise: AMOUNT});
    expect(state.refunds[s.loc.refundId]).toMatchObject({status: "pending"});
    expect(state.order.status).toBe("cancelled");
  });

  it("a webhook that already settled the refund makes a later submit a no-op with no provider call", async () => {
    const s = await seedScenario(db);
    const gateway = createFakeRefundGateway();
    gateway.addPayment(providerPaymentFor(s));
    await send(refundBody("refund.processed", s));

    const result = await submitRefund(db, gateway, s.loc, {now: manualClock().now});

    expect(result).toEqual({kind: "terminal"});
    expect(gateway.calls).toEqual([]);
    await expectAccounting(s);
  });
});

describe("refund webhooks — the claim machinery is the existing one", () => {
  it("records the event as processed with its outcome and no payload", async () => {
    const s = await seedPendingWithProviderId();

    await send(refundBody("refund.processed", s), "evt_record");

    const event = (await db.collection(WEBHOOK_EVENTS_COLLECTION).doc("evt_evt_record").get()).data();
    expect(event).toMatchObject({
      status: "processed", outcome: "refund_processed", eventType: "refund.processed", providerPaymentId: s.providerPaymentId,
    });
    expect(Object.keys(event ?? {}).sort()).toEqual([
      "attempts", "bodyFingerprint", "claimedAt", "eventType", "id", "keySource", "leaseExpiresAt",
      "outcome", "processedAt", "providerPaymentId", "receivedAt", "status",
    ]);
    expect(event?.processedAt).toBeInstanceOf(Timestamp);
  });
});

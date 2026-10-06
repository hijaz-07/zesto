// @vitest-environment node
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {createFakeRefundGateway} from "../providers/refundGateway.fake";
import type {RefundProviderGateway} from "../providers/refundGateway";
import {
  MAX_AUTOMATIC_SUBMIT_ATTEMPTS,
  REFUND_LEASE_MS,
  submitBackoffMs,
  submitRefund,
} from "./refundSubmission";
import {
  AMOUNT,
  auditNames,
  cleanupScenarios,
  expectAccounting,
  loadRefund,
  manualClock,
  providerPaymentFor,
  seedScenario,
  type Scenario,
} from "./refundScenario.fake";
import {applyRefundEvidence} from "./refundTransitions";

/**
 * `submitRefund` — the single refund submission driver — against a REAL Firestore
 * emulator and the fake provider: the lease, every provider outcome, lookup-before-
 * retry, and the races (duplicate triggers, a webhook beating the API response,
 * concurrent workers). Every test ends on the accounting invariant: the payment's
 * aggregates equal the sums over its refund documents and the order's mirror agrees.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own: the contended-lease tests would otherwise slow
// the collection-group queries of every other emulator suite.
const PROJECT_ID = "demo-zesto-refund-submission";
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

async function setup(input: Parameters<typeof seedScenario>[1] = {}) {
  const scenario = await seedScenario(db, input);
  const gateway = createFakeRefundGateway();
  gateway.addPayment(providerPaymentFor(scenario));
  const clock = manualClock();
  return {scenario, gateway, clock};
}

const submit = (s: Scenario, gateway: RefundProviderGateway, clock: ReturnType<typeof manualClock>) =>
  submitRefund(db, gateway, s.loc, {now: clock.now});

describe("submitRefund — the happy paths", () => {
  it("requested -> pending: stores the provider refund, keeps the money reserved, mirrors and audits", async () => {
    const {scenario, gateway, clock} = await setup();

    const result = await submit(scenario, gateway, clock);

    expect(result).toMatchObject({kind: "applied", via: "create", result: {kind: "applied", from: "requested", to: "pending"}});
    const refund = await loadRefund(scenario);
    expect(refund).toMatchObject({
      status: "pending", providerStatus: "pending", submitAttempts: 1, lastSubmitOutcome: "ok", attentionRequired: false,
    });
    expect(refund.providerRefundId).toMatch(/^rfnd_fake_/);
    expect(refund.submitLeaseExpiresAt).toBeUndefined();
    // Pending refunds are re-checked later, as a backup to the webhook.
    expect((refund.nextAttemptAt as Timestamp).toMillis()).toBeGreaterThan(clock.now().toMillis());
    const state = await expectAccounting(scenario);
    expect(state.payment).toMatchObject({refundPendingInPaise: AMOUNT, refundedAmountInPaise: 0, refundState: "in_progress"});
    expect(state.order).toMatchObject({refundStatus: "in_progress", refundedInPaise: 0});
    expect((await auditNames(scenario)).transitions).toEqual(["requested_to_pending"]);
    // The provider got exactly Zesto's identifiers, speed normal, and the deterministic idempotency key.
    expect(gateway.calls.filter((call) => call.method === "createRefund")).toEqual([{
      method: "createRefund",
      input: {
        providerPaymentId: scenario.providerPaymentId, amountInPaise: AMOUNT, speed: "normal",
        idempotencyKey: scenario.loc.refundId, receipt: scenario.loc.refundId,
        notes: {zestoRefundId: scenario.loc.refundId, zestoOrderId: scenario.orderId},
      },
    }]);
  });

  it("requested -> processed at once: moves the amount from pending to refunded", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.nextRefundStatus("processed");

    await submit(scenario, gateway, clock);

    expect(await loadRefund(scenario)).toMatchObject({status: "processed", providerStatus: "processed"});
    const state = await expectAccounting(scenario);
    expect(state.payment).toMatchObject({refundPendingInPaise: 0, refundedAmountInPaise: AMOUNT, refundState: "refunded"});
    expect(state.order).toMatchObject({refundStatus: "refunded", refundedInPaise: AMOUNT});
    expect((await auditNames(scenario)).transitions).toEqual(["requested_to_processed"]);
  });

  it("a provider that reports the new refund already failed fails it, releases the money and flags it", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.nextRefundStatus("failed");

    await submit(scenario, gateway, clock);

    expect(await loadRefund(scenario)).toMatchObject({status: "failed", failureCode: "provider_refund_failed", attentionRequired: true});
    const state = await expectAccounting(scenario);
    expect(state.payment).toMatchObject({refundPendingInPaise: 0, refundedAmountInPaise: 0, refundState: "attention_required"});
  });

  it("a definitive provider rejection fails the refund, releases the reservation and keeps the failure code", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", {rejectWith: "BAD_REQUEST_ERROR"});

    const result = await submit(scenario, gateway, clock);

    expect(result).toMatchObject({kind: "applied", result: {to: "failed"}});
    const refund = await loadRefund(scenario);
    expect(refund).toMatchObject({
      status: "failed", lastSubmitOutcome: "definitive_rejection", failureCode: "BAD_REQUEST_ERROR", attentionRequired: true,
    });
    expect(refund.submitLeaseExpiresAt).toBeUndefined();
    expect(refund.nextAttemptAt).toBeUndefined();
    const state = await expectAccounting(scenario);
    expect(state.payment).toMatchObject({refundPendingInPaise: 0, refundState: "attention_required"});
    expect((await auditNames(scenario)).transitions).toEqual(["requested_to_failed"]);
  });

  it("does nothing for a refund that is terminal, missing, flagged, or not due", async () => {
    const processed = await setup({refundStatus: "processed"});
    expect(await submit(processed.scenario, processed.gateway, processed.clock)).toEqual({kind: "terminal"});

    const flagged = await setup({refund: {attentionRequired: true}});
    expect(await submit(flagged.scenario, flagged.gateway, flagged.clock)).toEqual({kind: "attention_required"});

    const missing = await setup();
    await missing.scenario.refundRef.delete();
    expect(await submit(missing.scenario, missing.gateway, missing.clock)).toEqual({kind: "not_found"});

    // A refund that was attempted before and is scheduled for later is not due yet.
    const later = await setup({refund: {
      submitAttempts: 1, lastSubmitOutcome: "unknown",
      nextAttemptAt: Timestamp.fromMillis(manualClock().now().toMillis() + 60_000),
    }});
    expect(await submit(later.scenario, later.gateway, later.clock)).toEqual({kind: "not_due"});

    for (const s of [processed, flagged, later]) {
      expect(s.gateway.calls).toEqual([]);
    }
  });

  it("refuses to act on a refund the payment has not reserved money for, and flags it", async () => {
    const {scenario, gateway, clock} = await setup({payment: {refundPendingInPaise: 0, refundState: "none"}});

    const result = await submit(scenario, gateway, clock);

    expect(result).toEqual({kind: "inconsistent"});
    expect(gateway.calls).toEqual([]);
    expect(await loadRefund(scenario)).toMatchObject({status: "requested", attentionRequired: true});
  });

  it("a malformed refund document is reported, never acted on", async () => {
    const {scenario, gateway, clock} = await setup({refund: {amountInPaise: -5}});

    expect(await submit(scenario, gateway, clock)).toEqual({kind: "malformed"});
    expect(gateway.calls).toEqual([]);
  });

  it("a coordinate pointing at another tenant's path finds nothing and touches nothing", async () => {
    const a = await setup();
    const b = await setup();
    const crossed = {...a.scenario.loc, organizationId: b.scenario.organizationId};

    expect(await submitRefund(db, a.gateway, crossed, {now: a.clock.now})).toEqual({kind: "not_found"});
    expect(a.gateway.calls).toEqual([]);
    expect(await loadRefund(b.scenario)).toMatchObject({status: "requested", submitAttempts: 0});
  });
});

describe("submitRefund — lease and concurrency", () => {
  it("claims a lease: counts the attempt and sets the sweep time to the lease's end", async () => {
    const {scenario, gateway, clock} = await setup();
    let observed: Record<string, unknown> | undefined;
    const original = gateway.createRefund.bind(gateway);
    gateway.createRefund = async (input) => {
      observed = await loadRefund(scenario);
      return original(input);
    };

    await submit(scenario, gateway, clock);

    expect(observed).toMatchObject({submitAttempts: 1});
    expect((observed?.submitLeaseExpiresAt as Timestamp).toMillis()).toBe(clock.now().toMillis() + REFUND_LEASE_MS);
    expect((observed?.nextAttemptAt as Timestamp).toMillis()).toBe(clock.now().toMillis() + REFUND_LEASE_MS);
  });

  it("two concurrent submissions (a trigger firing twice): exactly one provider call, the other is turned away", async () => {
    const {scenario, gateway, clock} = await setup();

    const results = await Promise.all([submit(scenario, gateway, clock), submit(scenario, gateway, clock)]);

    // The loser either meets the winner's lease or arrives after it finished (nothing is due yet).
    expect(results.filter((r) => r.kind === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "leased" || r.kind === "not_due")).toHaveLength(1);
    expect(gateway.calls.filter((c) => c.method === "createRefund")).toHaveLength(1);
    expect(gateway.refunds()).toHaveLength(1);
    await expectAccounting(scenario);
  });

  it("many concurrent workers never submit twice", async () => {
    const {scenario, gateway, clock} = await setup();

    const results = await Promise.all(Array.from({length: 6}, () => submit(scenario, gateway, clock)));

    expect(results.filter((r) => r.kind === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "leased" || r.kind === "not_due")).toHaveLength(5);
    expect(gateway.refunds()).toHaveLength(1);
    expect(await loadRefund(scenario)).toMatchObject({submitAttempts: 1, status: "pending"});
  });

  it("while a lease is held a second worker is turned away without a provider call", async () => {
    const {scenario, gateway, clock} = await setup({refund: {
      submitAttempts: 1,
      submitLeaseExpiresAt: Timestamp.fromMillis(manualClock().now().toMillis() + 30_000),
    }});

    expect(await submit(scenario, gateway, clock)).toEqual({kind: "leased"});
    expect(gateway.calls).toEqual([]);
  });

  it("an EXPIRED lease is not a failure: the refund stays requested, and the next worker looks it up first", async () => {
    // A worker created the refund at the provider, then died holding its lease.
    const {scenario, gateway, clock} = await setup({refund: {
      submitAttempts: 1,
      submitLeaseExpiresAt: Timestamp.fromMillis(manualClock().now().toMillis() - 1),
    }});
    await gateway.createRefund({
      providerPaymentId: scenario.providerPaymentId, amountInPaise: AMOUNT, speed: "normal",
      idempotencyKey: scenario.loc.refundId, receipt: scenario.loc.refundId,
      notes: {zestoRefundId: scenario.loc.refundId, zestoOrderId: scenario.orderId},
    });
    expect(await loadRefund(scenario)).toMatchObject({status: "requested"});

    const result = await submit(scenario, gateway, clock);

    expect(result).toMatchObject({kind: "applied", via: "lookup", result: {to: "pending"}});
    // One create call in total (the test's own): the worker adopted, it did not send a second.
    expect(gateway.calls.filter((c) => c.method === "createRefund")).toHaveLength(1);
    expect(gateway.refunds()).toHaveLength(1);
    await expectAccounting(scenario);
  });

  it("a late result from a worker whose lease was taken over is superseded, not applied", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", "rate_limited");
    // While the first worker is inside its provider call, its lease expires and a second worker takes over.
    const original = gateway.createRefund.bind(gateway);
    let takeover: Promise<unknown> | undefined;
    gateway.createRefund = async (input) => {
      if (takeover === undefined) {
        clock.advance(REFUND_LEASE_MS + 1);
        takeover = submitRefund(db, createFakeRefundGatewayWithPayment(scenario), scenario.loc, {now: clock.now});
        await takeover;
      }
      return original(input);
    };

    const first = await submit(scenario, gateway, clock);

    expect(first).toEqual({kind: "superseded"});
    await expectAccounting(scenario);
  });
});

function createFakeRefundGatewayWithPayment(scenario: Scenario) {
  const gateway = createFakeRefundGateway();
  gateway.addPayment(providerPaymentFor(scenario));
  // The second worker's provider is unreachable: it records an inconclusive attempt and takes the lease.
  gateway.script("listPaymentRefunds", "rate_limited");
  return gateway;
}

describe("submitRefund — ambiguous and failing provider outcomes stay recoverable", () => {
  it("a timeout whose request WAS applied: stays requested, then the lookup adopts it without a second create", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", "unknown_after_apply");

    const first = await submit(scenario, gateway, clock);

    expect(first).toEqual({kind: "deferred", reason: "outcome_unknown", exhausted: false});
    let refund = await loadRefund(scenario);
    expect(refund).toMatchObject({status: "requested", lastSubmitOutcome: "unknown", submitAttempts: 1, attentionRequired: false});
    expect(refund.submitLeaseExpiresAt).toBeUndefined();
    expect((refund.nextAttemptAt as Timestamp).toMillis()).toBe(clock.now().toMillis() + submitBackoffMs(1));
    // The money stays reserved: nothing was released, nothing settled.
    expect((await expectAccounting(scenario)).payment).toMatchObject({refundPendingInPaise: AMOUNT, refundState: "in_progress"});

    // Too early: not due.
    expect(await submit(scenario, gateway, clock)).toEqual({kind: "not_due"});

    clock.advance(submitBackoffMs(1) + 1);
    const second = await submit(scenario, gateway, clock);

    expect(second).toMatchObject({kind: "applied", via: "lookup", result: {to: "pending"}});
    refund = await loadRefund(scenario);
    expect(refund).toMatchObject({status: "pending", providerRefundId: "rfnd_fake_1"});
    expect(refund.failureCode).toBeUndefined();
    expect(gateway.calls.filter((c) => c.method === "createRefund")).toHaveLength(1);
    expect(gateway.refunds()).toHaveLength(1);
    expect((await auditNames(scenario)).transitions).toEqual(["requested_to_pending"]);
    await expectAccounting(scenario);
  });

  it("a timeout whose request was NOT applied: the lookup finds nothing, then ONE create with the same key succeeds", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", "unknown_before_apply");

    await submit(scenario, gateway, clock);
    clock.advance(submitBackoffMs(1) + 1);
    const second = await submit(scenario, gateway, clock);

    expect(second).toMatchObject({kind: "applied", via: "create", result: {to: "pending"}});
    const calls = gateway.calls.map((c) => c.method);
    expect(calls).toEqual(["createRefund", "listPaymentRefunds", "createRefund"]);
    const keys = gateway.calls.filter((c) => c.method === "createRefund")
      .map((c) => (c.input as {idempotencyKey: string}).idempotencyKey);
    expect(keys).toEqual([scenario.loc.refundId, scenario.loc.refundId]);
    expect(gateway.refunds()).toHaveLength(1);
    expect(await loadRefund(scenario)).toMatchObject({status: "pending", submitAttempts: 2, lastSubmitOutcome: "ok"});
    await expectAccounting(scenario);
  });

  it("every ambiguous flavour (timeout, reset, lost body, duplicate receipt, 5xx) is recoverable, never failed", async () => {
    for (const fault of [
      {unknown: "timeout" as const, applied: false},
      {unknown: "connection_reset" as const, applied: true},
      {unknown: "malformed_response" as const, applied: true},
      "server_error" as const,
      "server_error_after_apply" as const,
    ]) {
      const {scenario, gateway, clock} = await setup();
      gateway.script("createRefund", fault);

      const result = await submit(scenario, gateway, clock);

      expect(result).toMatchObject({kind: "deferred", exhausted: false});
      expect(await loadRefund(scenario)).toMatchObject({status: "requested", attentionRequired: false});
      clock.advance(submitBackoffMs(1) + 1);
      await submit(scenario, gateway, clock);
      expect(await loadRefund(scenario)).toMatchObject({status: "pending"});
      expect(gateway.refunds()).toHaveLength(1);
      await expectAccounting(scenario);
    }
  });

  it("a lookup that itself fails keeps the refund recoverable and does not send another create", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", "unknown_after_apply");
    gateway.script("listPaymentRefunds", "rate_limited", {unknown: "timeout", applied: false});

    await submit(scenario, gateway, clock);
    clock.advance(submitBackoffMs(1) + 1);
    const second = await submit(scenario, gateway, clock);
    expect(second).toEqual({kind: "deferred", reason: "lookup_failed", exhausted: false});
    clock.advance(submitBackoffMs(2) + 1);
    const third = await submit(scenario, gateway, clock);
    expect(third).toEqual({kind: "deferred", reason: "lookup_failed", exhausted: false});
    expect(gateway.calls.filter((c) => c.method === "createRefund")).toHaveLength(1);
    expect(await loadRefund(scenario)).toMatchObject({status: "requested"});

    clock.advance(submitBackoffMs(3) + 1);
    expect(await submit(scenario, gateway, clock)).toMatchObject({kind: "applied", via: "lookup"});
    expect(gateway.refunds()).toHaveLength(1);
    await expectAccounting(scenario);
  });

  it("a retryable failure (429) backs off exponentially and never fails the refund", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", "rate_limited", "rate_limited");

    expect(await submit(scenario, gateway, clock)).toEqual({kind: "deferred", reason: "provider_unavailable", exhausted: false});
    const first = await loadRefund(scenario);
    clock.advance(submitBackoffMs(1) + 1);
    expect(await submit(scenario, gateway, clock)).toEqual({kind: "deferred", reason: "provider_unavailable", exhausted: false});
    const second = await loadRefund(scenario);

    expect(submitBackoffMs(2)).toBe(2 * submitBackoffMs(1));
    expect((second.nextAttemptAt as Timestamp).toMillis() - clock.now().toMillis()).toBe(submitBackoffMs(2));
    expect(first).toMatchObject({status: "requested", failureCode: "rate_limited"});
    await expectAccounting(scenario);
  });

  it("missing/rejected credentials are an operator problem: deferred quietly, never failed, never flagged", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", "auth_failure");

    expect(await submit(scenario, gateway, clock)).toEqual({kind: "deferred", reason: "provider_configuration", exhausted: false});

    expect(await loadRefund(scenario)).toMatchObject({
      status: "requested", attentionRequired: false, failureCode: "provider_auth_rejected",
    });
    // And once the credentials are fixed the same refund goes through.
    clock.advance(60 * 60 * 1000);
    expect(await submit(scenario, gateway, clock)).toMatchObject({kind: "applied"});
    expect(await loadRefund(scenario)).toMatchObject({status: "pending"});
    await expectAccounting(scenario);
  });

  it("after the attempt limit automatic work stops and a person is asked; the refund is still not failed", async () => {
    const {scenario, gateway, clock} = await setup();
    gateway.script("createRefund", ...Array.from({length: MAX_AUTOMATIC_SUBMIT_ATTEMPTS}, () => "unknown_before_apply" as const));
    gateway.script("listPaymentRefunds", ...Array.from({length: MAX_AUTOMATIC_SUBMIT_ATTEMPTS}, () => "rate_limited" as const));

    let last;
    for (let i = 0; i < MAX_AUTOMATIC_SUBMIT_ATTEMPTS; i++) {
      last = await submit(scenario, gateway, clock);
      clock.advance(2 * 60 * 60 * 1000);
    }

    expect(last).toMatchObject({kind: "deferred", exhausted: true});
    const refund = await loadRefund(scenario);
    expect(refund).toMatchObject({status: "requested", attentionRequired: true});
    expect(refund.nextAttemptAt).toBeUndefined();
    const state = await expectAccounting(scenario);
    expect(state.payment.refundState).toBe("attention_required");
    expect(state.order.refundStatus).toBe("attention_required");
    expect((await auditNames(scenario)).anomalies.some((name) => name.startsWith("attempts_exhausted_"))).toBe(true);
    expect(await submit(scenario, gateway, clock)).toEqual({kind: "attention_required"});
  });

  it("Zesto's own bad request (invalid_input / idempotency key conflict) is flagged for a person, NOT recorded as a failed refund", async () => {
    for (const code of ["invalid_input", "idempotency_key_conflict"]) {
      const {scenario, gateway, clock} = await setup();
      gateway.script("createRefund", {rejectWith: code});

      expect(await submit(scenario, gateway, clock)).toEqual({kind: "flagged", code: "zesto_side_request_error"});

      expect(await loadRefund(scenario)).toMatchObject({status: "requested", attentionRequired: true});
      expect((await expectAccounting(scenario)).payment).toMatchObject({refundPendingInPaise: AMOUNT});
    }
  });
});

describe("submitRefund — lookup-before-retry matching", () => {
  async function previouslyAttempted() {
    return setup({refund: {submitAttempts: 1, lastSubmitOutcome: "unknown", nextAttemptAt: Timestamp.fromMillis(0)}});
  }

  it("never adopts on amount alone: a same-amount refund with no Zesto identifier flags the refund and sends nothing", async () => {
    const {scenario, gateway, clock} = await previouslyAttempted();
    // A manual dashboard refund carries no receipt and no notes.
    const listSpy = vi.spyOn(gateway, "listPaymentRefunds").mockResolvedValue([{
      id: "rfnd_manual_1", providerPaymentId: scenario.providerPaymentId, amountInPaise: AMOUNT, currency: "INR",
      status: "processed", notes: {},
    }]);

    const result = await submit(scenario, gateway, clock);

    expect(result).toEqual({kind: "flagged", code: "unattributed_same_amount_refund"});
    listSpy.mockRestore();
    expect(gateway.calls.filter((c) => c.method === "createRefund" && (c.input as {receipt: string}).receipt === scenario.loc.refundId)).toHaveLength(0);
    expect(await loadRefund(scenario)).toMatchObject({status: "requested", attentionRequired: true});
    await expectAccounting(scenario);
  });

  it("two provider refunds that both carry Zesto's identifier are a conflict: flagged, none adopted", async () => {
    const {scenario, gateway, clock} = await previouslyAttempted();
    const one = {
      id: "rfnd_a", providerPaymentId: scenario.providerPaymentId, amountInPaise: AMOUNT, currency: "INR",
      status: "pending" as const, receipt: scenario.loc.refundId, notes: {},
    };
    vi.spyOn(gateway, "listPaymentRefunds").mockResolvedValue([one, {...one, id: "rfnd_b"}]);

    expect(await submit(scenario, gateway, clock)).toEqual({kind: "flagged", code: "conflicting_provider_refunds"});

    expect(await loadRefund(scenario)).toMatchObject({status: "requested", attentionRequired: true});
    expect(gateway.calls.filter((c) => c.method === "createRefund")).toHaveLength(0);
  });

  it("a provider refund of a different amount with no Zesto identifier is adopted as external while this one proceeds", async () => {
    const {scenario, gateway, clock} = await setup({
      amount: 20000, pendingInPaise: 5000,
      refund: {amountInPaise: 5000, submitAttempts: 1, lastSubmitOutcome: "unknown", nextAttemptAt: Timestamp.fromMillis(0)},
    });
    gateway.addPayment({...providerPaymentFor(scenario), id: scenario.providerPaymentId});
    vi.spyOn(gateway, "listPaymentRefunds").mockResolvedValue([{
      id: "rfnd_manual_2", providerPaymentId: scenario.providerPaymentId, amountInPaise: 7000, currency: "INR",
      status: "processed", notes: {},
    }]);

    const result = await submit(scenario, gateway, clock);

    expect(result).toMatchObject({kind: "applied", via: "create"});
    const state = await expectAccounting(scenario);
    expect(Object.keys(state.refunds)).toHaveLength(2);
    const external = Object.values(state.refunds).find((r) => r.reason === "external");
    expect(external).toMatchObject({
      source: "reconciliation", status: "processed", amountInPaise: 7000, attentionRequired: true, providerRefundId: "rfnd_manual_2",
    });
    // Aggregates: this refund (5000) pending, the external one (7000) refunded; nothing exceeds captured.
    expect(state.payment).toMatchObject({refundedAmountInPaise: 7000, refundPendingInPaise: 5000, refundState: "attention_required"});
    // Adopting a refund never cancels or reopens the order.
    expect(state.order.status).toBe("cancelled");
  });
});

describe("submitRefund — a webhook racing the submitter", () => {
  it("the webhook beats the API response: the later response becomes a no-op and money moves exactly once", async () => {
    const {scenario, gateway, clock} = await setup();
    const original = gateway.createRefund.bind(gateway);
    gateway.createRefund = async (input) => {
      const created = await original(input);
      // The provider's `refund.processed` webhook is applied while the response is still "in flight".
      await applyRefundEvidence(db, scenario.loc, {
        kind: "provider_refund", source: "webhook", providerEventKey: "evt_early",
        providerRefund: {...created, status: "processed"},
      }, clock.now());
      return created; // the slower response still says pending
    };

    const result = await submit(scenario, gateway, clock);

    expect(result).toMatchObject({kind: "applied", via: "create", result: {kind: "noop", reason: "stale_event"}});
    expect(await loadRefund(scenario)).toMatchObject({status: "processed", lastWebhookEventKey: "evt_early"});
    const state = await expectAccounting(scenario);
    expect(state.payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0});
    expect((await auditNames(scenario)).transitions).toEqual(["requested_to_processed"]);
  });

  it("a rejection that arrives after the provider already accepted the refund is an anomaly, never a failure", async () => {
    const {scenario, clock} = await setup({refundStatus: "pending", pendingInPaise: AMOUNT});

    const result = await applyRefundEvidence(db, scenario.loc, {
      kind: "definitive_rejection", code: "x", message: "late", source: "submit",
    }, clock.now());

    expect(result).toEqual({kind: "anomaly", code: "rejection_after_provider_acceptance"});
    expect(await loadRefund(scenario)).toMatchObject({status: "pending", attentionRequired: true});
    await expectAccounting(scenario);
  });
});

describe("submitRefund — a pending refund is synced, not re-created", () => {
  it("pending -> processed on lookup", async () => {
    const {scenario, gateway, clock} = await setup();
    await submit(scenario, gateway, clock);
    const providerRefundId = (await loadRefund(scenario)).providerRefundId as string;
    gateway.settleRefund(providerRefundId, "processed");
    clock.advance(7 * 60 * 60 * 1000);

    const result = await submit(scenario, gateway, clock);

    expect(result).toMatchObject({kind: "applied", via: "status_sync", result: {from: "pending", to: "processed"}});
    const state = await expectAccounting(scenario);
    expect(state.payment).toMatchObject({refundedAmountInPaise: AMOUNT, refundPendingInPaise: 0});
    expect(gateway.calls.filter((c) => c.method === "createRefund")).toHaveLength(1);
    expect((await auditNames(scenario)).transitions).toEqual(["pending_to_processed", "requested_to_pending"]);
  });

  it("pending -> failed on lookup releases the money and flags it", async () => {
    const {scenario, gateway, clock} = await setup();
    await submit(scenario, gateway, clock);
    gateway.settleRefund((await loadRefund(scenario)).providerRefundId as string, "failed");
    clock.advance(7 * 60 * 60 * 1000);

    await submit(scenario, gateway, clock);

    expect(await loadRefund(scenario)).toMatchObject({status: "failed", attentionRequired: true});
    expect((await expectAccounting(scenario)).payment).toMatchObject({refundPendingInPaise: 0, refundedAmountInPaise: 0});
  });

  it("still pending: gives the lease back and looks again later without counting an attempt", async () => {
    const {scenario, gateway, clock} = await setup();
    await submit(scenario, gateway, clock);
    clock.advance(7 * 60 * 60 * 1000);

    const result = await submit(scenario, gateway, clock);

    expect(result).toMatchObject({kind: "applied", via: "status_sync", result: {kind: "noop"}});
    const refund = await loadRefund(scenario);
    expect(refund.submitLeaseExpiresAt).toBeUndefined();
    expect(refund.submitAttempts).toBe(1);
    expect((refund.nextAttemptAt as Timestamp).toMillis()).toBeGreaterThan(clock.now().toMillis());
  });

  it("a failing status lookup of a pending refund is recoverable and never changes it", async () => {
    const {scenario, gateway, clock} = await setup();
    await submit(scenario, gateway, clock);
    gateway.script("fetchRefund", "server_error");
    clock.advance(7 * 60 * 60 * 1000);

    expect(await submit(scenario, gateway, clock)).toEqual({kind: "deferred", reason: "lookup_failed", exhausted: false});
    expect(await loadRefund(scenario)).toMatchObject({status: "pending"});
    await expectAccounting(scenario);
  });
});

describe("submitBackoffMs", () => {
  it("doubles from one minute up to a one-hour cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map(submitBackoffMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    expect(submitBackoffMs(0)).toBe(60_000);
  });
});

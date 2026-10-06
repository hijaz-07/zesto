// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {RefundAmountError, type RefundAggregates} from "./refundAmounts";
import {
  PROVIDER_REFUND_STATUS_VALUES,
  REFUND_PROVIDER_SPEED,
  REFUND_REASON_VALUES,
  REFUND_SOURCE_VALUES,
  REFUND_STATUS_VALUES,
  TERMINAL_REFUND_STATUSES,
  aggregatesAfterRefundTransition,
  decideRefundTransition,
  isTerminalRefundStatus,
  parseRefund,
  parseRefundId,
  planRefundTransition,
  refundIdFor,
  refundIdempotencyKeyFor,
  type ProviderRefundStatus,
  type Refund,
  type RefundStatus,
  type RefundTransitionDecision,
  type RefundTransitionEvidence,
} from "./refunds";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
const MENU_ID = "menu-1";
const ORDER_ID = "order-1";
const PAYMENT_ID = "order-1";
const AT = Timestamp.fromDate(new Date("2026-09-27T10:00:00Z"));

function refund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: "order-1-r1",
    paymentId: PAYMENT_ID,
    orderId: ORDER_ID,
    organizationId: ORG_ID,
    outletId: OUTLET_ID,
    menuId: MENU_ID,
    userId: "U-customer",
    providerPaymentId: "pay_Test1",
    amountInPaise: 24000,
    currency: "INR",
    status: "requested",
    reason: "customer_cancelled",
    source: "cancellation",
    initiatedBy: "U-customer",
    initiatedByRole: "customer",
    idempotencyKey: "order-1-r1",
    submitAttempts: 0,
    createdAt: AT,
    updatedAt: AT,
    attentionRequired: false,
    ...overrides,
  };
}

function parse(data: unknown, id = "order-1-r1"): Refund {
  return parseRefund(data, id, PAYMENT_ID, ORDER_ID, ORG_ID, OUTLET_ID, MENU_ID);
}

const pending = (): Refund => refund({status: "pending", providerRefundId: "rfnd_1", providerStatus: "pending", pendingAt: AT});
const processed = (): Refund => refund({status: "processed", providerRefundId: "rfnd_1", providerStatus: "processed", processedAt: AT});
const failed = (): Refund => refund({status: "failed", failedAt: AT, failureCode: "BAD_REQUEST_ERROR"});

describe("constants", () => {
  it("has exactly the four approved refund statuses", () => {
    expect([...REFUND_STATUS_VALUES]).toEqual(["requested", "pending", "processed", "failed"]);
  });

  it("has the approved reasons, at minimum the required five", () => {
    expect([...REFUND_REASON_VALUES]).toEqual([
      "customer_cancelled", "outlet_cancelled", "system_cancelled", "late_capture_after_cancel", "external",
    ]);
  });

  it("has exactly the approved sources", () => {
    expect([...REFUND_SOURCE_VALUES]).toEqual(["cancellation", "retry", "reconciliation"]);
  });

  it("mirrors the provider's three statuses and uses the normal refund speed", () => {
    expect([...PROVIDER_REFUND_STATUS_VALUES]).toEqual(["pending", "processed", "failed"]);
    expect(REFUND_PROVIDER_SPEED).toBe("normal");
  });

  it("treats processed and failed as terminal, and nothing else", () => {
    expect([...TERMINAL_REFUND_STATUSES]).toEqual(["processed", "failed"]);
    expect(REFUND_STATUS_VALUES.filter(isTerminalRefundStatus)).toEqual(["processed", "failed"]);
  });
});

describe("deterministic IDs", () => {
  it("builds ${orderId}-r${seq}", () => {
    expect(refundIdFor("order-1", 1)).toBe("order-1-r1");
    expect(refundIdFor("Xq3kP9aLm2NvB7tYw1Zc", 12)).toBe("Xq3kP9aLm2NvB7tYw1Zc-r12");
  });

  it("is deterministic: the same input always gives the same ID", () => {
    expect(refundIdFor("order-1", 3)).toBe(refundIdFor("order-1", 3));
  });

  it("gives a different ID for a different sequence number", () => {
    expect(refundIdFor("order-1", 1)).not.toBe(refundIdFor("order-1", 2));
    expect(refundIdFor("order-1", 1)).not.toBe(refundIdFor("order-1", 11));
  });

  it("gives a different ID for a different order", () => {
    expect(refundIdFor("order-1", 1)).not.toBe(refundIdFor("order-2", 1));
  });

  it("never collides, even for order IDs that themselves look like refund IDs", () => {
    const orderIds = ["a", "a-r", "a-r1", "a-r1-r2", "r1", "order-1", "order-1-r1", "x-r11", "x-r1"];
    const seen = new Map<string, string>();
    for (const orderId of orderIds) {
      for (let seq = 1; seq <= 12; seq++) {
        const id = refundIdFor(orderId, seq);
        expect(seen.has(id), `${id} for (${orderId}, ${seq}) collides with ${seen.get(id)}`).toBe(false);
        seen.set(id, `(${orderId}, ${seq})`);
        expect(parseRefundId(id)).toEqual({orderId, seq});
      }
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1" as unknown as number])(
    "rejects an invalid sequence number (%j)", (seq) => {
      expect(() => refundIdFor("order-1", seq)).toThrow();
    });

  it.each(["", "a/b", ".", "..", "__x__"])("rejects an invalid order ID (%j)", (orderId) => {
    expect(() => refundIdFor(orderId, 1)).toThrow();
  });

  it("parses an ID back, and rejects anything not in the form", () => {
    expect(parseRefundId("order-1-r7")).toEqual({orderId: "order-1", seq: 7});
    for (const bad of ["order-1", "order-1-r0", "order-1-r", "-r1", "order-1-r01", "order-1-rx", ""]) {
      expect(parseRefundId(bad), bad).toBeNull();
    }
  });

  it("uses the refund ID itself as the idempotency key", () => {
    const id = refundIdFor("Xq3kP9aLm2NvB7tYw1Zc", 1);
    expect(refundIdempotencyKeyFor(id)).toBe(id);
    expect(refundIdempotencyKeyFor(id)).toBe(refundIdempotencyKeyFor(refundIdFor("Xq3kP9aLm2NvB7tYw1Zc", 1)));
  });

  it("gives different refunds different keys", () => {
    expect(refundIdempotencyKeyFor(refundIdFor("order-1", 1))).not.toBe(refundIdempotencyKeyFor(refundIdFor("order-1", 2)));
  });

  it("accepts a key of exactly 10 characters and refuses one of 9", () => {
    expect(refundIdempotencyKeyFor("order-1-r1")).toBe("order-1-r1");
    expect("order-1-r1").toHaveLength(10);
    expect(() => refundIdempotencyKeyFor("order-1-r")).toThrow();
    expect(() => refundIdempotencyKeyFor("o-1-r1")).toThrow();
  });

  it("refuses an ID outside the provider's alphabet instead of mangling it", () => {
    for (const bad of ["order.0001-r1", "order 0001-r1", "ordér-0001-r1", "order/0001-r1"]) {
      expect(() => refundIdempotencyKeyFor(bad), bad).toThrow();
    }
  });
});

describe("parseRefund", () => {
  it("parses a well-formed requested refund", () => {
    const parsed = parse(refund());
    expect(parsed.status).toBe("requested");
    expect(parsed.amountInPaise).toBe(24000);
    expect(parsed.attentionRequired).toBe(false);
  });

  it("parses a refund in each other status", () => {
    expect(parse(pending()).status).toBe("pending");
    expect(parse(processed()).status).toBe("processed");
    expect(parse(failed()).status).toBe("failed");
  });

  it("parses a refund carrying the full submission and webhook metadata", () => {
    const parsed = parse(refund({
      status: "pending",
      providerRefundId: "rfnd_1",
      providerStatus: "pending",
      providerSpeedRequested: "normal",
      providerSpeedProcessed: "normal",
      pendingAt: AT,
      submitAttempts: 3,
      lastSubmitAt: AT,
      lastSubmitOutcome: "unknown",
      submitLeaseExpiresAt: AT,
      nextAttemptAt: AT,
      lastWebhookEventKey: "evt_abc",
    }));
    expect(parsed.submitAttempts).toBe(3);
    expect(parsed.lastSubmitOutcome).toBe("unknown");
    expect(parsed.lastWebhookEventKey).toBe("evt_abc");
  });

  it("parses a failed refund with failure metadata, with or without a provider refund ID", () => {
    expect(parse(refund({status: "failed", failedAt: AT, failureCode: "X", failureMessage: "No."})).failureCode).toBe("X");
    expect(parse(refund({status: "failed", failedAt: AT, providerRefundId: "rfnd_9", providerStatus: "failed"})).providerRefundId)
      .toBe("rfnd_9");
  });

  it("parses an adopted external refund", () => {
    const parsed = parse(refund({
      reason: "external", source: "reconciliation", initiatedBy: "system", initiatedByRole: "system",
      status: "processed", providerRefundId: "rfnd_ext", processedAt: AT, attentionRequired: true,
    }));
    expect(parsed.reason).toBe("external");
    expect(parsed.attentionRequired).toBe(true);
  });

  it.each([
    ["id", "order-1-r2"],
    ["paymentId", "payment-other"],
    ["orderId", "order-other"],
    ["organizationId", "org-other"],
    ["outletId", "outlet-other"],
    ["menuId", "menu-other"],
  ])("throws when the stored %s does not match the path it was read from", (field, value) => {
    expect(() => parse(refund({[field]: value} as Partial<Refund>))).toThrow(/Malformed refund document/);
  });

  it("throws when the ID does not encode the order, or the key is not the ID", () => {
    expect(() => parse(refund({id: "order-2-r1", idempotencyKey: "order-2-r1"}), "order-2-r1")).toThrow();
    expect(() => parse(refund({id: "garbage", idempotencyKey: "garbage"}), "garbage")).toThrow();
    expect(() => parse(refund({idempotencyKey: "something-else-1"}))).toThrow();
  });

  it("throws for a malformed document", () => {
    expect(() => parse({not: "a refund"})).toThrow();
    expect(() => parse(null)).toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an amount of %j", (amountInPaise) => {
    expect(() => parse(refund({amountInPaise}))).toThrow();
  });

  it("accepts the smallest and the largest safe amounts", () => {
    expect(parse(refund({amountInPaise: 1})).amountInPaise).toBe(1);
    expect(parse(refund({amountInPaise: Number.MAX_SAFE_INTEGER})).amountInPaise).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a currency other than INR, and unknown enum values", () => {
    expect(() => parse({...refund(), currency: "USD"})).toThrow();
    expect(() => parse({...refund(), status: "refunded"})).toThrow();
    expect(() => parse({...refund(), reason: "because"})).toThrow();
    expect(() => parse({...refund(), source: "manual"})).toThrow();
    expect(() => parse({...refund(), initiatedByRole: "staff"})).toThrow();
    expect(() => parse({...refund(), lastSubmitOutcome: "timeout"})).toThrow();
  });

  it("requires attentionRequired and submitAttempts", () => {
    const withoutAttention: Record<string, unknown> = {...refund()};
    delete withoutAttention.attentionRequired;
    expect(() => parse(withoutAttention)).toThrow();
    const withoutAttempts: Record<string, unknown> = {...refund()};
    delete withoutAttempts.submitAttempts;
    expect(() => parse(withoutAttempts)).toThrow();
    expect(() => parse(refund({submitAttempts: -1}))).toThrow();
    expect(() => parse(refund({submitAttempts: 1.5}))).toThrow();
  });

  it("rejects a failure message over the bound, and an empty one", () => {
    expect(() => parse(refund({status: "failed", failedAt: AT, failureMessage: "x".repeat(301)}))).toThrow();
    expect(() => parse(refund({status: "failed", failedAt: AT, failureMessage: "x".repeat(300)}))).not.toThrow();
    expect(() => parse(refund({status: "failed", failedAt: AT, failureMessage: ""}))).toThrow();
  });

  describe("status coherence", () => {
    it("a requested refund has no provider refund ID and no settlement timestamps", () => {
      expect(() => parse(refund({providerRefundId: "rfnd_1"}))).toThrow();
      expect(() => parse(refund({pendingAt: AT}))).toThrow();
      expect(() => parse(refund({processedAt: AT}))).toThrow();
      expect(() => parse(refund({failedAt: AT}))).toThrow();
    });

    it("a pending refund needs its provider refund ID and pendingAt, and is not settled", () => {
      expect(() => parse(refund({status: "pending", pendingAt: AT}))).toThrow();
      expect(() => parse(refund({status: "pending", providerRefundId: "rfnd_1"}))).toThrow();
      expect(() => parse({...pending(), processedAt: AT})).toThrow();
      expect(() => parse({...pending(), failedAt: AT})).toThrow();
    });

    it("a processed refund needs its provider refund ID and processedAt, and has not failed", () => {
      expect(() => parse(refund({status: "processed", processedAt: AT}))).toThrow();
      expect(() => parse(refund({status: "processed", providerRefundId: "rfnd_1"}))).toThrow();
      expect(() => parse({...processed(), failedAt: AT})).toThrow();
    });

    it("a processed refund may skip pending (the webhook that beat the API response)", () => {
      expect(processed().pendingAt).toBeUndefined();
      expect(() => parse(processed())).not.toThrow();
    });

    it("a failed refund needs failedAt and has not been processed", () => {
      expect(() => parse(refund({status: "failed"}))).toThrow();
      expect(() => parse({...failed(), processedAt: AT})).toThrow();
    });
  });
});

describe("decideRefundTransition: every current status against every kind of evidence", () => {
  type Cell = RefundTransitionDecision;
  const apply = (from: RefundStatus, to: Exclude<RefundStatus, "requested">): Cell => ({outcome: "apply", from, to});
  const noop = (reason: "already_in_state" | "stale_event"): Cell => ({outcome: "noop", reason});
  const reject = (code: string, anomaly: boolean): Cell =>
    ({outcome: "reject", code, anomaly} as Cell);

  const evidence = {
    pending: {kind: "provider_status", providerStatus: "pending"},
    processed: {kind: "provider_status", providerStatus: "processed"},
    failed: {kind: "provider_status", providerStatus: "failed"},
    rejection: {kind: "definitive_rejection"},
    unknown: {kind: "unknown_outcome"},
  } as const satisfies Record<string, RefundTransitionEvidence>;

  const table: Record<RefundStatus, Record<keyof typeof evidence, Cell>> = {
    requested: {
      pending: apply("requested", "pending"),
      processed: apply("requested", "processed"),
      failed: apply("requested", "failed"),
      rejection: apply("requested", "failed"),
      unknown: reject("insufficient_evidence", false),
    },
    pending: {
      pending: noop("already_in_state"),
      processed: apply("pending", "processed"),
      failed: apply("pending", "failed"),
      rejection: reject("rejection_not_applicable", true),
      unknown: reject("insufficient_evidence", false),
    },
    processed: {
      pending: noop("stale_event"),
      processed: noop("already_in_state"),
      failed: reject("processed_is_terminal", true),
      rejection: reject("rejection_not_applicable", true),
      unknown: reject("insufficient_evidence", false),
    },
    failed: {
      pending: noop("stale_event"),
      processed: reject("failed_is_terminal", true),
      failed: noop("already_in_state"),
      rejection: noop("already_in_state"),
      unknown: reject("insufficient_evidence", false),
    },
  };

  for (const current of REFUND_STATUS_VALUES) {
    for (const key of Object.keys(evidence) as (keyof typeof evidence)[]) {
      it(`${current} + ${key}`, () => {
        expect(decideRefundTransition(current, evidence[key])).toEqual(table[current][key]);
      });
    }
  }

  it("accepts exactly the five approved moves, and no others", () => {
    const applied: string[] = [];
    for (const current of REFUND_STATUS_VALUES) {
      for (const status of PROVIDER_REFUND_STATUS_VALUES) {
        const decision = decideRefundTransition(current, {kind: "provider_status", providerStatus: status});
        if (decision.outcome === "apply") {
          applied.push(`${decision.from}->${decision.to}`);
        }
      }
      const rejection = decideRefundTransition(current, {kind: "definitive_rejection"});
      if (rejection.outcome === "apply") {
        applied.push(`${rejection.from}->${rejection.to}`);
      }
    }
    expect(new Set(applied)).toEqual(new Set([
      "requested->pending", "requested->processed", "requested->failed", "pending->processed", "pending->failed",
    ]));
  });

  it("never moves out of a terminal status, whatever the evidence", () => {
    for (const current of ["processed", "failed"] as const) {
      for (const status of PROVIDER_REFUND_STATUS_VALUES) {
        expect(decideRefundTransition(current, {kind: "provider_status", providerStatus: status}).outcome).not.toBe("apply");
      }
      expect(decideRefundTransition(current, {kind: "definitive_rejection"}).outcome).not.toBe("apply");
      expect(decideRefundTransition(current, {kind: "unknown_outcome"}).outcome).not.toBe("apply");
    }
  });

  it("NEVER accepts processed -> failed, and flags it as an anomaly", () => {
    expect(decideRefundTransition("processed", evidence.failed)).toEqual({
      outcome: "reject", code: "processed_is_terminal", anomaly: true,
    });
  });

  it("NEVER accepts failed -> processed as a normal transition, and flags it as an anomaly", () => {
    expect(decideRefundTransition("failed", evidence.processed)).toEqual({
      outcome: "reject", code: "failed_is_terminal", anomaly: true,
    });
  });

  it("never lets a timeout or lost response (unknown outcome) fail or settle a refund", () => {
    for (const current of REFUND_STATUS_VALUES) {
      expect(decideRefundTransition(current, evidence.unknown)).toMatchObject({outcome: "reject", code: "insufficient_evidence"});
    }
  });

  it("is idempotent: repeated evidence for the state already held changes nothing", () => {
    expect(decideRefundTransition("pending", evidence.pending).outcome).toBe("noop");
    expect(decideRefundTransition("processed", evidence.processed).outcome).toBe("noop");
    expect(decideRefundTransition("failed", evidence.failed).outcome).toBe("noop");
  });

  describe("out-of-order delivery", () => {
    it("a late 'created/pending' event after processing is a harmless no-op, not a regression", () => {
      expect(decideRefundTransition("processed", evidence.pending)).toEqual({outcome: "noop", reason: "stale_event"});
    });

    it("a late 'pending' event after failure is a harmless no-op", () => {
      expect(decideRefundTransition("failed", evidence.pending)).toEqual({outcome: "noop", reason: "stale_event"});
    });

    it("the processed event that beats the API response moves requested straight to processed", () => {
      expect(decideRefundTransition("requested", evidence.processed)).toEqual(apply("requested", "processed"));
    });

    it("events arriving in any order converge: processed then pending then processed ends processed", () => {
      let status: RefundStatus = "requested";
      for (const providerStatus of ["processed", "pending", "processed"] as ProviderRefundStatus[]) {
        const decision = decideRefundTransition(status, {kind: "provider_status", providerStatus});
        if (decision.outcome === "apply") {
          status = decision.to;
        }
      }
      expect(status).toBe("processed");
    });

    it("a failure that arrives after success never un-processes it", () => {
      let status: RefundStatus = "requested";
      for (const providerStatus of ["processed", "failed"] as ProviderRefundStatus[]) {
        const decision = decideRefundTransition(status, {kind: "provider_status", providerStatus});
        if (decision.outcome === "apply") {
          status = decision.to;
        }
      }
      expect(status).toBe("processed");
    });

    it("a success after failure never revives a failed refund", () => {
      let status: RefundStatus = "requested";
      for (const providerStatus of ["failed", "processed"] as ProviderRefundStatus[]) {
        const decision = decideRefundTransition(status, {kind: "provider_status", providerStatus});
        if (decision.outcome === "apply") {
          status = decision.to;
        }
      }
      expect(status).toBe("failed");
    });
  });
});

describe("aggregatesAfterRefundTransition", () => {
  const start: RefundAggregates = {capturedInPaise: 24000, refundedInPaise: 0, refundPendingInPaise: 24000};

  it("requested -> pending moves no money", () => {
    expect(aggregatesAfterRefundTransition(start, 24000, "requested", "pending")).toEqual(start);
  });

  it("requested -> processed and pending -> processed settle the reservation", () => {
    const expected = {capturedInPaise: 24000, refundedInPaise: 24000, refundPendingInPaise: 0};
    expect(aggregatesAfterRefundTransition(start, 24000, "requested", "processed")).toEqual(expected);
    expect(aggregatesAfterRefundTransition(start, 24000, "pending", "processed")).toEqual(expected);
  });

  it("requested -> failed and pending -> failed release the reservation", () => {
    const expected = {capturedInPaise: 24000, refundedInPaise: 0, refundPendingInPaise: 0};
    expect(aggregatesAfterRefundTransition(start, 24000, "requested", "failed")).toEqual(expected);
    expect(aggregatesAfterRefundTransition(start, 24000, "pending", "failed")).toEqual(expected);
  });

  it("is not defined for a move that is not a transition", () => {
    expect(() => aggregatesAfterRefundTransition(start, 24000, "processed", "failed")).toThrow(/Not a refund transition/);
    expect(() => aggregatesAfterRefundTransition(start, 24000, "failed", "processed")).toThrow(/Not a refund transition/);
    expect(() => aggregatesAfterRefundTransition(start, 24000, "pending", "pending")).toThrow(/Not a refund transition/);
  });

  it("refuses to settle more than was reserved", () => {
    expect(() => aggregatesAfterRefundTransition(start, 24001, "pending", "processed")).toThrow(RefundAmountError);
  });
});

describe("planRefundTransition: the decision and its money agree", () => {
  const aggregates: RefundAggregates = {capturedInPaise: 24000, refundedInPaise: 0, refundPendingInPaise: 24000};
  const base = {amountInPaise: 24000, aggregates};

  it("moves the money exactly when it applies a transition", () => {
    const plan = planRefundTransition({...base, current: "pending", evidence: {kind: "provider_status", providerStatus: "processed"}});
    expect(plan.decision).toEqual({outcome: "apply", from: "pending", to: "processed"});
    expect(plan.aggregates).toEqual({capturedInPaise: 24000, refundedInPaise: 24000, refundPendingInPaise: 0});
  });

  it("releases the reservation when a refund is confirmed failed", () => {
    const plan = planRefundTransition({...base, current: "pending", evidence: {kind: "provider_status", providerStatus: "failed"}});
    expect(plan.aggregates).toEqual({capturedInPaise: 24000, refundedInPaise: 0, refundPendingInPaise: 0});
  });

  it("releases the reservation on a definitive rejection of a requested refund", () => {
    const plan = planRefundTransition({...base, current: "requested", evidence: {kind: "definitive_rejection"}});
    expect(plan.decision).toEqual({outcome: "apply", from: "requested", to: "failed"});
    expect(plan.aggregates.refundPendingInPaise).toBe(0);
  });

  it("leaves the money alone for a no-op, a rejection, and an unknown outcome", () => {
    const cases: [RefundStatus, RefundTransitionEvidence][] = [
      ["pending", {kind: "provider_status", providerStatus: "pending"}],
      ["processed", {kind: "provider_status", providerStatus: "failed"}],
      ["failed", {kind: "provider_status", providerStatus: "processed"}],
      ["requested", {kind: "unknown_outcome"}],
    ];
    for (const [current, evidence] of cases) {
      const plan = planRefundTransition({...base, current, evidence});
      expect(plan.decision.outcome).not.toBe("apply");
      expect(plan.aggregates).toBe(aggregates);
    }
  });

  it("a duplicate processed event never settles the money twice", () => {
    const first = planRefundTransition({...base, current: "pending", evidence: {kind: "provider_status", providerStatus: "processed"}});
    const second = planRefundTransition({
      current: "processed", amountInPaise: 24000, aggregates: first.aggregates,
      evidence: {kind: "provider_status", providerStatus: "processed"},
    });
    expect(second.decision).toEqual({outcome: "noop", reason: "already_in_state"});
    expect(second.aggregates).toEqual({capturedInPaise: 24000, refundedInPaise: 24000, refundPendingInPaise: 0});
  });

  it("a late failure after processing leaves refunded money untouched", () => {
    const settled: RefundAggregates = {capturedInPaise: 24000, refundedInPaise: 24000, refundPendingInPaise: 0};
    const plan = planRefundTransition({
      current: "processed", amountInPaise: 24000, aggregates: settled,
      evidence: {kind: "provider_status", providerStatus: "failed"},
    });
    expect(plan.decision).toMatchObject({outcome: "reject", anomaly: true});
    expect(plan.aggregates).toBe(settled);
  });
});

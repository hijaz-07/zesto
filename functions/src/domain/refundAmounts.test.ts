// @vitest-environment node
import {describe, expect, it} from "vitest";
import {
  RefundAmountError,
  assertRefundAggregates,
  assessPaymentRefundability,
  capturedAmountInPaise,
  checkNewRefundAmount,
  deriveRefundState,
  isMinorUnits,
  readRefundAggregates,
  refundAggregatesProblem,
  releaseFailedRefund,
  remainingRefundableInPaise,
  reserveRefund,
  settleProcessedRefund,
  type PaymentAmountFields,
  type PaymentRefundFacts,
  type RefundAggregates,
} from "./refundAmounts";

const MAX = Number.MAX_SAFE_INTEGER;

function aggregates(captured: number, refunded = 0, pending = 0): RefundAggregates {
  return {capturedInPaise: captured, refundedInPaise: refunded, refundPendingInPaise: pending};
}

function payment(overrides: Partial<PaymentAmountFields> = {}): PaymentAmountFields {
  return {status: "succeeded", amountInPaise: 24000, ...overrides};
}

function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RefundAmountError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("Expected a RefundAmountError.");
}

describe("isMinorUnits", () => {
  it.each([0, 1, 24000, MAX])("accepts %d", (value) => {
    expect(isMinorUnits(value)).toBe(true);
  });

  it.each([-1, -0, 0.5, 1.0000001, NaN, Infinity, -Infinity, MAX + 1, 2 ** 53, "5", null, undefined, {}, [], true])(
    "rejects %j", (value) => {
      expect(isMinorUnits(value)).toBe(false);
    });
});

describe("capturedAmountInPaise (legacy-safe)", () => {
  it("uses the stored captured amount on a succeeded payment", () => {
    expect(capturedAmountInPaise(payment({capturedAmountInPaise: 24000}))).toBe(24000);
  });

  it("treats a legacy succeeded payment with no captured amount as captured in full", () => {
    expect(capturedAmountInPaise(payment())).toBe(24000);
    expect(capturedAmountInPaise(payment({amountInPaise: 1}))).toBe(1);
  });

  it("is 0 for a pending payment: nothing was captured", () => {
    expect(capturedAmountInPaise(payment({status: "pending"}))).toBe(0);
  });

  it("is 0 for a failed payment: nothing was captured", () => {
    expect(capturedAmountInPaise(payment({status: "failed"}))).toBe(0);
  });

  it("rejects an unsafe stored captured amount instead of using it", () => {
    expect(errorCodeOf(() => capturedAmountInPaise(payment({capturedAmountInPaise: 10.5})))).toBe("not_minor_units");
    expect(errorCodeOf(() => capturedAmountInPaise(payment({capturedAmountInPaise: -1})))).toBe("not_minor_units");
    expect(errorCodeOf(() => capturedAmountInPaise(payment({amountInPaise: NaN})))).toBe("not_minor_units");
  });
});

describe("readRefundAggregates", () => {
  it("reads a legacy succeeded payment as fully captured with nothing refunded or pending", () => {
    expect(readRefundAggregates(payment())).toEqual(aggregates(24000, 0, 0));
  });

  it("reads stored figures", () => {
    const read = readRefundAggregates(payment({
      capturedAmountInPaise: 24000, refundedAmountInPaise: 10000, refundPendingInPaise: 4000,
    }));
    expect(read).toEqual(aggregates(24000, 10000, 4000));
  });

  it("reads a never-succeeded payment as all zeros", () => {
    expect(readRefundAggregates(payment({status: "failed"}))).toEqual(aggregates(0, 0, 0));
  });

  it("rejects refunded + pending beyond captured", () => {
    expect(errorCodeOf(() => readRefundAggregates(payment({refundedAmountInPaise: 24000, refundPendingInPaise: 1}))))
      .toBe("invalid_aggregates");
  });

  it("rejects a refunded amount on a payment that captured nothing", () => {
    expect(errorCodeOf(() => readRefundAggregates(payment({status: "pending", refundedAmountInPaise: 1}))))
      .toBe("invalid_aggregates");
  });
});

describe("refundAggregatesProblem", () => {
  it("accepts the all-zero and exactly-full cases", () => {
    expect(refundAggregatesProblem(aggregates(0))).toBeNull();
    expect(refundAggregatesProblem(aggregates(100, 100, 0))).toBeNull();
    expect(refundAggregatesProblem(aggregates(100, 0, 100))).toBeNull();
  });

  it("accepts refunded + pending exactly equal to captured", () => {
    expect(refundAggregatesProblem(aggregates(100, 60, 40))).toBeNull();
    expect(() => assertRefundAggregates(aggregates(100, 60, 40))).not.toThrow();
  });

  it("rejects refunded + pending one paisa over captured", () => {
    expect(refundAggregatesProblem(aggregates(100, 60, 41))).toBe("invalid_aggregates");
    expect(() => assertRefundAggregates(aggregates(100, 60, 41))).toThrow(RefundAmountError);
  });

  it("rejects each figure on its own exceeding captured", () => {
    expect(refundAggregatesProblem(aggregates(100, 101, 0))).toBe("invalid_aggregates");
    expect(refundAggregatesProblem(aggregates(100, 0, 101))).toBe("invalid_aggregates");
  });

  it.each([
    [aggregates(-1)],
    [aggregates(100, -1)],
    [aggregates(100, 0, -1)],
    [aggregates(100.5)],
    [aggregates(100, 0.1)],
    [aggregates(100, 0, 0.1)],
    [aggregates(NaN)],
    [aggregates(Infinity)],
    [aggregates(100, NaN)],
  ])("rejects non-minor-unit figures %j", (bad) => {
    expect(refundAggregatesProblem(bad)).toBe("not_minor_units");
  });

  it("handles the largest safe integer without losing precision", () => {
    expect(refundAggregatesProblem(aggregates(MAX, MAX, 0))).toBeNull();
    expect(refundAggregatesProblem(aggregates(MAX, MAX - 1, 1))).toBeNull();
    expect(refundAggregatesProblem(aggregates(MAX, MAX, 1))).toBe("invalid_aggregates");
    expect(refundAggregatesProblem(aggregates(MAX, MAX - 1, 2))).toBe("invalid_aggregates");
    expect(refundAggregatesProblem(aggregates(MAX + 1))).toBe("not_minor_units");
  });
});

describe("remainingRefundableInPaise", () => {
  it("is captured - refunded - pending", () => {
    expect(remainingRefundableInPaise(aggregates(24000))).toBe(24000);
    expect(remainingRefundableInPaise(aggregates(24000, 10000, 4000))).toBe(10000);
    expect(remainingRefundableInPaise(aggregates(24000, 24000))).toBe(0);
    expect(remainingRefundableInPaise(aggregates(24000, 0, 24000))).toBe(0);
    expect(remainingRefundableInPaise(aggregates(0))).toBe(0);
  });

  it("is the full eligible refund for an untouched payment (what v1 cancellation refunds)", () => {
    expect(remainingRefundableInPaise(readRefundAggregates(payment()))).toBe(24000);
  });

  it("refuses to compute from invalid figures", () => {
    expect(errorCodeOf(() => remainingRefundableInPaise(aggregates(100, 60, 41)))).toBe("invalid_aggregates");
  });
});

describe("checkNewRefundAmount", () => {
  const fresh = aggregates(24000);

  it("accepts an exact full refund", () => {
    expect(checkNewRefundAmount(fresh, 24000)).toEqual({ok: true, remainingAfterInPaise: 0});
  });

  it("accepts the smallest refund, 1 paisa", () => {
    expect(checkNewRefundAmount(fresh, 1)).toEqual({ok: true, remainingAfterInPaise: 23999});
  });

  it("accepts a partial amount (the data model supports it; no customer-facing v1 feature uses it)", () => {
    expect(checkNewRefundAmount(fresh, 10000)).toEqual({ok: true, remainingAfterInPaise: 14000});
  });

  it("accepts a refund of exactly what remains after others", () => {
    expect(checkNewRefundAmount(aggregates(24000, 10000, 4000), 10000)).toEqual({ok: true, remainingAfterInPaise: 0});
  });

  it("rejects zero", () => {
    expect(checkNewRefundAmount(fresh, 0)).toEqual({ok: false, code: "not_positive"});
  });

  it("rejects negative amounts", () => {
    expect(checkNewRefundAmount(fresh, -1)).toEqual({ok: false, code: "not_positive"});
    expect(checkNewRefundAmount(fresh, -24000)).toEqual({ok: false, code: "not_positive"});
  });

  it.each([0.5, 1.5, 100.0001, NaN, Infinity, -Infinity, MAX + 1, 2 ** 60, "100", null, undefined, {}, true])(
    "rejects non-integer or unsafe amount %j", (amount) => {
      expect(checkNewRefundAmount(fresh, amount)).toEqual({ok: false, code: "not_minor_units"});
    });

  it("accepts the largest safe integer only if it fits", () => {
    expect(checkNewRefundAmount(aggregates(MAX), MAX)).toEqual({ok: true, remainingAfterInPaise: 0});
    expect(checkNewRefundAmount(aggregates(24000), MAX)).toEqual({ok: false, code: "exceeds_remaining"});
  });

  it("rejects over-refund by one paisa", () => {
    expect(checkNewRefundAmount(fresh, 24001)).toEqual({ok: false, code: "exceeds_remaining"});
  });

  it("rejects an amount larger than what remains after processed refunds", () => {
    expect(checkNewRefundAmount(aggregates(24000, 10000), 14001)).toEqual({ok: false, code: "exceeds_remaining"});
  });

  it("counts PENDING refunds against what remains: pending + processed exactly equal to captured leaves nothing", () => {
    const full = aggregates(24000, 14000, 10000);
    expect(checkNewRefundAmount(full, 1)).toEqual({ok: false, code: "nothing_refundable"});
  });

  it("reports nothing_refundable, not exceeds_remaining, when everything is already refunded or reserved", () => {
    expect(checkNewRefundAmount(aggregates(24000, 24000), 24000)).toEqual({ok: false, code: "nothing_refundable"});
    expect(checkNewRefundAmount(aggregates(24000, 0, 24000), 24000)).toEqual({ok: false, code: "nothing_refundable"});
  });

  it("cannot refund a payment that captured nothing", () => {
    expect(checkNewRefundAmount(aggregates(0), 1)).toEqual({ok: false, code: "nothing_refundable"});
  });

  it("refuses to proceed on invalid aggregates", () => {
    expect(checkNewRefundAmount(aggregates(100, 60, 41), 1)).toEqual({ok: false, code: "invalid_aggregates"});
    expect(checkNewRefundAmount(aggregates(100.5), 1)).toEqual({ok: false, code: "not_minor_units"});
  });

  it("a refund cannot exceed the remaining amount, for every amount around the boundary", () => {
    const base = aggregates(1000, 300, 200);
    const remaining = remainingRefundableInPaise(base);
    expect(remaining).toBe(500);
    for (let amount = 1; amount <= remaining + 3; amount++) {
      expect(checkNewRefundAmount(base, amount).ok).toBe(amount <= remaining);
    }
  });
});

describe("reserveRefund", () => {
  it("adds the amount to pending, leaving captured and refunded alone", () => {
    expect(reserveRefund(aggregates(24000, 1000, 2000), 5000)).toEqual(aggregates(24000, 1000, 7000));
  });

  it("can reserve everything that remains, landing exactly on captured", () => {
    const after = reserveRefund(aggregates(24000, 14000), 10000);
    expect(after.refundedInPaise + after.refundPendingInPaise).toBe(after.capturedInPaise);
    expect(remainingRefundableInPaise(after)).toBe(0);
  });

  it("does not mutate its input", () => {
    const before = Object.freeze(aggregates(24000));
    expect(() => reserveRefund(before, 100)).not.toThrow();
    expect(before).toEqual(aggregates(24000));
  });

  it("throws the check's code for a disallowed amount", () => {
    expect(errorCodeOf(() => reserveRefund(aggregates(100), 101))).toBe("exceeds_remaining");
    expect(errorCodeOf(() => reserveRefund(aggregates(100), 0))).toBe("not_positive");
    expect(errorCodeOf(() => reserveRefund(aggregates(100), 1.5))).toBe("not_minor_units");
    expect(errorCodeOf(() => reserveRefund(aggregates(100, 100), 1))).toBe("nothing_refundable");
  });

  it("two concurrent-looking reservations cannot together exceed captured: the second sees the first", () => {
    const afterFirst = reserveRefund(aggregates(24000), 24000);
    expect(errorCodeOf(() => reserveRefund(afterFirst, 24000))).toBe("nothing_refundable");
  });
});

describe("settleProcessedRefund and releaseFailedRefund", () => {
  it("settling moves the amount from pending to refunded, leaving the sum unchanged", () => {
    const after = settleProcessedRefund(aggregates(24000, 1000, 5000), 5000);
    expect(after).toEqual(aggregates(24000, 6000, 0));
    expect(after.refundedInPaise + after.refundPendingInPaise).toBe(6000);
  });

  it("settling can finish a payment off exactly", () => {
    expect(settleProcessedRefund(aggregates(24000, 0, 24000), 24000)).toEqual(aggregates(24000, 24000, 0));
  });

  it("releasing returns the amount to remaining and refunds nothing", () => {
    const after = releaseFailedRefund(aggregates(24000, 1000, 5000), 5000);
    expect(after).toEqual(aggregates(24000, 1000, 0));
    expect(remainingRefundableInPaise(after)).toBe(23000);
  });

  it("cannot settle or release more than is pending", () => {
    expect(errorCodeOf(() => settleProcessedRefund(aggregates(24000, 0, 100), 101))).toBe("insufficient_pending");
    expect(errorCodeOf(() => releaseFailedRefund(aggregates(24000, 0, 100), 101))).toBe("insufficient_pending");
    expect(errorCodeOf(() => settleProcessedRefund(aggregates(24000), 1))).toBe("insufficient_pending");
  });

  it("rejects zero, negative and fractional amounts", () => {
    for (const fn of [settleProcessedRefund, releaseFailedRefund]) {
      expect(errorCodeOf(() => fn(aggregates(24000, 0, 100), 0))).toBe("not_positive");
      expect(errorCodeOf(() => fn(aggregates(24000, 0, 100), -5))).toBe("not_positive");
      expect(errorCodeOf(() => fn(aggregates(24000, 0, 100), 0.5))).toBe("not_minor_units");
      expect(errorCodeOf(() => fn(aggregates(24000, 0, 100), NaN))).toBe("not_minor_units");
    }
  });

  it("refuses to work on already-invalid figures", () => {
    expect(errorCodeOf(() => settleProcessedRefund(aggregates(100, 60, 41), 1))).toBe("invalid_aggregates");
  });

  it("a full lifecycle ends where it started or fully refunded, never beyond captured", () => {
    let state = aggregates(24000);
    state = reserveRefund(state, 24000);
    state = releaseFailedRefund(state, 24000);
    expect(state).toEqual(aggregates(24000));
    state = reserveRefund(state, 24000);
    state = settleProcessedRefund(state, 24000);
    expect(state).toEqual(aggregates(24000, 24000, 0));
    expect(errorCodeOf(() => reserveRefund(state, 1))).toBe("nothing_refundable");
  });

  it("works at the safe-integer boundary", () => {
    const reserved = reserveRefund(aggregates(MAX), MAX);
    expect(reserved.refundPendingInPaise).toBe(MAX);
    expect(settleProcessedRefund(reserved, MAX)).toEqual(aggregates(MAX, MAX, 0));
  });
});

describe("deriveRefundState", () => {
  it.each([
    [aggregates(24000), "none"],
    [aggregates(24000, 0, 24000), "in_progress"],
    [aggregates(24000, 10000, 0), "partially_refunded"],
    [aggregates(24000, 10000, 5000), "in_progress"],
    [aggregates(24000, 24000, 0), "refunded"],
    [aggregates(0), "none"],
  ] as const)("%j is %s", (state, expected) => {
    expect(deriveRefundState(state)).toBe(expected);
  });

  it("is attention_required whenever flagged, whatever the amounts", () => {
    expect(deriveRefundState(aggregates(24000), true)).toBe("attention_required");
    expect(deriveRefundState(aggregates(24000, 24000), true)).toBe("attention_required");
  });

  it("is never 'refunded' for a payment that captured nothing", () => {
    expect(deriveRefundState(aggregates(0, 0, 0))).toBe("none");
  });

  it("refuses invalid figures", () => {
    expect(errorCodeOf(() => deriveRefundState(aggregates(100, 60, 41)))).toBe("invalid_aggregates");
  });
});

describe("assessPaymentRefundability (legacy payment documents)", () => {
  function facts(overrides: Partial<PaymentRefundFacts> = {}): PaymentRefundFacts {
    return {
      status: "succeeded", amountInPaise: 24000, currency: "INR", providerPaymentId: "pay_Test1", ...overrides,
    };
  }

  it("treats an old succeeded payment with no captured amount as refundable in full", () => {
    const result = assessPaymentRefundability(facts());
    expect(result).toEqual({
      kind: "refundable",
      providerPaymentId: "pay_Test1",
      currency: "INR",
      aggregates: aggregates(24000, 0, 0),
      remainingInPaise: 24000,
    });
  });

  it("treats a succeeded payment with a stored captured amount the same way", () => {
    const result = assessPaymentRefundability(facts({capturedAmountInPaise: 24000}));
    expect(result).toMatchObject({kind: "refundable", remainingInPaise: 24000});
  });

  it("reports what remains after earlier refunds", () => {
    const result = assessPaymentRefundability(facts({
      capturedAmountInPaise: 24000, refundedAmountInPaise: 10000, refundPendingInPaise: 4000,
    }));
    expect(result).toMatchObject({kind: "refundable", remainingInPaise: 10000});
  });

  it("stays 'refundable' as a payment with 0 remaining once fully refunded (the amount check refuses the refund)", () => {
    const result = assessPaymentRefundability(facts({refundedAmountInPaise: 24000}));
    expect(result).toMatchObject({kind: "refundable", remainingInPaise: 0});
  });

  it("does not refund a failed payment: nothing was captured", () => {
    expect(assessPaymentRefundability(facts({status: "failed"}))).toEqual({
      kind: "not_refundable", reason: "payment_not_succeeded",
    });
  });

  it("does not refund a pending payment: nothing was captured", () => {
    expect(assessPaymentRefundability(facts({status: "pending"}))).toEqual({
      kind: "not_refundable", reason: "payment_not_succeeded",
    });
  });

  it("cannot refund a succeeded payment that has no provider payment ID", () => {
    expect(assessPaymentRefundability(facts({providerPaymentId: undefined}))).toEqual({
      kind: "not_refundable", reason: "missing_provider_payment_id",
    });
    expect(assessPaymentRefundability(facts({providerPaymentId: ""}))).toEqual({
      kind: "not_refundable", reason: "missing_provider_payment_id",
    });
  });

  it("rejects any currency other than INR", () => {
    for (const currency of ["USD", "inr", "", "INR "]) {
      expect(assessPaymentRefundability(facts({currency}))).toEqual({
        kind: "not_refundable", reason: "unsupported_currency",
      });
    }
  });

  it("reports invalid amounts instead of throwing", () => {
    expect(assessPaymentRefundability(facts({refundedAmountInPaise: 24000, refundPendingInPaise: 1}))).toEqual({
      kind: "not_refundable", reason: "invalid_amounts",
    });
    expect(assessPaymentRefundability(facts({capturedAmountInPaise: 1.5}))).toEqual({
      kind: "not_refundable", reason: "invalid_amounts",
    });
  });

  it("checks status before currency before provider ID before amounts", () => {
    expect(assessPaymentRefundability(facts({status: "failed", currency: "USD", providerPaymentId: undefined})))
      .toMatchObject({reason: "payment_not_succeeded"});
    expect(assessPaymentRefundability(facts({currency: "USD", providerPaymentId: undefined})))
      .toMatchObject({reason: "unsupported_currency"});
    expect(assessPaymentRefundability(facts({providerPaymentId: undefined, refundedAmountInPaise: 99999})))
      .toMatchObject({reason: "missing_provider_payment_id"});
  });
});

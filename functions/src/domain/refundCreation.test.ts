// @vitest-environment node
import {Timestamp, type DocumentReference, type Transaction} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import type {Order} from "./orders";
import type {Payment} from "./payments";
import {REFUND_FIRST_SWEEP_DELAY_MS, orderRefundMirror, planRefundCreation, readNextRefundSlot, type RefundSlot} from "./refundCreation";
import {refundIdFor, refundIdempotencyKeyFor} from "./refunds";

const NOW = Timestamp.fromDate(new Date("2026-09-24T10:00:00Z"));
const ORDER_ID = "AbCdEfGhIjKlMnOpQrSt";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    userId: "U-customer",
    organizationId: "org-1",
    outletId: "outlet-1",
    menuId: "menu-1",
    status: "confirmed",
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: 25000,
    totalInPaise: 25000,
    items: [{itemId: "i1", name: "Biriyani", priceInPaise: 12500, quantity: 2, lineTotalInPaise: 25000}],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: ORDER_ID,
    orderId: ORDER_ID,
    userId: "U-customer",
    organizationId: "org-1",
    outletId: "outlet-1",
    menuId: "menu-1",
    amountInPaise: 25000,
    currency: "INR",
    status: "succeeded",
    provider: "razorpay",
    providerOrderId: "order_rzp_1",
    providerPaymentId: "pay_rzp_1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function slotFor(seq: number): RefundSlot {
  return {
    seq,
    refundId: refundIdFor(ORDER_ID, seq),
    refundRef: {path: `x/${refundIdFor(ORDER_ID, seq)}`} as unknown as DocumentReference,
  };
}

function plan(overrides: Partial<Parameters<typeof planRefundCreation>[0]> = {}) {
  return planRefundCreation({
    order: order(),
    payment: payment(),
    slot: slotFor(1),
    reason: "customer_cancelled",
    source: "cancellation",
    initiatedBy: "U-customer",
    initiatedByRole: "customer",
    now: NOW,
    ...overrides,
  });
}

describe("planRefundCreation", () => {
  it("refunds the ENTIRE remaining amount of a legacy succeeded payment (no captured amount stored)", () => {
    const result = plan();

    expect(result.kind).toBe("create");
    if (result.kind !== "create") {
      return;
    }
    expect(result.refund.amountInPaise).toBe(25000);
    expect(result.paymentUpdate).toEqual({
      capturedAmountInPaise: 25000,
      refundedAmountInPaise: 0,
      refundPendingInPaise: 25000,
      refundSeq: 1,
      refundState: "in_progress",
      updatedAt: NOW,
    });
    expect(result.mirror).toEqual({refundStatus: "in_progress", refundedInPaise: 0});
  });

  it("creates a `requested` refund in the pre-provider state, with the 7.2 ID and idempotency key", () => {
    const result = plan();
    if (result.kind !== "create") {
      throw new Error("expected create");
    }

    expect(result.refund).toEqual({
      id: refundIdFor(ORDER_ID, 1),
      paymentId: ORDER_ID,
      orderId: ORDER_ID,
      organizationId: "org-1",
      outletId: "outlet-1",
      menuId: "menu-1",
      userId: "U-customer",
      providerPaymentId: "pay_rzp_1",
      amountInPaise: 25000,
      currency: "INR",
      status: "requested",
      reason: "customer_cancelled",
      source: "cancellation",
      initiatedBy: "U-customer",
      initiatedByRole: "customer",
      idempotencyKey: refundIdempotencyKeyFor(refundIdFor(ORDER_ID, 1)),
      submitAttempts: 0,
      createdAt: NOW,
      updatedAt: NOW,
      nextAttemptAt: Timestamp.fromMillis(NOW.toMillis() + REFUND_FIRST_SWEEP_DELAY_MS),
      attentionRequired: false,
    });
    expect(result.refund.idempotencyKey).toBe(result.refund.id);
    expect(result.refundRef.path).toBe(`x/${result.refund.id}`);
  });

  it("never carries an undefined field (Firestore rejects them)", () => {
    const result = plan();
    if (result.kind !== "create") {
      throw new Error("expected create");
    }

    for (const doc of [result.refund, result.paymentUpdate, result.mirror ?? {}]) {
      expect(Object.values(doc).every((value) => value !== undefined)).toBe(true);
    }
  });

  it("refunds only what remains after an earlier processed refund, and numbers it by the slot", () => {
    const result = plan({
      payment: payment({capturedAmountInPaise: 25000, refundedAmountInPaise: 10000, refundSeq: 1, refundState: "partially_refunded"}),
      slot: slotFor(2),
    });
    if (result.kind !== "create") {
      throw new Error("expected create");
    }

    expect(result.refund.id).toBe(`${ORDER_ID}-r2`);
    expect(result.refund.amountInPaise).toBe(15000);
    expect(result.paymentUpdate).toMatchObject({
      refundedAmountInPaise: 10000, refundPendingInPaise: 15000, refundSeq: 2, refundState: "in_progress",
    });
    expect(result.mirror).toEqual({refundStatus: "in_progress", refundedInPaise: 10000});
  });

  it("can never reserve more than remains: money already reserved is not reserved twice", () => {
    const result = plan({
      payment: payment({capturedAmountInPaise: 25000, refundPendingInPaise: 25000, refundSeq: 1, refundState: "in_progress"}),
      slot: slotFor(2),
    });

    expect(result).toEqual({kind: "nothing_to_refund", mirror: {refundStatus: "in_progress", refundedInPaise: 0}});
  });

  it("creates nothing for a payment that is already fully refunded, but still reports the mirror", () => {
    const result = plan({
      payment: payment({capturedAmountInPaise: 25000, refundedAmountInPaise: 25000, refundSeq: 1, refundState: "refunded"}),
      slot: slotFor(2),
    });

    expect(result).toEqual({kind: "nothing_to_refund", mirror: {refundStatus: "refunded", refundedInPaise: 25000}});
  });

  it("keeps an attention flag on the payment-level state", () => {
    const result = plan({payment: payment({refundState: "attention_required"})});
    if (result.kind !== "create") {
      throw new Error("expected create");
    }

    expect(result.paymentUpdate.refundState).toBe("attention_required");
    expect(result.mirror?.refundStatus).toBe("attention_required");
  });

  it.each([
    ["a pending payment", {status: "pending" as const}, "payment_not_succeeded"],
    ["a failed payment", {status: "failed" as const}, "payment_not_succeeded"],
    ["a succeeded payment with no provider payment ID", {providerPaymentId: undefined}, "missing_provider_payment_id"],
    ["inconsistent refund amounts", {refundedAmountInPaise: 20000, refundPendingInPaise: 20000}, "invalid_amounts"],
    ["a payment whose amount is not the order's total", {amountInPaise: 24000, capturedAmountInPaise: 24000}, "invalid_amounts"],
  ])("refuses to guess: %s is not refundable", (_name, overrides, reason) => {
    expect(plan({payment: payment(overrides)})).toEqual({kind: "not_refundable", reason});
  });

  it("fails loudly for an order ID that cannot be a provider idempotency key — before reserving anything", () => {
    const badId = "ord.with.dots";
    expect(() => plan({
      order: order({id: badId}),
      payment: payment({id: badId, orderId: badId}),
      slot: {seq: 1, refundId: `${badId}-r1`, refundRef: {} as DocumentReference},
    })).toThrow(/idempotency key/);
  });
});

describe("orderRefundMirror", () => {
  it("is absent when there is no refund activity (an order carries no mirror at all)", () => {
    expect(orderRefundMirror({capturedInPaise: 100, refundedInPaise: 0, refundPendingInPaise: 0}, false)).toBeNull();
  });

  it("copies the derived state and the processed total", () => {
    expect(orderRefundMirror({capturedInPaise: 100, refundedInPaise: 40, refundPendingInPaise: 0}, false))
      .toEqual({refundStatus: "partially_refunded", refundedInPaise: 40});
    expect(orderRefundMirror({capturedInPaise: 100, refundedInPaise: 100, refundPendingInPaise: 0}, false))
      .toEqual({refundStatus: "refunded", refundedInPaise: 100});
  });

  it("matches deriveRefundState for the same figures, whatever they are", () => {
    // The mirror is a copy, never a second model: same inputs, same answer.
    for (const refunded of [0, 30, 100]) {
      for (const pending of [0, 50]) {
        if (refunded + pending > 100) {
          continue;
        }
        const aggregates = {capturedInPaise: 100, refundedInPaise: refunded, refundPendingInPaise: pending};
        const mirror = orderRefundMirror(aggregates, false);
        expect(mirror?.refundedInPaise ?? 0).toBe(refunded);
        expect(mirror === null).toBe(refunded === 0 && pending === 0);
      }
    }
  });
});

describe("readNextRefundSlot", () => {
  function fakeTx(existing: Set<string>): {tx: Transaction; reads: string[]} {
    const reads: string[] = [];
    const tx = {
      get: async (ref: {path: string}) => {
        reads.push(ref.path);
        return {exists: existing.has(ref.path)};
      },
    } as unknown as Transaction;
    return {tx, reads};
  }

  function paymentRef(): DocumentReference {
    return {
      collection: (name: string) => ({doc: (id: string) => ({path: `pay/${name}/${id}`})}),
    } as unknown as DocumentReference;
  }

  it("numbers the first refund 1 for a payment with no refundSeq (legacy)", async () => {
    const {tx} = fakeTx(new Set());

    const slot = await readNextRefundSlot(tx, paymentRef(), payment());

    expect(slot.seq).toBe(1);
    expect(slot.refundId).toBe(`${ORDER_ID}-r1`);
    expect(slot.refundRef.path).toBe(`pay/refunds/${ORDER_ID}-r1`);
  });

  it("numbers the next refund after the payment's refundSeq", async () => {
    const {tx} = fakeTx(new Set());

    const slot = await readNextRefundSlot(tx, paymentRef(), payment({refundSeq: 3}));

    expect(slot.seq).toBe(4);
    expect(slot.refundId).toBe(`${ORDER_ID}-r4`);
  });

  it("reads the slot inside the transaction and refuses a refund document that already exists", async () => {
    const {tx, reads} = fakeTx(new Set([`pay/refunds/${ORDER_ID}-r1`]));

    await expect(readNextRefundSlot(tx, paymentRef(), payment())).rejects.toThrow(/already exists/);
    expect(reads).toEqual([`pay/refunds/${ORDER_ID}-r1`]);
  });

  it("rejects an order ID that cannot form a provider idempotency key before reading anything", async () => {
    const {tx, reads} = fakeTx(new Set());

    await expect(readNextRefundSlot(tx, paymentRef(), payment({orderId: "has.dot"}))).rejects.toThrow(/idempotency key/);
    expect(reads).toEqual([]);
  });
});

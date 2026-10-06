// @vitest-environment node
import {describe, expect, it} from "vitest";
import type {ProviderRefund} from "./refundGateway";
import {findMatchingProviderRefund, type RefundLookupCriteria} from "./refundLookup";

const PAYMENT = "pay_Test1";

function refund(overrides: Partial<ProviderRefund> = {}): ProviderRefund {
  return {
    id: "rfnd_1", providerPaymentId: PAYMENT, amountInPaise: 24000, currency: "INR", status: "pending",
    receipt: "order-1-r1", notes: {zestoRefundId: "order-1-r1", zestoOrderId: "order-1"},
    ...overrides,
  };
}

const criteria: RefundLookupCriteria = {providerPaymentId: PAYMENT, zestoRefundId: "order-1-r1", amountInPaise: 24000};

describe("findMatchingProviderRefund", () => {
  it("matches by the Zesto refund ID in the receipt", () => {
    const mine = refund({notes: {}});
    expect(findMatchingProviderRefund([mine], criteria)).toEqual({kind: "matched", refund: mine, matchedBy: "zesto_refund_id"});
  });

  it("matches by the Zesto refund ID in the notes", () => {
    const mine = refund({receipt: undefined});
    expect(findMatchingProviderRefund([mine], criteria)).toMatchObject({kind: "matched", matchedBy: "zesto_refund_id"});
  });

  it("matches by the known provider refund ID, the strongest evidence", () => {
    const mine = refund();
    expect(findMatchingProviderRefund([refund({id: "rfnd_2", receipt: "order-1-r2", notes: {zestoRefundId: "order-1-r2"}}), mine],
      {...criteria, providerRefundId: "rfnd_1"}))
      .toEqual({kind: "matched", refund: mine, matchedBy: "provider_refund_id"});
  });

  it("finds Zesto's refund among several of the same amount by identifier, not amount", () => {
    const other = refund({id: "rfnd_0", receipt: "order-1-r0", notes: {zestoRefundId: "order-1-r0"}});
    const mine = refund({id: "rfnd_9"});
    expect(findMatchingProviderRefund([other, mine], criteria)).toMatchObject({kind: "matched", refund: {id: "rfnd_9"}});
  });

  it("finds nothing in an empty list", () => {
    expect(findMatchingProviderRefund([], criteria)).toEqual({kind: "none", unattributedSameAmount: []});
  });

  it("never adopts a refund on amount alone — a same-amount refund with no Zesto ID is only reported as evidence", () => {
    const manual = refund({id: "rfnd_manual", receipt: undefined, notes: {}});
    expect(findMatchingProviderRefund([manual], criteria)).toEqual({kind: "none", unattributedSameAmount: [manual]});
  });

  it("does not report a same-amount refund that belongs to a different Zesto refund", () => {
    const another = refund({id: "rfnd_2", receipt: "order-1-r2", notes: {zestoRefundId: "order-1-r2"}});
    expect(findMatchingProviderRefund([another], criteria)).toEqual({kind: "none", unattributedSameAmount: []});
  });

  it("does not report a different-amount untagged refund", () => {
    expect(findMatchingProviderRefund([refund({receipt: undefined, notes: {}, amountInPaise: 100})], criteria))
      .toEqual({kind: "none", unattributedSameAmount: []});
  });

  it("ignores refunds that belong to another payment", () => {
    expect(findMatchingProviderRefund([refund({providerPaymentId: "pay_Other"})], criteria))
      .toEqual({kind: "none", unattributedSameAmount: []});
  });

  it("reports a conflict when two provider refunds both claim Zesto's refund ID", () => {
    const refunds = [refund({id: "rfnd_1"}), refund({id: "rfnd_2"})];
    expect(findMatchingProviderRefund(refunds, criteria)).toEqual({kind: "conflict", refunds});
  });

  it("reports a conflict when the known provider ID carries another Zesto refund's identifiers", () => {
    const wrong = refund({id: "rfnd_1", receipt: "order-9-r1", notes: {zestoRefundId: "order-9-r1"}});
    expect(findMatchingProviderRefund([wrong], {...criteria, providerRefundId: "rfnd_1"}))
      .toEqual({kind: "conflict", refunds: [wrong]});
  });

  it("reports a conflict, not 'none', when the known provider ID is absent from the list", () => {
    expect(findMatchingProviderRefund([refund({id: "rfnd_2"})], {...criteria, providerRefundId: "rfnd_1"}))
      .toEqual({kind: "conflict", refunds: []});
  });

  it("returns the refund whatever its status, so a failed or processed one is adopted too", () => {
    for (const status of ["pending", "processed", "failed"] as const) {
      expect(findMatchingProviderRefund([refund({status})], criteria)).toMatchObject({kind: "matched", refund: {status}});
    }
  });
});

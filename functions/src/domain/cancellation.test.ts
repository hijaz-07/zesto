// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import type {OrganizationMembership} from "../auth/membership";
import {
  CANCELLABLE_ORDER_STATUSES,
  CUSTOMER_CANCELLATION_REASONS,
  ORDER_CANCELLATION_REASON_VALUES,
  ORDER_CANCELLATION_ROLES,
  ORDER_CANCELLED_BY_ROLE_VALUES,
  ORGANIZATION_CANCELLATION_REASONS,
  buildOrderCancellationFields,
  cancellationRefusalToHttpsError,
  decideCancellation,
  isCustomerCancellationReason,
  isOrganizationCancellationReason,
  type CancellationActor,
  type CancellationDecision,
  type CancellationRefusalCode,
  type DecideCancellationInput,
} from "./cancellation";
import type {OrderStatus} from "./orders";

/** Every order status, kept exhaustive by the compiler: adding a status fails this literal until it is listed. */
const ORDER_STATUS_VALUES_FOR_TESTS = Object.keys({
  pending_payment: true,
  confirmed: true,
  preparing: true,
  ready: true,
  picked_up: true,
  completed: true,
  cancelled: true,
} satisfies Record<OrderStatus, true>) as OrderStatus[];

const ORG_ID = "org-1";
const CUSTOMER_ID = "U-customer";
const DEADLINE = new Date("2026-09-28T06:00:00.000Z");
const BEFORE_DEADLINE = new Date("2026-09-28T05:59:59.999Z");

function membership(overrides: Partial<OrganizationMembership> = {}): OrganizationMembership {
  return {userId: "U-member", organizationId: ORG_ID, role: "owner", status: "active", ...overrides};
}

const customer: CancellationActor = {kind: "customer", userId: CUSTOMER_ID};
const org = (overrides: Partial<OrganizationMembership> = {}): CancellationActor =>
  ({kind: "organization", membership: membership(overrides)});

/** A paid order in `status` by default; pass `paid: false` for the unpaid shape. */
function input(
  status: OrderStatus,
  overrides: Partial<DecideCancellationInput> = {},
  paid = status !== "pending_payment",
): DecideCancellationInput {
  return {
    actor: customer,
    order: {
      userId: CUSTOMER_ID,
      organizationId: ORG_ID,
      status,
      paymentStatus: paid ? "paid" : "pending",
    },
    paymentStatus: paid ? "succeeded" : "pending",
    orderingClosesAt: DEADLINE,
    now: BEFORE_DEADLINE,
    ...overrides,
  };
}

function refusalOf(decision: CancellationDecision): CancellationRefusalCode {
  if (decision.outcome !== "refuse") {
    throw new Error(`Expected a refusal, got ${decision.outcome}.`);
  }
  return decision.code;
}

function cancelOf(decision: CancellationDecision): Extract<CancellationDecision, {outcome: "cancel"}> {
  if (decision.outcome !== "cancel") {
    throw new Error(`Expected a cancel, got ${decision.outcome}${decision.outcome === "refuse" ? ` (${decision.code})` : ""}.`);
  }
  return decision;
}

describe("constants", () => {
  it("lists exactly the approved customer reasons", () => {
    expect([...CUSTOMER_CANCELLATION_REASONS]).toEqual([
      "changed_my_mind", "ordered_by_mistake", "wrong_items_or_quantity", "wrong_pickup_time", "other",
    ]);
  });

  it("lists exactly the approved organization reasons", () => {
    expect([...ORGANIZATION_CANCELLATION_REASONS]).toEqual([
      "item_unavailable", "outlet_closed", "cannot_fulfil_in_time", "duplicate_order", "customer_requested", "other",
    ]);
  });

  it("stores every reason once, as the union of both sets", () => {
    const union = new Set<string>([...CUSTOMER_CANCELLATION_REASONS, ...ORGANIZATION_CANCELLATION_REASONS]);
    expect(new Set(ORDER_CANCELLATION_REASON_VALUES)).toEqual(union);
    expect(ORDER_CANCELLATION_REASON_VALUES).toHaveLength(union.size);
  });

  it("allows only owner and manager to cancel for an organization", () => {
    expect([...ORDER_CANCELLATION_ROLES]).toEqual(["owner", "manager"]);
    expect(ORDER_CANCELLATION_ROLES).not.toContain("staff");
  });

  it("can cancel only from the four pre-pickup statuses, and has no system actor yet", () => {
    expect([...CANCELLABLE_ORDER_STATUSES]).toEqual(["pending_payment", "confirmed", "preparing", "ready"]);
    expect([...ORDER_CANCELLED_BY_ROLE_VALUES]).toEqual(["customer", "organization"]);
  });

  it("does not add a second cancelled status: every status is an existing OrderStatus", () => {
    for (const status of CANCELLABLE_ORDER_STATUSES) {
      expect(ORDER_STATUS_VALUES_FOR_TESTS).toContain(status);
    }
    expect(ORDER_STATUS_VALUES_FOR_TESTS.filter((status) => status.includes("cancel"))).toEqual(["cancelled"]);
  });

  it("type-guards reasons per audience, and 'other' belongs to both", () => {
    expect(isCustomerCancellationReason("changed_my_mind")).toBe(true);
    expect(isCustomerCancellationReason("item_unavailable")).toBe(false);
    expect(isOrganizationCancellationReason("item_unavailable")).toBe(true);
    expect(isOrganizationCancellationReason("changed_my_mind")).toBe(false);
    expect(isCustomerCancellationReason("other")).toBe(true);
    expect(isOrganizationCancellationReason("other")).toBe(true);
    for (const bad of [undefined, null, 5, {}, "", "Other", "OTHER "]) {
      expect(isCustomerCancellationReason(bad)).toBe(false);
      expect(isOrganizationCancellationReason(bad)).toBe(false);
    }
  });
});

describe("decideCancellation: a customer cancelling their own order", () => {
  it("may cancel a pending_payment order, without any refund", () => {
    const decision = cancelOf(decideCancellation(input("pending_payment")));
    expect(decision).toMatchObject({
      fromStatus: "pending_payment", cancelledBy: CUSTOMER_ID, cancelledByRole: "customer", refund: "not_required",
    });
  });

  it("may cancel a pending_payment order even after the ordering deadline", () => {
    const decision = decideCancellation(input("pending_payment", {now: new Date(DEADLINE.getTime() + 3_600_000)}));
    expect(cancelOf(decision).refund).toBe("not_required");
  });

  it("may cancel a confirmed order before the deadline, with a full refund required", () => {
    const decision = cancelOf(decideCancellation(input("confirmed")));
    expect(decision).toMatchObject({fromStatus: "confirmed", cancelledByRole: "customer", refund: "required"});
  });

  it("may cancel a confirmed order 1 ms before the deadline", () => {
    expect(decideCancellation(input("confirmed", {now: BEFORE_DEADLINE})).outcome).toBe("cancel");
  });

  it("may NOT cancel a confirmed order AT the deadline (the instant is already closed)", () => {
    expect(refusalOf(decideCancellation(input("confirmed", {now: DEADLINE})))).toBe("ordering_closed");
  });

  it("may NOT cancel a confirmed order after the deadline", () => {
    const later = new Date(DEADLINE.getTime() + 1);
    expect(refusalOf(decideCancellation(input("confirmed", {now: later})))).toBe("ordering_closed");
  });

  it("fails closed when the deadline is unreadable", () => {
    expect(refusalOf(decideCancellation(input("confirmed", {orderingClosesAt: new Date(NaN)})))).toBe("ordering_closed");
    expect(refusalOf(decideCancellation(input("confirmed", {now: new Date(NaN)})))).toBe("ordering_closed");
  });

  it("may NOT cancel once preparation has started", () => {
    expect(refusalOf(decideCancellation(input("preparing")))).toBe("preparation_started");
  });

  it("may NOT cancel a ready order", () => {
    expect(refusalOf(decideCancellation(input("ready")))).toBe("order_ready");
  });

  it("may NOT cancel a picked_up order", () => {
    expect(refusalOf(decideCancellation(input("picked_up")))).toBe("already_picked_up");
  });

  it("may NOT cancel a completed order", () => {
    expect(refusalOf(decideCancellation(input("completed")))).toBe("already_completed");
  });

  it("preparing/ready/picked_up/completed stay refused before the deadline too (status wins, not time)", () => {
    for (const status of ["preparing", "ready", "picked_up", "completed"] as const) {
      expect(decideCancellation(input(status, {now: new Date("2026-01-01T00:00:00Z")})).outcome).toBe("refuse");
    }
  });

  it("may NOT cancel someone else's order (reported as not_order_owner, which callers show as not-found)", () => {
    const decision = decideCancellation(input("confirmed", {actor: {kind: "customer", userId: "U-someone-else"}}));
    expect(refusalOf(decision)).toBe("not_order_owner");
  });

  it("is told it does not own the order before anything else about the order is revealed", () => {
    for (const status of ["pending_payment", "confirmed", "preparing", "ready", "picked_up", "completed", "cancelled"] as const) {
      const decision = decideCancellation(input(status, {actor: {kind: "customer", userId: "U-someone-else"}}));
      expect(refusalOf(decision)).toBe("not_order_owner");
    }
  });
});

describe("decideCancellation: an organization cancelling", () => {
  it.each(["owner", "manager"] as const)("lets an active %s cancel from every cancellable status", (role) => {
    for (const status of CANCELLABLE_ORDER_STATUSES) {
      const decision = cancelOf(decideCancellation(input(status, {
        actor: org({role}),
        reason: "item_unavailable",
        // Staff-side cancellation ignores the customer deadline entirely.
        now: new Date(DEADLINE.getTime() + 86_400_000),
      })));
      expect(decision).toMatchObject({
        fromStatus: status,
        cancelledBy: "U-member",
        cancelledByRole: "organization",
        reason: "item_unavailable",
        refund: status === "pending_payment" ? "not_required" : "required",
      });
    }
  });

  it("lets an owner cancel during preparation", () => {
    const decision = decideCancellation(input("preparing", {actor: org({role: "owner"}), reason: "outlet_closed"}));
    expect(cancelOf(decision)).toMatchObject({fromStatus: "preparing", refund: "required"});
  });

  it("lets a manager cancel during preparation", () => {
    const decision = decideCancellation(input("preparing", {actor: org({role: "manager"}), reason: "cannot_fulfil_in_time"}));
    expect(cancelOf(decision)).toMatchObject({fromStatus: "preparing", refund: "required"});
  });

  it("lets an owner or manager cancel a ready order", () => {
    for (const role of ["owner", "manager"] as const) {
      const decision = decideCancellation(input("ready", {actor: org({role}), reason: "duplicate_order"}));
      expect(cancelOf(decision).fromStatus).toBe("ready");
    }
  });

  it("REJECTS staff, from every status", () => {
    for (const status of ["pending_payment", "confirmed", "preparing", "ready", "picked_up", "completed", "cancelled"] as const) {
      const decision = decideCancellation(input(status, {actor: org({role: "staff"}), reason: "item_unavailable"}));
      expect(refusalOf(decision)).toBe("not_permitted");
    }
  });

  it.each(["invited", "revoked"] as const)("rejects a %s member even with a cancellation role", (status) => {
    const decision = decideCancellation(input("confirmed", {actor: org({status}), reason: "item_unavailable"}));
    expect(refusalOf(decision)).toBe("not_permitted");
  });

  it("rejects an owner of a DIFFERENT organization", () => {
    const decision = decideCancellation(input("confirmed", {
      actor: org({organizationId: "org-other"}), reason: "item_unavailable",
    }));
    expect(refusalOf(decision)).toBe("wrong_organization");
  });

  it("rejects picked_up and completed orders even for an owner", () => {
    expect(refusalOf(decideCancellation(input("picked_up", {actor: org(), reason: "other"})))).toBe("already_picked_up");
    expect(refusalOf(decideCancellation(input("completed", {actor: org(), reason: "other"})))).toBe("already_completed");
  });
});

describe("decideCancellation: reasons", () => {
  it("lets a customer give no reason, and then records none", () => {
    const decision = cancelOf(decideCancellation(input("confirmed")));
    expect(decision).not.toHaveProperty("reason");
  });

  it.each(CUSTOMER_CANCELLATION_REASONS)("accepts the customer reason %s", (reason) => {
    expect(cancelOf(decideCancellation(input("confirmed", {reason}))).reason).toBe(reason);
  });

  it.each(["item_unavailable", "nonsense", "", 7, null, {}, " other"])(
    "rejects an unsupported customer reason (%j)", (reason) => {
      expect(refusalOf(decideCancellation(input("confirmed", {reason})))).toBe("invalid_reason");
    });

  it("rejects an explicit null reason from a customer (absent is not the same as null)", () => {
    expect(refusalOf(decideCancellation(input("confirmed", {reason: null})))).toBe("invalid_reason");
  });

  it("REQUIRES a reason from an organization", () => {
    expect(refusalOf(decideCancellation(input("confirmed", {actor: org()})))).toBe("reason_required");
  });

  it.each(ORGANIZATION_CANCELLATION_REASONS)("accepts the organization reason %s", (reason) => {
    expect(cancelOf(decideCancellation(input("confirmed", {actor: org(), reason}))).reason).toBe(reason);
  });

  it.each(["changed_my_mind", "free text", "", 3, null])(
    "rejects an unsupported organization reason (%j)", (reason) => {
      expect(refusalOf(decideCancellation(input("confirmed", {actor: org(), reason})))).toBe("invalid_reason");
    });

  it("does not let a customer use an organization-only reason, nor the reverse", () => {
    expect(refusalOf(decideCancellation(input("confirmed", {reason: "customer_requested"})))).toBe("invalid_reason");
    expect(refusalOf(decideCancellation(input("confirmed", {actor: org(), reason: "wrong_pickup_time"})))).toBe("invalid_reason");
  });
});

describe("decideCancellation: an order that is already cancelled", () => {
  const cancelled = (overrides: Partial<DecideCancellationInput> = {}) =>
    input("cancelled", {paymentStatus: "succeeded", ...overrides}, true);

  it("is an idempotent no-op for the customer who owns it", () => {
    expect(decideCancellation(cancelled())).toEqual({outcome: "already_cancelled"});
  });

  it("is an idempotent no-op for an owner or manager", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(decideCancellation(cancelled({actor: org({role}), reason: "other"}))).toEqual({outcome: "already_cancelled"});
    }
  });

  it("is a no-op whether or not the payment ever succeeded", () => {
    expect(decideCancellation(cancelled({paymentStatus: "pending"})).outcome).toBe("already_cancelled");
    expect(decideCancellation(cancelled({paymentStatus: "absent"})).outcome).toBe("already_cancelled");
  });

  it("is a no-op after the deadline too (a repeat is never refused for being late)", () => {
    expect(decideCancellation(cancelled({now: new Date(DEADLINE.getTime() + 1)})).outcome).toBe("already_cancelled");
  });

  it("is a no-op even for a repeat with a different, valid reason (the original stays on record)", () => {
    expect(decideCancellation(cancelled({reason: "ordered_by_mistake"})).outcome).toBe("already_cancelled");
  });

  it("still refuses a stranger, staff, and a malformed reason — idempotency never skips authorization", () => {
    expect(refusalOf(decideCancellation(cancelled({actor: {kind: "customer", userId: "U-other"}})))).toBe("not_order_owner");
    expect(refusalOf(decideCancellation(cancelled({actor: org({role: "staff"}), reason: "other"})))).toBe("not_permitted");
    expect(refusalOf(decideCancellation(cancelled({reason: "bogus"})))).toBe("invalid_reason");
    expect(refusalOf(decideCancellation(cancelled({actor: org()})))).toBe("reason_required");
  });
});

describe("decideCancellation: payment consistency", () => {
  it("refunds in full for every paid status, and only for those", () => {
    for (const status of ["confirmed", "preparing", "ready"] as const) {
      expect(cancelOf(decideCancellation(input(status, {actor: org(), reason: "other"}))).refund).toBe("required");
    }
    expect(cancelOf(decideCancellation(input("pending_payment"))).refund).toBe("not_required");
  });

  it("treats a pending_payment order whose payment is absent, pending or failed as unpaid", () => {
    for (const paymentStatus of ["absent", "pending", "failed"] as const) {
      expect(cancelOf(decideCancellation(input("pending_payment", {paymentStatus}))).refund).toBe("not_required");
    }
  });

  it("refuses a paid status whose payment did not succeed", () => {
    for (const paymentStatus of ["absent", "pending", "failed"] as const) {
      const decision = decideCancellation(input("confirmed", {paymentStatus, actor: org(), reason: "other"}));
      expect(refusalOf(decision)).toBe("payment_state_inconsistent");
    }
  });

  it("refuses a paid status whose order is not marked paid", () => {
    const base = input("confirmed", {actor: org(), reason: "other"});
    const decision = decideCancellation({...base, order: {...base.order, paymentStatus: "pending"}});
    expect(refusalOf(decision)).toBe("payment_state_inconsistent");
  });

  it("refuses a pending_payment order whose payment already succeeded, or that is marked paid", () => {
    expect(refusalOf(decideCancellation(input("pending_payment", {paymentStatus: "succeeded"})))).toBe("payment_state_inconsistent");
    const base = input("pending_payment");
    expect(refusalOf(decideCancellation({...base, order: {...base.order, paymentStatus: "paid"}}))).toBe("payment_state_inconsistent");
  });
});

describe("decideCancellation: purity", () => {
  it("is deterministic and does not mutate its input", () => {
    const frozen = Object.freeze(input("confirmed", {actor: org(), reason: "other"}));
    Object.freeze(frozen.order);
    const first = decideCancellation(frozen);
    const second = decideCancellation(frozen);
    expect(second).toEqual(first);
  });

  it("depends only on its input: the same facts give the same answer at any wall-clock time", () => {
    const facts = input("confirmed");
    const results = new Set<string>();
    for (let i = 0; i < 3; i++) {
      results.add(JSON.stringify(decideCancellation(facts)));
    }
    expect(results.size).toBe(1);
  });

  it("covers every order status exactly once for a customer: the whole matrix", () => {
    const outcomes = Object.fromEntries(
      ORDER_STATUS_VALUES_FOR_TESTS.map((status) => {
        const decision = decideCancellation(input(status, {paymentStatus: status === "pending_payment" ? "pending" : "succeeded"}));
        return [status, decision.outcome === "refuse" ? `refuse:${decision.code}` : decision.outcome];
      }),
    );
    expect(outcomes).toEqual({
      pending_payment: "cancel",
      confirmed: "cancel",
      preparing: "refuse:preparation_started",
      ready: "refuse:order_ready",
      picked_up: "refuse:already_picked_up",
      completed: "refuse:already_completed",
      cancelled: "already_cancelled",
    });
  });

  it("covers every order status for an owner: the whole matrix", () => {
    const outcomes = Object.fromEntries(
      ORDER_STATUS_VALUES_FOR_TESTS.map((status) => {
        const decision = decideCancellation(input(status, {
          actor: org(), reason: "other", paymentStatus: status === "pending_payment" ? "pending" : "succeeded",
        }));
        return [status, decision.outcome === "refuse" ? `refuse:${decision.code}` : decision.outcome];
      }),
    );
    expect(outcomes).toEqual({
      pending_payment: "cancel",
      confirmed: "cancel",
      preparing: "cancel",
      ready: "cancel",
      picked_up: "refuse:already_picked_up",
      completed: "refuse:already_completed",
      cancelled: "already_cancelled",
    });
  });
});

describe("buildOrderCancellationFields", () => {
  const at = Timestamp.fromDate(new Date("2026-09-27T10:00:00Z"));

  it("writes status, updatedAt and the whole audit group together", () => {
    const decision = cancelOf(decideCancellation(input("preparing", {actor: org(), reason: "outlet_closed"})));
    expect(buildOrderCancellationFields(decision, at)).toEqual({
      status: "cancelled",
      updatedAt: at,
      cancelledAt: at,
      cancelledBy: "U-member",
      cancelledByRole: "organization",
      cancelledFromStatus: "preparing",
      cancellationReason: "outlet_closed",
    });
  });

  it("leaves the reason out (never undefined) when a customer gave none", () => {
    const fields = buildOrderCancellationFields(cancelOf(decideCancellation(input("confirmed"))), at);
    expect(fields).not.toHaveProperty("cancellationReason");
    expect(Object.values(fields).every((value) => value !== undefined)).toBe(true);
  });
});

describe("cancellationRefusalToHttpsError", () => {
  const expected: Record<CancellationRefusalCode, string> = {
    not_order_owner: "not-found",
    wrong_organization: "not-found",
    not_permitted: "permission-denied",
    invalid_reason: "invalid-argument",
    reason_required: "invalid-argument",
    ordering_closed: "aborted",
    preparation_started: "aborted",
    order_ready: "aborted",
    already_picked_up: "aborted",
    already_completed: "aborted",
    payment_state_inconsistent: "aborted",
  };

  it.each(Object.entries(expected))("maps %s to %s", (code, httpsCode) => {
    expect(cancellationRefusalToHttpsError(code as CancellationRefusalCode).code).toBe(httpsCode);
  });

  it("gives 'not yours' and 'another organization's' the same not-found answer, so existence does not leak", () => {
    const a = cancellationRefusalToHttpsError("not_order_owner");
    const b = cancellationRefusalToHttpsError("wrong_organization");
    expect(a.message).toBe(b.message);
    expect(a.httpErrorCode.status).toBe(404);
  });

  it("maps state conflicts to 409 and authorization to 403", () => {
    expect(cancellationRefusalToHttpsError("preparation_started").httpErrorCode.status).toBe(409);
    expect(cancellationRefusalToHttpsError("not_permitted").httpErrorCode.status).toBe(403);
  });
});

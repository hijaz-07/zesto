import {randomUUID} from "node:crypto";
import {Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {expect} from "vitest";
import {WEBHOOK_EVENTS_COLLECTION} from "./razorpayWebhooks";
import {refundIdFor, type RefundStatus} from "./refunds";
import type {RefundLocation} from "./refundTransitions";

/**
 * Emulator-test fixtures for the refund orchestration: a cancelled, paid order with
 * its captured payment and one refund in any state, written directly in the exact
 * shape the domain writes (excluded from the build with the other `*.fake.ts`).
 * No organization/outlet/menu documents are needed: every refund path reads only
 * the order, the payment and the refund, validated against the path.
 */

export const AMOUNT = 10000;
export const FIXED_NOW = Timestamp.fromDate(new Date("2026-09-24T10:00:00Z"));

export interface Scenario {
  loc: RefundLocation;
  orderRef: DocumentReference;
  paymentRef: DocumentReference;
  refundRef: DocumentReference;
  organizationId: string;
  orderId: string;
  providerPaymentId: string;
  providerOrderId: string;
  amount: number;
}

export interface SeedScenarioInput {
  organizationId?: string;
  amount?: number;
  orderStatus?: "cancelled" | "confirmed";
  refundStatus?: RefundStatus;
  /** Extra / overriding refund fields (use `undefined` through `omitRefund` to drop one). */
  refund?: Record<string, unknown>;
  omitRefund?: string[];
  payment?: Record<string, unknown>;
  /** How much of the amount the payment already shows as refunded / pending (default: pending = amount). */
  refundedInPaise?: number;
  pendingInPaise?: number;
  /** Seed a paid order with NO refund yet (a capture the cancellation has not reached). */
  noRefund?: boolean;
  /** When the refund is next due; default: already due. */
  nextAttemptAt?: Timestamp | null;
}

const seeded: DocumentReference[] = [];

/**
 * @param {Firestore} db The emulator Firestore.
 * @param {SeedScenarioInput} [input] What to vary.
 * @return {Promise<Scenario>} The seeded documents' coordinates.
 */
export async function seedScenario(db: Firestore, input: SeedScenarioInput = {}): Promise<Scenario> {
  const amount = input.amount ?? AMOUNT;
  const organizationId = input.organizationId ?? `org-${randomUUID().slice(0, 12)}`;
  const outletId = `outlet-${randomUUID().slice(0, 8)}`;
  const menuId = `menu-${randomUUID().slice(0, 8)}`;
  const orderRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .collection("menus").doc(menuId)
    .collection("orders").doc();
  seeded.push(orderRef);
  const orderId = orderRef.id;
  const paymentRef = orderRef.collection("payments").doc(orderId);
  const refundId = refundIdFor(orderId, 1);
  const refundRef = paymentRef.collection("refunds").doc(refundId);
  const userId = `U-${randomUUID().slice(0, 12)}`;
  const providerPaymentId = `pay_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const providerOrderId = `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const status = input.refundStatus ?? "requested";
  const created = Timestamp.fromDate(new Date("2026-09-24T09:00:00Z"));

  const none = input.noRefund === true;
  const pending = none ? 0 : input.pendingInPaise ?? (status === "requested" || status === "pending" ? amount : 0);
  const refunded = none ? 0 : input.refundedInPaise ?? (status === "processed" ? amount : 0);
  const refundState = refunded === amount ? "refunded" : pending > 0 ? "in_progress" : refunded > 0 ? "partially_refunded" : "none";

  await orderRef.create({
    id: orderId,
    userId,
    organizationId,
    outletId,
    menuId,
    status: input.orderStatus ?? "cancelled",
    paymentStatus: "paid",
    currency: "INR",
    subtotalInPaise: amount,
    totalInPaise: amount,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: amount, quantity: 1, lineTotalInPaise: amount}],
    createdAt: created,
    updatedAt: created,
    ...(refundState === "none" ? {} : {refundStatus: refundState, refundedInPaise: refunded}),
  });
  await paymentRef.create({
    id: orderId,
    orderId,
    userId,
    organizationId,
    outletId,
    menuId,
    amountInPaise: amount,
    currency: "INR",
    status: "succeeded",
    provider: "razorpay",
    providerOrderId,
    providerPaymentId,
    capturedAmountInPaise: amount,
    refundedAmountInPaise: refunded,
    refundPendingInPaise: pending,
    refundSeq: none ? 0 : 1,
    ...(none ? {} : {refundState}),
    createdAt: created,
    updatedAt: created,
    ...input.payment,
  });

  const refund: Record<string, unknown> = {
    id: refundId,
    paymentId: orderId,
    orderId,
    organizationId,
    outletId,
    menuId,
    userId,
    providerPaymentId,
    amountInPaise: amount,
    currency: "INR",
    status,
    reason: "customer_cancelled",
    source: "cancellation",
    initiatedBy: userId,
    initiatedByRole: "customer",
    idempotencyKey: refundId,
    submitAttempts: 0,
    createdAt: created,
    updatedAt: created,
    attentionRequired: false,
    ...(status === "pending" || status === "processed" ?
      {providerRefundId: `rfnd_seed_${randomUUID().slice(0, 8)}`, providerStatus: status, pendingAt: created} : {}),
    ...(status === "processed" ? {processedAt: created} : {}),
    ...(status === "failed" ? {failedAt: created, failureCode: "seed_failed", failureMessage: "Seeded failure."} : {}),
    ...(input.nextAttemptAt === null ?
      {} :
      (status === "requested" || status === "pending") ?
        {nextAttemptAt: input.nextAttemptAt ?? Timestamp.fromDate(new Date("2026-09-24T09:30:00Z"))} : {}),
    ...input.refund,
  };
  for (const key of input.omitRefund ?? []) {
    delete refund[key];
  }
  if (!none) {
    await refundRef.create(refund);
  }

  return {
    loc: {organizationId, outletId, menuId, orderId, paymentId: orderId, refundId},
    orderRef, paymentRef, refundRef, organizationId, orderId, providerPaymentId, providerOrderId, amount,
  };
}

/**
 * Deletes every seeded order (with its payment, refunds and audit records) and the
 * webhook-event bookkeeping, so the collection-group queries stay small.
 *
 * @param {Firestore} db The emulator Firestore.
 */
export async function cleanupScenarios(db: Firestore): Promise<void> {
  for (const ref of seeded.splice(0)) {
    await db.recursiveDelete(ref);
  }
  const events = await db.collection(WEBHOOK_EVENTS_COLLECTION).get();
  await Promise.all(events.docs.map((doc) => doc.ref.delete()));
}

export interface ScenarioState {
  order: Record<string, unknown>;
  payment: Record<string, unknown>;
  refunds: Record<string, Record<string, unknown>>;
}

/**
 * @param {Scenario} scenario The scenario.
 * @return {Promise<ScenarioState>} Every stored document of the order's refund accounting, raw.
 */
export async function loadState(scenario: Scenario): Promise<ScenarioState> {
  const [order, payment, refunds] = await Promise.all([
    scenario.orderRef.get(), scenario.paymentRef.get(), scenario.paymentRef.collection("refunds").get(),
  ]);
  return {
    order: order.data() ?? {},
    payment: payment.data() ?? {},
    refunds: Object.fromEntries(refunds.docs.map((doc) => [doc.id, doc.data()])),
  };
}

/**
 * @param {Scenario} scenario The scenario.
 * @param {string} [refundId] A refund of it (default: the first).
 * @return {Promise<Record<string, unknown>>} That refund, raw.
 */
export async function loadRefund(scenario: Scenario, refundId?: string): Promise<Record<string, unknown>> {
  const state = await loadState(scenario);
  const refund = state.refunds[refundId ?? scenario.loc.refundId];
  if (!refund) {
    throw new Error(`No refund ${refundId ?? scenario.loc.refundId}`);
  }
  return refund;
}

/**
 * @param {Scenario} scenario The scenario.
 * @return {Promise<string[]>} The names of the refund's audit records (`transitions` and `anomalies`).
 */
export async function auditNames(scenario: Scenario, refundId?: string): Promise<{transitions: string[]; anomalies: string[]}> {
  const ref = scenario.paymentRef.collection("refunds").doc(refundId ?? scenario.loc.refundId);
  const [t, a] = await Promise.all([ref.collection("transitions").get(), ref.collection("anomalies").get()]);
  return {transitions: t.docs.map((doc) => doc.id).sort(), anomalies: a.docs.map((doc) => doc.id).sort()};
}

/**
 * The cross-document invariant every refund-touching test ends on: the payment's
 * aggregates are exactly the sums over its refund documents (`processed` -> refunded,
 * `requested`/`pending` -> pending, `failed` -> nothing), `refunded + pending <=
 * captured`, `refundSeq` counts the refunds, and the order's mirror equals the
 * payment's figures (absent exactly when there is no refund activity).
 *
 * @param {Scenario} scenario The scenario.
 * @return {Promise<ScenarioState>} The state it checked.
 */
export async function expectAccounting(scenario: Scenario): Promise<ScenarioState> {
  const state = await loadState(scenario);
  let refunded = 0;
  let pending = 0;
  for (const refund of Object.values(state.refunds)) {
    if (refund.status === "processed") {
      refunded += refund.amountInPaise as number;
    } else if (refund.status === "requested" || refund.status === "pending") {
      pending += refund.amountInPaise as number;
    }
  }
  const captured = (state.payment.capturedAmountInPaise as number | undefined) ?? (state.payment.amountInPaise as number);
  expect(state.payment.refundedAmountInPaise).toBe(refunded);
  expect(state.payment.refundPendingInPaise).toBe(pending);
  expect(refunded + pending).toBeLessThanOrEqual(captured);
  expect(state.payment.refundSeq).toBe(Object.keys(state.refunds).length);

  const flagged = state.payment.refundState === "attention_required";
  const expectedState = flagged ? "attention_required" :
    captured > 0 && refunded === captured ? "refunded" :
      pending > 0 ? "in_progress" : refunded > 0 ? "partially_refunded" : "none";
  expect(state.payment.refundState).toBe(expectedState);
  if (expectedState === "none") {
    expect(state.order.refundStatus).toBeUndefined();
    expect(state.order.refundedInPaise).toBeUndefined();
  } else {
    expect(state.order.refundStatus).toBe(expectedState);
    expect(state.order.refundedInPaise).toBe(refunded);
  }
  return state;
}

/** Seeds a provider payment in the fake gateway matching a scenario. */
export function providerPaymentFor(scenario: Scenario): {id: string; providerOrderId: string; amountInPaise: number; currency: string} {
  return {
    id: scenario.providerPaymentId,
    providerOrderId: scenario.providerOrderId,
    amountInPaise: scenario.amount,
    currency: "INR",
  };
}

/** A clock for `SubmitRefundOptions.now`, advanced by hand. */
export function manualClock(start: Timestamp = FIXED_NOW): {now: () => Timestamp; advance: (ms: number) => void; at: () => Timestamp} {
  let ms = start.toMillis();
  return {
    now: () => Timestamp.fromMillis(ms),
    advance: (by: number) => {
      ms += by;
    },
    at: () => Timestamp.fromMillis(ms),
  };
}

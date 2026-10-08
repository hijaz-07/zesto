import {randomUUID} from "node:crypto";
import {Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {expect} from "vitest";
import {WEBHOOK_EVENTS_COLLECTION} from "./razorpayWebhooks";
import type {PaymentLocation} from "./paymentReconciliation";
import {providerOrderPayment} from "../providers/paymentLookupGateway.fake";
import type {ProviderOrderPayment} from "../providers/paymentLookupGateway";

/**
 * Emulator-test fixtures for payment reconciliation: an order awaiting payment (or cancelled
 * meanwhile) with its provider-connected, not-yet-succeeded payment, written directly in the
 * exact shape the domain writes. Excluded from the build with the other `*.fake.ts`.
 */

export const AMOUNT = 10000;
export const T0 = Timestamp.fromDate(new Date("2026-10-01T10:00:00Z"));
/** Past the first scheduled check (T0 + 15 minutes). */
export const AFTER_FIRST_CHECK = Timestamp.fromMillis(T0.toMillis() + 20 * 60 * 1000);

export interface PaymentScenario {
  loc: PaymentLocation;
  orderRef: DocumentReference;
  paymentRef: DocumentReference;
  organizationId: string;
  orderId: string;
  userId: string;
  providerOrderId: string;
  amount: number;
}

export interface SeedPaymentInput {
  amount?: number;
  orderStatus?: "pending_payment" | "cancelled" | "confirmed";
  paymentStatus?: "pending" | "failed";
  createdAt?: Timestamp;
  /** Overrides on the payment's `reconciliation` map (`null` omits the map entirely). */
  reconciliation?: Record<string, unknown> | null;
  payment?: Record<string, unknown>;
  order?: Record<string, unknown>;
}

const seeded: DocumentReference[] = [];

/**
 * @param {Firestore} db The emulator Firestore.
 * @param {SeedPaymentInput} [input] What to vary.
 * @return {Promise<PaymentScenario>} The seeded documents' coordinates.
 */
export async function seedUnresolvedPayment(db: Firestore, input: SeedPaymentInput = {}): Promise<PaymentScenario> {
  const amount = input.amount ?? AMOUNT;
  const organizationId = `org-${randomUUID().slice(0, 12)}`;
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
  const userId = `U-${randomUUID().slice(0, 12)}`;
  const providerOrderId = `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const createdAt = input.createdAt ?? T0;

  await orderRef.create({
    id: orderId,
    userId,
    organizationId,
    outletId,
    menuId,
    status: input.orderStatus ?? "pending_payment",
    paymentStatus: input.orderStatus === "confirmed" ? "paid" : "pending",
    currency: "INR",
    subtotalInPaise: amount,
    totalInPaise: amount,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: amount, quantity: 1, lineTotalInPaise: amount}],
    createdAt,
    updatedAt: createdAt,
    ...input.order,
  });
  const base = {
    id: orderId,
    orderId,
    userId,
    organizationId,
    outletId,
    menuId,
    amountInPaise: amount,
    currency: "INR",
    status: input.paymentStatus ?? "pending",
    provider: "razorpay",
    providerOrderId,
    createdAt,
    updatedAt: createdAt,
  };
  await paymentRef.create({
    ...base,
    ...(input.reconciliation === null ? {} : {
      reconciliation: {
        attempts: 0,
        inconclusiveStreak: 0,
        nextAttemptAt: Timestamp.fromMillis(createdAt.toMillis() + 15 * 60 * 1000),
        ...input.reconciliation,
      },
    }),
    ...input.payment,
  });

  return {
    loc: {organizationId, outletId, menuId, orderId, paymentId: orderId},
    orderRef, paymentRef, organizationId, orderId, userId, providerOrderId, amount,
  };
}

/**
 * Deletes every seeded order (with its payment, refunds and audit records) and the webhook-event
 * bookkeeping, so the collection-group queries stay small.
 *
 * @param {Firestore} db The emulator Firestore.
 */
export async function cleanupPaymentScenarios(db: Firestore): Promise<void> {
  for (const ref of seeded.splice(0)) {
    await db.recursiveDelete(ref);
  }
  const events = await db.collection(WEBHOOK_EVENTS_COLLECTION).get();
  await Promise.all(events.docs.map((doc) => doc.ref.delete()));
}

export interface PaymentState {
  order: Record<string, unknown>;
  payment: Record<string, unknown>;
  reconciliation: Record<string, unknown>;
  audit: string[];
  refunds: Record<string, Record<string, unknown>>;
}

/**
 * @param {PaymentScenario} s The scenario.
 * @return {Promise<PaymentState>} Every stored document of the order's payment accounting, raw.
 */
export async function loadPaymentState(s: PaymentScenario): Promise<PaymentState> {
  const [order, payment, audit, refunds] = await Promise.all([
    s.orderRef.get(), s.paymentRef.get(),
    s.paymentRef.collection("reconciliationAudit").get(), s.paymentRef.collection("refunds").get(),
  ]);
  const paymentData = payment.data() ?? {};
  return {
    order: order.data() ?? {},
    payment: paymentData,
    reconciliation: (paymentData.reconciliation ?? {}) as Record<string, unknown>,
    audit: audit.docs.map((doc) => doc.id).sort(),
    refunds: Object.fromEntries(refunds.docs.map((doc) => [doc.id, doc.data()])),
  };
}

/** A captured provider payment matching a scenario. */
export function capturedFor(s: PaymentScenario, overrides: Partial<ProviderOrderPayment> = {}): ProviderOrderPayment {
  return providerOrderPayment({
    id: `pay_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    providerOrderId: s.providerOrderId,
    amountInPaise: s.amount,
    ...overrides,
  });
}

/**
 * The cross-document invariant every payment test ends on: the payment and the order tell the
 * same story. A `succeeded` payment has its captured amount and provider payment ID, is out of
 * the sweep (no `nextAttemptAt`), and its order is `confirmed`+`paid` (or, if it was cancelled
 * meanwhile, still `cancelled`, `paid`, with exactly one full refund reserved). A payment that
 * is not succeeded has no captured amount, its order is not `paid`, and no refund exists.
 *
 * @param {PaymentScenario} s The scenario.
 * @return {Promise<PaymentState>} The state it checked.
 */
export async function expectPaymentConsistency(s: PaymentScenario): Promise<PaymentState> {
  const state = await loadPaymentState(s);
  const cancelled = state.order.status === "cancelled";
  if (state.payment.status === "succeeded") {
    expect(state.payment.capturedAmountInPaise).toBe(s.amount);
    expect(typeof state.payment.providerPaymentId).toBe("string");
    expect(state.reconciliation.nextAttemptAt).toBeUndefined();
    expect(state.reconciliation.leaseExpiresAt).toBeUndefined();
    expect(state.order.paymentStatus).toBe("paid");
    if (cancelled) {
      const refunds = Object.values(state.refunds);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({amountInPaise: s.amount, reason: "late_capture_after_cancel"});
      expect(state.payment.refundPendingInPaise).toBe(s.amount);
      expect(state.payment.refundSeq).toBe(1);
    } else {
      expect(state.order.status).toBe("confirmed");
      expect(Object.keys(state.refunds)).toHaveLength(0);
    }
  } else {
    expect(state.payment.capturedAmountInPaise).toBeUndefined();
    expect(state.order.paymentStatus).toBe("pending");
    expect(state.order.status).toBe(cancelled ? "cancelled" : "pending_payment");
    expect(Object.keys(state.refunds)).toHaveLength(0);
  }
  return state;
}

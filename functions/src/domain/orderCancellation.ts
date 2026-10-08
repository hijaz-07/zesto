import {Timestamp, type DocumentReference, type Firestore, type Transaction} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {
  buildOrderCancellationFields,
  cancellationRefusalToHttpsError,
  decideCancellation,
  type CancellationActor,
} from "./cancellation";
import {isFirestoreAborted} from "./orderFulfillment";
import {parseMenu} from "./menus";
import {resolveOrderById, type Order, type OrderStatus} from "./orders";
import {parsePayment, type Payment, type PaymentStatus} from "./payments";
import {recordCancellationNotificationEvent, recordRefundNotificationEvent} from "./notificationEvents";
import {planRefundCreation, readNextRefundSlot} from "./refundCreation";
import {parseRefund, refundIdFor, type Refund, type RefundStatus} from "./refunds";

/**
 * Order CANCELLATION, applied: the transaction around `decideCancellation`.
 * That function (`domain/cancellation.ts`) is the whole policy and stays the
 * only copy of it; this module reads the facts it needs, inside one Firestore
 * transaction, and writes what it decides — the order's move into `cancelled`,
 * its audit fields, and, for a paid order, the refund — all atomically.
 *
 * Everything is read from Firestore inside the transaction; the request supplies
 * only the order ID and an optional reason:
 * - the order (status, owner, organization, payment status);
 * - its payment, for the payment-consistency rules;
 * - for a CUSTOMER cancelling a `confirmed` order, the order's own menu's
 *   `orderingClosesAt` — the deadline, never a client value. A missing or
 *   unreadable menu makes the deadline `Invalid Date`, which
 *   `decideCancellation` reads as closed: fail closed.
 *
 * Order of events, so a stranger learns nothing and a repeat cannot be a bypass:
 * 1. the actor is identified (customer owns the order / member of its own
 *    organization with a cancellation role) and the reason checked — by
 *    `decideCancellation`, first, before it so much as looks at the order's
 *    status. An already-`cancelled` order is answered only after that, so an
 *    unauthorized caller gets the same refusal for a cancelled order as for any;
 * 2. only then the status, deadline and payment rules.
 *
 * Money. A paid order (`confirmed`/`preparing`/`ready`, payment `succeeded`)
 * gets one refund of the ENTIRE remaining refundable amount, computed from the
 * payment as read in this transaction (`domain/refundCreation.ts`); a request
 * can never name an amount. The refund document (`requested`, ready for a later
 * dispatcher), the payment's refund aggregates and `refundSeq`, the order's
 * refund mirror and the order's cancellation commit as one write set. An
 * unpaid cancellation (`pending_payment`) creates no refund: no money moved. If
 * the payment cannot be refunded safely (no provider payment ID, inconsistent
 * amounts, ...) the cancellation is REFUSED, never completed on a guess.
 * Nothing here calls the provider.
 *
 * Notifications. The same transaction writes the cancellation's outbox event
 * (`order_cancelled_by_customer` or `order_cancelled_by_outlet`, keyed `${orderId}_${type}`),
 * and — for a paid order — the separate `refund_requested` event. An unpaid cancellation has
 * the first only. Neither is written by a repeat or a refusal.
 *
 * Idempotency and races. Cancelling is a one-way, once-only write: the second
 * of two racing requests re-runs against the committed state, finds the order
 * `cancelled` and does nothing — the first one's audit fields and its single
 * refund stand. A payment captured after the cancellation is handled by
 * `payments.ts`'s `markPaymentSucceeded` (late capture), whose transaction reads
 * the same order and payment documents, so the two serialize.
 */

/**
 * The request body of a cancellation. `reason` is validated by
 * `decideCancellation` (after the actor is identified), not here: any other
 * field is stripped, never read.
 */
export const cancelOrderBodySchema = z.object({
  reason: z.unknown().optional(),
});

/**
 * The refund, as a cancelling caller may see it: how much, in what state, and
 * when it started and finished — nothing that identifies the provider, the
 * payment, the idempotency key, or who started it. `status` is the refund's own
 * local status (`requested` until the provider has accepted it).
 */
export interface CancellationRefundSummary {
  status: RefundStatus;
  amountInPaise: number;
  currency: "INR";
  /** ISO time the refund was created. */
  initiatedAt: string;
  /** ISO time the provider settled it; present only once `processed`. */
  completedAt?: string;
}

/** What a cancellation route adds to the order it returns. */
export interface CancellationResponseSummary {
  cancellation: {state: "cancelled"; canCancel: false};
  /** Absent when no money was captured, so no refund exists. */
  refund?: CancellationRefundSummary;
}

/**
 * @param {Refund | null} refund The order's latest refund, if it has one.
 * @return {CancellationRefundSummary | null} The safe summary of it.
 */
export function toRefundSummary(refund: Refund | null): CancellationRefundSummary | null {
  if (refund === null) {
    return null;
  }
  return {
    status: refund.status,
    amountInPaise: refund.amountInPaise,
    currency: refund.currency,
    initiatedAt: refund.createdAt.toDate().toISOString(),
    ...(refund.processedAt !== undefined ? {completedAt: refund.processedAt.toDate().toISOString()} : {}),
  };
}

/**
 * The cancellation block of a route response, from a `cancelOrder` result: the
 * same for the call that cancelled and for a repeat.
 *
 * @param {CancelOrderResult} result What `cancelOrder` returned.
 * @return {CancellationResponseSummary} The fields to add beside `order`.
 */
export function toCancellationResponse(result: CancelOrderResult): CancellationResponseSummary {
  return {
    cancellation: {state: "cancelled", canCancel: false},
    ...(result.refundSummary !== null ? {refund: result.refundSummary} : {}),
  };
}

/**
 * Where an order stands as to cancelling, for the customer who owns it:
 * `cancellable` (they may cancel it right now), `not_cancellable` (past it, for
 * whatever reason) or `cancelled`. `canCancel` is exactly `state === "cancellable"`,
 * spelled out so a client never has to infer it.
 */
export interface OrderCancellationState {
  state: "cancellable" | "not_cancellable" | "cancelled";
  canCancel: boolean;
}

/** What `GET /orders/{orderId}` adds to the order it returns. */
export interface OrderCancellationView {
  cancellation: OrderCancellationState;
  /** Absent when the order has no refund (nothing was captured, or nothing yet refunded). */
  refund?: CancellationRefundSummary;
}

export interface CancelOrderInput {
  /** Who is asking, as the SERVER verified it (a session user, or a membership). */
  actor: CancellationActor;
  /** The order's document ID, from the request path. */
  orderId: unknown;
  /** The requested reason, as received. */
  reason?: unknown;
  /** The transaction's clock; injectable for tests. */
  now?: () => Timestamp;
}

export interface CancelOrderResult {
  /** The order as it stands after the call. */
  order: Order;
  /** `true` if this call wrote the cancellation; `false` for a repeat that changed nothing. */
  changed: boolean;
  /** The order's status when this call read it. */
  previousStatus: OrderStatus;
  /** The refund this call reserved, if any. Internal: for logs and tests, never in a response. */
  refund: {refundId: string; amountInPaise: number} | null;
  /**
   * The order's latest refund — the one this call reserved, or the one an
   * earlier cancellation or late capture left — as the safe summary a response
   * carries. `null` when the order has no refund.
   */
  refundSummary: CancellationRefundSummary | null;
}

/** How the order's payment document read. */
type PaymentRead =
  | {kind: "absent"}
  | {kind: "ok"; payment: Payment}
  | {kind: "malformed"};

/**
 * @param {Transaction} tx The in-progress transaction.
 * @param {DocumentReference} paymentRef The payment's document reference.
 * @param {Order} order The order the payment belongs to.
 * @return {Promise<PaymentRead>} The payment, if there is a valid one.
 */
async function readPayment(
  tx: Transaction,
  paymentRef: DocumentReference,
  order: Order,
): Promise<PaymentRead> {
  const snapshot = await tx.get(paymentRef);
  if (!snapshot.exists) {
    return {kind: "absent"};
  }
  try {
    return {
      kind: "ok",
      payment: parsePayment(snapshot.data(), order.id, order.id, order.organizationId, order.outletId, order.menuId),
    };
  } catch (error) {
    logger.error("An order's payment document is malformed; not cancelling on a guess.", {orderId: order.id, error});
    return {kind: "malformed"};
  }
}

/**
 * The order's latest refund (the payment's highest `refundSeq`), read in the
 * transaction. A missing or unreadable one is logged and left out of the
 * summary: a repeat of a cancellation must not turn into a 500 over a summary.
 *
 * @param {Transaction} tx The in-progress transaction.
 * @param {DocumentReference} paymentRef The payment's document reference.
 * @param {PaymentRead} paymentRead How the order's payment read.
 * @param {Order} order The order.
 * @return {Promise<Refund | null>} The latest refund, if the order has one.
 */
async function readLatestRefund(
  tx: Transaction,
  paymentRef: DocumentReference,
  paymentRead: PaymentRead,
  order: Order,
): Promise<Refund | null> {
  const seq = paymentRead.kind === "ok" ? paymentRead.payment.refundSeq ?? 0 : 0;
  if (paymentRead.kind !== "ok" || seq < 1) {
    return null;
  }
  const refundId = refundIdFor(order.id, seq);
  const snapshot = await tx.get(paymentRef.collection("refunds").doc(refundId));
  if (!snapshot.exists) {
    logger.error("A payment's latest refund is missing.", {orderId: order.id, refundId});
    return null;
  }
  try {
    return parseRefund(
      snapshot.data(), refundId, paymentRead.payment.id, order.id, order.organizationId, order.outletId, order.menuId,
    );
  } catch (error) {
    logger.error("A payment's latest refund is malformed.", {orderId: order.id, refundId, error});
    return null;
  }
}

/**
 * The deadline a customer's cancellation is measured against: the order's own
 * menu's `orderingClosesAt`, read in the transaction. `Invalid Date` when the
 * menu is missing or unreadable, which `decideCancellation` treats as closed.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The in-progress transaction.
 * @param {Order} order The order.
 * @return {Promise<Date>} The deadline, or an invalid date.
 */
async function readOrderingDeadline(db: Firestore, tx: Transaction, order: Order): Promise<Date> {
  const snapshot = await tx.get(
    db.collection("organizations").doc(order.organizationId)
      .collection("outlets").doc(order.outletId)
      .collection("menus").doc(order.menuId),
  );
  if (!snapshot.exists) {
    logger.warn("An order's menu is missing; the customer deadline is treated as passed.", {orderId: order.id});
    return new Date(NaN);
  }
  try {
    return parseMenu(snapshot.data(), order.menuId, order.organizationId, order.outletId).orderingClosesAt.toDate();
  } catch (error) {
    logger.warn("An order's menu is unreadable; the customer deadline is treated as passed.", {orderId: order.id, error});
    return new Date(NaN);
  }
}

/**
 * Cancels an order on behalf of a verified actor — the single authoritative
 * implementation of the `-> cancelled` transition (see the module doc comment).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {CancelOrderInput} input The verified actor, the order and the reason.
 * @return {Promise<CancelOrderResult>} The resulting order.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed `orderId` or an
 *   invalid/missing reason; `not-found` (404) if there is no such order or it
 *   is not the actor's (another customer's, another organization's —
 *   indistinguishable); `permission-denied` (403) for a member without a
 *   cancellation role; `aborted` (409) if the order's state does not allow the
 *   cancellation (see `cancellationRefusalToHttpsError`), the payment cannot be
 *   refunded safely, or the write lost a race it could not retry past.
 * @throws {Error} If stored data is corrupt in a way no caller can fix
 *   (a malformed payment on an order that would otherwise be cancelled, an
 *   order ID that cannot form a refund ID): fails loudly, writes nothing.
 */
export async function cancelOrder(db: Firestore, input: CancelOrderInput): Promise<CancelOrderResult> {
  const {actor, orderId} = input;
  if (!isValidDocumentId(orderId)) {
    throw new HttpsError("invalid-argument", "Invalid order ID.");
  }
  const clock = input.now ?? Timestamp.now;

  try {
    return await db.runTransaction(async (tx): Promise<CancelOrderResult> => {
      // ---- reads (a transaction must read everything before it writes) ----
      const {order, orderRef} = await resolveOrderById(db, tx, orderId);
      const paymentRef = orderRef.collection("payments").doc(order.id);
      const paymentRead = await readPayment(tx, paymentRef, order);
      const orderingClosesAt = actor.kind === "customer" && order.status === "confirmed" ?
        await readOrderingDeadline(db, tx, order) :
        new Date(NaN);
      const now = clock();

      // ---- the decision: identity and reason first, then state, then payment ----
      const paymentStatus: PaymentStatus | "absent" = paymentRead.kind === "ok" ? paymentRead.payment.status : "absent";
      const decision = decideCancellation({
        actor,
        order,
        paymentStatus,
        orderingClosesAt,
        now: now.toDate(),
        reason: input.reason,
      });

      if (decision.outcome === "refuse") {
        throw cancellationRefusalToHttpsError(decision.code);
      }
      if (decision.outcome === "already_cancelled") {
        const latest = await readLatestRefund(tx, paymentRef, paymentRead, order);
        return {order, changed: false, previousStatus: order.status, refund: null, refundSummary: toRefundSummary(latest)};
      }
      if (paymentRead.kind === "malformed") {
        throw new Error(`Malformed payment document under order ${order.id}; refusing to cancel it.`);
      }

      // ---- the money, for a paid order ----
      let orderUpdates: Partial<Order> = buildOrderCancellationFields(decision, now);
      let refund: CancelOrderResult["refund"] = null;
      let createdRefund: Refund | null = null;
      if (decision.refund === "required") {
        if (paymentRead.kind !== "ok") {
          // Unreachable: a paid status with no valid succeeded payment was refused above.
          throw cancellationRefusalToHttpsError("payment_state_inconsistent");
        }
        const payment = paymentRead.payment;
        const slot = await readNextRefundSlot(tx, paymentRef, payment);
        const plan = planRefundCreation({
          order,
          payment,
          slot,
          reason: decision.cancelledByRole === "customer" ? "customer_cancelled" : "outlet_cancelled",
          source: "cancellation",
          initiatedBy: decision.cancelledBy,
          initiatedByRole: decision.cancelledByRole,
          now,
        });
        if (plan.kind === "not_refundable") {
          logger.warn("A paid order's payment cannot be refunded; refusing to cancel it.", {
            orderId: order.id, reason: plan.reason,
          });
          throw cancellationRefusalToHttpsError("payment_state_inconsistent");
        }
        if (plan.mirror !== null) {
          orderUpdates = {...orderUpdates, ...plan.mirror};
        }
        if (plan.kind === "create") {
          tx.create(plan.refundRef, plan.refund);
          recordRefundNotificationEvent(plan.refundRef.firestore, tx, plan.refund, "refund_requested", now);
          tx.update(paymentRef, plan.paymentUpdate);
          refund = {refundId: plan.refund.id, amountInPaise: plan.refund.amountInPaise};
          createdRefund = plan.refund;
        }
      }
      // Nothing is written until here on a path that created no refund, so this read is still legal.
      const summarized = createdRefund ?? await readLatestRefund(tx, paymentRef, paymentRead, order);

      tx.update(orderRef, orderUpdates);
      // The cancellation's own outbox event, in this same transaction: it exists iff the order
      // really moved to `cancelled`. Who cancelled decides who is told (see the policy); the
      // refund (if any) has its own, separate `refund_requested` event above.
      recordCancellationNotificationEvent(
        db, tx, {...order, ...orderUpdates},
        decision.cancelledByRole === "customer" ? "order_cancelled_by_customer" : "order_cancelled_by_outlet",
        now, createdRefund !== null,
      );
      return {
        order: {...order, ...orderUpdates},
        changed: true,
        previousStatus: order.status,
        refund,
        refundSummary: toRefundSummary(summarized),
      };
    });
  } catch (error) {
    if (!(error instanceof HttpsError) && isFirestoreAborted(error)) {
      throw new HttpsError(
        "aborted",
        "This order was just changed by someone else. Refresh and try again.",
      );
    }
    throw error;
  }
}

/**
 * The cancellation hint and refund summary for an order its customer is reading
 * (`GET /orders/{orderId}`): the SAME policy as `cancelOrder` — `decideCancellation`
 * — evaluated on the same facts (the order, its payment, and for a `confirmed`
 * order its menu's `orderingClosesAt`), but read-only and answering "could they
 * cancel it now?" rather than doing it. The caller has already established that
 * the customer owns `order`; nothing here is read from the request.
 *
 * It is a hint for the screen, never the authority: `cancelOrder` re-decides
 * inside its own transaction, so an order that stops being cancellable between
 * this read and the customer's tap is still refused there (`409`).
 *
 * One read-only transaction, so the payment, the refund and the deadline are a
 * single consistent snapshot. A payment document that is missing or unreadable
 * simply makes the order `not_cancellable` (the policy's own payment-consistency
 * rule) and leaves the refund out; it never fails the read.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Order} order The order, already known to belong to the caller.
 * @param {Date} now The clock; injectable for tests.
 * @return {Promise<OrderCancellationView>} The cancellation state and, if the order has one, its refund summary.
 */
export async function readOrderCancellationView(
  db: Firestore,
  order: Order,
  now: Date = new Date(),
): Promise<OrderCancellationView> {
  return db.runTransaction(async (tx): Promise<OrderCancellationView> => {
    const paymentRef = db
      .collection("organizations").doc(order.organizationId)
      .collection("outlets").doc(order.outletId)
      .collection("menus").doc(order.menuId)
      .collection("orders").doc(order.id)
      .collection("payments").doc(order.id);
    const paymentRead = await readPayment(tx, paymentRef, order);
    const orderingClosesAt = order.status === "confirmed" ?
      await readOrderingDeadline(db, tx, order) :
      new Date(NaN);
    const latestRefund = await readLatestRefund(tx, paymentRef, paymentRead, order);

    const decision = decideCancellation({
      actor: {kind: "customer", userId: order.userId},
      order,
      paymentStatus: paymentRead.kind === "ok" ? paymentRead.payment.status : "absent",
      orderingClosesAt,
      now,
    });
    const state: OrderCancellationState["state"] =
      decision.outcome === "cancel" ? "cancellable" :
        decision.outcome === "already_cancelled" ? "cancelled" : "not_cancellable";
    const refund = toRefundSummary(latestRefund);
    return {
      cancellation: {state, canCancel: state === "cancellable"},
      ...(refund !== null ? {refund} : {}),
    };
  }, {readOnly: true});
}

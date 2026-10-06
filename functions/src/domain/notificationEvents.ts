import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {z} from "zod";
import type {Order} from "./orders";
import type {Refund} from "./refunds";

/**
 * The notification OUTBOX: `notificationEvents/{orderId}_{eventType}`.
 *
 * When an order makes a real, committed state transition, the SAME Firestore
 * transaction that writes the new status also writes one event document here
 * (`recordNotificationEvent`). Because the two writes commit together, an event
 * exists if and only if the transition happened: a rolled-back transaction
 * leaves no event, and a transition can never be committed without one. The
 * event is then picked up by the Firestore trigger (`onNotificationEventCreated`
 * in `index.ts`), which runs `domain/notificationProcessor.ts` — entirely
 * outside the transition, so a notification failure can never fail or undo an
 * order transition (the order is already committed when processing starts).
 *
 * The event carries only the coordinates of the order and who ordered it: no
 * phone/email, no payment or provider fields, no pickup credential, no item
 * snapshots. The order itself stays the single source of truth.
 *
 * Identity. An order moves through its statuses once and only forward, so a
 * (order, event type) pair can happen at most once: `${orderId}_${eventType}`
 * is the document ID. A replayed or repeated transition is a no-op in the
 * transition code and never reaches `recordNotificationEvent`; and even if it
 * did, the write is a `set` on the same deterministic ID, so it could not
 * create a second event. Backend-only: see firestore.rules.
 */

export const NOTIFICATION_EVENTS_COLLECTION = "notificationEvents";

/**
 * Every event the order's FORWARD lifecycle emits (confirmed -> ... -> completed).
 * Cancellation and refund events are separate families below: they are not steps
 * of this progression and are never ranked against it.
 */
export const NOTIFICATION_EVENT_TYPES = [
  "order_confirmed",
  "order_preparing",
  "order_ready",
  "order_picked_up",
  "order_completed",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * The order CANCELLATION events: terminal business facts, one per cancelled order, keyed
 * like the order events (`${orderId}_${type}`) and written in the cancelling transaction
 * itself. The type records WHO cancelled, because that decides who is told:
 * - `order_cancelled_by_customer`: the customer cancelled their own order (the
 *   organization is told; the customer, who did it, is not);
 * - `order_cancelled_by_outlet`: an organization owner/manager cancelled it (the customer
 *   is told);
 * - `order_cancelled_by_system`: reserved for a future automatic cancellation (e.g. an
 *   expiring unpaid order). No producer exists yet; the policy is ready for one.
 * A cancellation is NOT a refund: a paid cancellation additionally gets the separate refund
 * events below, an unpaid one gets none.
 */
export const CANCELLATION_NOTIFICATION_EVENT_TYPES = [
  "order_cancelled_by_customer",
  "order_cancelled_by_outlet",
  "order_cancelled_by_system",
] as const;
export type CancellationNotificationEventType = (typeof CANCELLATION_NOTIFICATION_EVENT_TYPES)[number];

/**
 * @param {unknown} value A candidate event type.
 * @return {boolean} Whether it is one of `CANCELLATION_NOTIFICATION_EVENT_TYPES`.
 */
export function isCancellationNotificationEventType(value: unknown): value is CancellationNotificationEventType {
  return typeof value === "string" && (CANCELLATION_NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The refund lifecycle events — the producer boundary for the refund
 * notifications. Same outbox, same conventions, one event per
 * logical fact, keyed by the REFUND (`${refundId}_${type}`), written in the same
 * transaction as the refund transition it reports:
 * - `refund_requested`: a refund was created (a cancellation or a late capture reserved
 *   money for it, or a failed one was retried);
 * - `refund_completed`: the provider settled it (`processed`);
 * - `refund_failed`: it ended `failed` (the provider refused it or reported it failed).
 * A refund moving to `pending` is internal progress and has no event; a refund adopted
 * from the provider's own records (made outside Zesto) has none either — its provenance
 * is uncertain and it is flagged for a person instead.
 *
 * `notificationProcessor.ts` consumes all three; `notificationPolicy.ts` decides who sees what
 * (`refund_requested` is consumed without producing any visible notification).
 */
export const REFUND_NOTIFICATION_EVENT_TYPES = [
  "refund_requested",
  "refund_completed",
  "refund_failed",
] as const;
export type RefundNotificationEventType = (typeof REFUND_NOTIFICATION_EVENT_TYPES)[number];

/** Every type an outbox event can have. */
export type AnyNotificationEventType =
  NotificationEventType | CancellationNotificationEventType | RefundNotificationEventType;

/**
 * @param {unknown} value A candidate event type.
 * @return {boolean} Whether it is one of `REFUND_NOTIFICATION_EVENT_TYPES`.
 */
export function isRefundNotificationEventType(value: unknown): value is RefundNotificationEventType {
  return typeof value === "string" && (REFUND_NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

export type NotificationEventStatus = "pending" | "processed" | "failed";
const EVENT_STATUS_VALUES = ["pending", "processed", "failed"] as const;

/** Longest `lastError` kept on an event (bounded; never a stack trace). */
export const NOTIFICATION_EVENT_ERROR_MAX_LENGTH = 300;

export interface NotificationEvent {
  id: string;
  type: AnyNotificationEventType;
  orderId: string;
  organizationId: string;
  outletId: string;
  menuId: string;
  /** The customer who placed the order (the order's own `userId`). */
  customerUserId: string;
  /** When the transition committed. */
  occurredAt: Timestamp;
  status: NotificationEventStatus;
  /** How many processing attempts have been started (see `notificationProcessor.ts`). */
  attempts: number;
  lastAttemptAt?: Timestamp;
  lastError?: string;
  processedAt?: Timestamp;
  /**
   * Refund events only (all absent on an order event; `refundId` and `paymentId`
   * are always present on a refund event). Internal references: IDs and an amount,
   * nothing about the customer, no provider payload.
   */
  refundId?: string;
  paymentId?: string;
  providerPaymentId?: string;
  /** Present once the provider has given the refund an ID (always for `refund_completed`). */
  providerRefundId?: string;
  amountInPaise?: number;
  /**
   * Cancellation events only: whether the cancelling transaction also reserved a refund
   * (money had been captured), so the cancellation copy may say a refund was started.
   */
  refundInitiated?: boolean;
}

/** An outbox event about an order's own forward lifecycle (the original kind). */
export type OrderNotificationEvent = NotificationEvent & {type: NotificationEventType};

/** An outbox event about an order's cancellation. */
export type CancellationNotificationEvent = NotificationEvent & {type: CancellationNotificationEventType};

/** An outbox event about a refund's lifecycle; `refundId` and `paymentId` are always set. */
export type RefundNotificationEvent = NotificationEvent & {
  type: RefundNotificationEventType;
  refundId: string;
  paymentId: string;
};

/**
 * @param {string} orderId The order's document ID.
 * @param {NotificationEventType | CancellationNotificationEventType} type The event type.
 * @return {string} The event's deterministic document ID.
 */
export function notificationEventId(
  orderId: string,
  type: NotificationEventType | CancellationNotificationEventType,
): string {
  return `${orderId}_${type}`;
}

/**
 * @param {string} refundId The refund's document ID (`${orderId}-r${seq}`).
 * @param {RefundNotificationEventType} type The refund event type.
 * @return {string} The event's deterministic document ID: a refund reaches each
 *   event's state at most once, so `(refund, type)` is one logical event.
 */
export function refundNotificationEventId(refundId: string, type: RefundNotificationEventType): string {
  return `${refundId}_${type}`;
}

/**
 * @param {unknown} value A candidate event type.
 * @return {boolean} Whether it is one of `NOTIFICATION_EVENT_TYPES`.
 */
export function isNotificationEventType(value: unknown): value is NotificationEventType {
  return typeof value === "string" && (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Builds the event for a committed order transition. Pure.
 *
 * @param {Order} order The order as it stands AFTER the transition (its
 *   authoritative `userId` and path coordinates are copied, nothing else).
 * @param {NotificationEventType | CancellationNotificationEventType} type The event type.
 * @param {Timestamp} occurredAt The transition's timestamp (the one written
 *   to the order's own `updatedAt`).
 * @return {NotificationEvent} The pending event to store.
 */
export function buildNotificationEvent(
  order: Order,
  type: NotificationEventType | CancellationNotificationEventType,
  occurredAt: Timestamp,
): NotificationEvent {
  return {
    id: notificationEventId(order.id, type),
    type,
    orderId: order.id,
    organizationId: order.organizationId,
    outletId: order.outletId,
    menuId: order.menuId,
    customerUserId: order.userId,
    occurredAt,
    status: "pending",
    attempts: 0,
  };
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} eventId The event's document ID.
 * @return {DocumentReference} The event's document reference.
 */
export function notificationEventRef(db: Firestore, eventId: string): DocumentReference {
  return db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId);
}

/**
 * Records the outbox event for a transition INSIDE the transition's own
 * transaction. Call it only on the branch that actually writes the new status
 * — never on a no-op, a refusal, or a replay — and only once the order's own
 * write has been queued, so the two commit or roll back together.
 *
 * This is one buffered write (`set`, not `create`): it adds no read to the
 * transaction, and it cannot fail the transition by colliding with an existing
 * document. Deterministic ID + buffered write means a transaction body that
 * Firestore re-runs after contention still produces exactly one event.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The transition's in-progress transaction.
 * @param {Order} order The order as it stands after the transition.
 * @param {NotificationEventType} type The transition's event type.
 * @param {Timestamp} occurredAt The transition's timestamp.
 */
export function recordNotificationEvent(
  db: Firestore,
  tx: Transaction,
  order: Order,
  type: NotificationEventType,
  occurredAt: Timestamp,
): void {
  const event = buildNotificationEvent(order, type, occurredAt);
  tx.set(notificationEventRef(db, event.id), event);
}

/**
 * Builds the event for a committed order cancellation. Pure.
 *
 * @param {Order} order The order as it stands AFTER the cancellation.
 * @param {CancellationNotificationEventType} type Who cancelled, as an event type.
 * @param {Timestamp} occurredAt The cancellation's timestamp (the order's `cancelledAt`).
 * @param {boolean} refundInitiated Whether the same transaction reserved a refund.
 * @return {CancellationNotificationEvent} The pending event to store.
 */
export function buildCancellationNotificationEvent(
  order: Order,
  type: CancellationNotificationEventType,
  occurredAt: Timestamp,
  refundInitiated: boolean,
): CancellationNotificationEvent {
  return {
    ...buildNotificationEvent(order, type, occurredAt),
    type,
    refundInitiated,
  };
}

/**
 * Records the cancellation's outbox event INSIDE the cancelling transaction — the contract of
 * `recordNotificationEvent`: only on the branch that really writes the cancellation, after the
 * order write is queued; one buffered `set` on a deterministic ID, so a re-run transaction or a
 * repeat (which never reaches this call: a repeat is a no-op) cannot produce a second event.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The cancelling transaction.
 * @param {Order} order The order as it stands after the cancellation.
 * @param {CancellationNotificationEventType} type Who cancelled, as an event type.
 * @param {Timestamp} occurredAt The cancellation's timestamp.
 * @param {boolean} refundInitiated Whether the same transaction reserved a refund.
 */
export function recordCancellationNotificationEvent(
  db: Firestore,
  tx: Transaction,
  order: Order,
  type: CancellationNotificationEventType,
  occurredAt: Timestamp,
  refundInitiated: boolean,
): void {
  const event = buildCancellationNotificationEvent(order, type, occurredAt, refundInitiated);
  tx.set(notificationEventRef(db, event.id), event);
}

/**
 * Builds the event for a committed refund transition. Pure.
 *
 * @param {Refund} refund The refund as it stands AFTER the transition (its
 *   authoritative coordinates, customer and provider references are copied).
 * @param {RefundNotificationEventType} type The event type.
 * @param {Timestamp} occurredAt The transition's timestamp.
 * @return {RefundNotificationEvent} The pending event to store.
 */
export function buildRefundNotificationEvent(
  refund: Refund,
  type: RefundNotificationEventType,
  occurredAt: Timestamp,
): RefundNotificationEvent {
  return {
    id: refundNotificationEventId(refund.id, type),
    type,
    orderId: refund.orderId,
    organizationId: refund.organizationId,
    outletId: refund.outletId,
    menuId: refund.menuId,
    customerUserId: refund.userId,
    occurredAt,
    status: "pending",
    attempts: 0,
    refundId: refund.id,
    paymentId: refund.paymentId,
    providerPaymentId: refund.providerPaymentId,
    ...(refund.providerRefundId !== undefined ? {providerRefundId: refund.providerRefundId} : {}),
    amountInPaise: refund.amountInPaise,
  };
}

/**
 * Records the outbox event for a refund transition INSIDE the transition's own
 * transaction — exactly the contract of `recordNotificationEvent`: call it only on the
 * branch that really writes the new refund state, after that write is queued, so both
 * commit or roll back together; one buffered `set` on a deterministic ID, so a
 * re-run transaction or a repeated delivery can never produce a second logical event
 * (a repeat never reaches this call: it is a no-op transition).
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The transition's in-progress transaction.
 * @param {Refund} refund The refund as it stands after the transition.
 * @param {RefundNotificationEventType} type The event type.
 * @param {Timestamp} occurredAt The transition's timestamp.
 */
export function recordRefundNotificationEvent(
  db: Firestore,
  tx: Transaction,
  refund: Refund,
  type: RefundNotificationEventType,
  occurredAt: Timestamp,
): void {
  const event = buildRefundNotificationEvent(refund, type, occurredAt);
  tx.set(notificationEventRef(db, event.id), event);
}

const timestampSchema = (field: string) => z.custom<Timestamp>(
  (value) => value instanceof Timestamp,
  `${field} must be a Firestore Timestamp`,
);

const eventDocSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    ...NOTIFICATION_EVENT_TYPES,
    ...CANCELLATION_NOTIFICATION_EVENT_TYPES,
    ...REFUND_NOTIFICATION_EVENT_TYPES,
  ]),
  orderId: z.string().min(1),
  organizationId: z.string().min(1),
  outletId: z.string().min(1),
  menuId: z.string().min(1),
  customerUserId: z.string().min(1),
  occurredAt: timestampSchema("occurredAt"),
  status: z.enum(EVENT_STATUS_VALUES),
  attempts: z.number().int().min(0),
  lastAttemptAt: timestampSchema("lastAttemptAt").optional(),
  lastError: z.string().max(NOTIFICATION_EVENT_ERROR_MAX_LENGTH).optional(),
  processedAt: timestampSchema("processedAt").optional(),
  refundId: z.string().min(1).optional(),
  paymentId: z.string().min(1).optional(),
  providerPaymentId: z.string().min(1).optional(),
  providerRefundId: z.string().min(1).optional(),
  amountInPaise: z.number().int().min(1).optional(),
  refundInitiated: z.boolean().optional(),
});

/**
 * Parses a stored event, checking it was written in the expected shape and that
 * its `id` is both the document ID it was read from and the deterministic ID
 * its own subject (the order, or for a refund event the refund) and type imply.
 * A refund event must carry its refund and payment IDs; an order or cancellation event must
 * carry none of them, and only a cancellation event may carry `refundInitiated`.
 *
 * @param {unknown} data The document's raw field data.
 * @param {string} expectedId The document ID it was read from.
 * @return {NotificationEvent} The parsed event.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parseNotificationEvent(data: unknown, expectedId: string): NotificationEvent {
  const parsed = eventDocSchema.safeParse(data);
  const malformed = (): Error =>
    new Error(`Malformed notification event at ${NOTIFICATION_EVENTS_COLLECTION}/${expectedId}.`);
  if (!parsed.success || parsed.data.id !== expectedId) {
    throw malformed();
  }
  const event = parsed.data;
  if (isRefundNotificationEventType(event.type)) {
    if (
      event.refundId === undefined ||
      event.paymentId === undefined ||
      refundNotificationEventId(event.refundId, event.type) !== expectedId
    ) {
      throw malformed();
    }
    if (event.refundInitiated !== undefined) {
      throw malformed();
    }
  } else if (
    notificationEventId(event.orderId, event.type) !== expectedId ||
    event.refundId !== undefined || event.paymentId !== undefined ||
    event.providerPaymentId !== undefined || event.providerRefundId !== undefined || event.amountInPaise !== undefined ||
    (event.refundInitiated !== undefined && !isCancellationNotificationEventType(event.type))
  ) {
    throw malformed();
  }
  return event;
}

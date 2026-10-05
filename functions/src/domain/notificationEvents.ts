import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {z} from "zod";
import type {Order} from "./orders";

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
 * Every event the order lifecycle emits. Cancellation/refund events are a
 * later feature and deliberately not here.
 */
export const NOTIFICATION_EVENT_TYPES = [
  "order_confirmed",
  "order_preparing",
  "order_ready",
  "order_picked_up",
  "order_completed",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export type NotificationEventStatus = "pending" | "processed" | "failed";
const EVENT_STATUS_VALUES = ["pending", "processed", "failed"] as const;

/** Longest `lastError` kept on an event (bounded; never a stack trace). */
export const NOTIFICATION_EVENT_ERROR_MAX_LENGTH = 300;

export interface NotificationEvent {
  id: string;
  type: NotificationEventType;
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
}

/**
 * @param {string} orderId The order's document ID.
 * @param {NotificationEventType} type The event type.
 * @return {string} The event's deterministic document ID.
 */
export function notificationEventId(orderId: string, type: NotificationEventType): string {
  return `${orderId}_${type}`;
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
 * @param {NotificationEventType} type The transition's event type.
 * @param {Timestamp} occurredAt The transition's timestamp (the one written
 *   to the order's own `updatedAt`).
 * @return {NotificationEvent} The pending event to store.
 */
export function buildNotificationEvent(
  order: Order,
  type: NotificationEventType,
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

const timestampSchema = (field: string) => z.custom<Timestamp>(
  (value) => value instanceof Timestamp,
  `${field} must be a Firestore Timestamp`,
);

const eventDocSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NOTIFICATION_EVENT_TYPES),
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
});

/**
 * Parses a stored event, checking it was written in the expected shape and that
 * its `id` is both the document ID it was read from and the deterministic ID
 * its own order and type imply.
 *
 * @param {unknown} data The document's raw field data.
 * @param {string} expectedId The document ID it was read from.
 * @return {NotificationEvent} The parsed event.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parseNotificationEvent(data: unknown, expectedId: string): NotificationEvent {
  const parsed = eventDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== expectedId ||
    notificationEventId(parsed.data.orderId, parsed.data.type) !== expectedId
  ) {
    throw new Error(`Malformed notification event at ${NOTIFICATION_EVENTS_COLLECTION}/${expectedId}.`);
  }
  return parsed.data;
}

import {FieldValue, Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {isValidDocumentId} from "../auth/membership";
import {inAppChannel, type NotificationChannel, type NotificationDelivery} from "./notificationChannels";
import {
  NOTIFICATION_EVENT_ERROR_MAX_LENGTH,
  notificationEventRef,
  parseNotificationEvent,
  type NotificationEvent,
  type NotificationEventType,
} from "./notificationEvents";
import {
  NOTIFICATION_ORG_ROLES,
  notificationsForEvent,
  type NotificationDraft,
} from "./notificationPolicy";
import {
  customerScope,
  notificationExpiry,
  notificationId,
  organizationScope,
  type Notification,
} from "./notifications";

/**
 * Turns one outbox event (`domain/notificationEvents.ts`) into visible
 * notifications. Run by the `notificationEvents/{eventId}` Firestore trigger
 * (`onNotificationEventCreated` in `index.ts`) and nothing else; it processes
 * exactly the event it is handed and never looks at any other order.
 *
 * Guarantee: AT-LEAST-ONCE processing with DETERMINISTIC visible notification
 * creation. The trigger (and a retry after a crash) may run this for the same
 * event more than once; every notification has a deterministic ID and is
 * created with `create` semantics, so however many times it runs, each
 * recipient ends up with exactly one notification per (event, audience), and a
 * retry never resets an already-read one. This is NOT exactly-once delivery.
 *
 * Failure model. Processing happens strictly after the order transition has
 * committed (the event was written in that transition's own transaction), so a
 * failure here can never fail or undo a transition — the order is already
 * `confirmed`/`ready`/... whatever happens below.
 * - Every run first CLAIMS an attempt (`attempts` + 1, `lastAttemptAt`) before
 *   doing any work, so the cap holds even if the process dies mid-run.
 * - A TRANSIENT failure (Firestore unavailable, ...) records a bounded
 *   `lastError` and is rethrown, so the platform's retry-with-backoff runs the
 *   event again — up to `MAX_NOTIFICATION_ATTEMPTS` times in total.
 * - A PERMANENT failure (a malformed event, an order that is not what the event
 *   says, more recipients than the cap) or a failed final attempt marks the
 *   event `failed`, logs at error severity, and RETURNS: it is not rethrown, so
 *   the platform stops retrying. There is no hot loop. A `failed` event stays
 *   in place for a human; reprocessing it by hand is safe because delivery is
 *   idempotent.
 */

/** Total processing attempts an event gets, the first included. */
export const MAX_NOTIFICATION_ATTEMPTS = 5;

/** The most active members one organization notification is delivered to. */
export const NOTIFICATION_RECIPIENT_CAP = 200;

/** A failure retrying cannot fix. */
export class PermanentNotificationError extends Error {
  /** @param {string} message What is wrong (bounded and stored on the event). */
  constructor(message: string) {
    super(message);
    this.name = "PermanentNotificationError";
  }
}

export type ProcessNotificationEventResult =
  | {kind: "processed"; delivered: number}
  | {kind: "skipped"; reason: "missing" | "already_processed" | "already_failed"}
  | {kind: "failed"; reason: string};

export interface ProcessNotificationEventOptions {
  /** Delivery channels; defaults to in-app only. Injectable for tests. */
  channels?: readonly NotificationChannel[];
  /** Injected clock, for tests. */
  now?: () => Timestamp;
}

/** How far each status a transition produces has progressed in the order lifecycle. */
const EVENT_STATUS_RANK: Readonly<Record<NotificationEventType, number>> = {
  order_confirmed: 1,
  order_preparing: 2,
  order_ready: 3,
  order_picked_up: 4,
  order_completed: 5,
};
const ORDER_STATUS_RANK: Readonly<Record<string, number>> = {
  confirmed: 1,
  preparing: 2,
  ready: 3,
  picked_up: 4,
  completed: 5,
};

/**
 * @param {unknown} error A thrown value.
 * @return {string} A bounded, single-line description safe to store on the
 *   event and log: the message only, never a stack.
 */
export function describeNotificationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, NOTIFICATION_EVENT_ERROR_MAX_LENGTH) || "Unknown error";
}

/** What to do with an event a processor run has just read. */
export type AttemptDecision = "start" | "skip_processed" | "skip_failed" | "give_up";

/**
 * Decides, from an event's stored state alone, whether this run may start an
 * attempt. Pure.
 *
 * @param {NotificationEvent} event The event as stored.
 * @return {AttemptDecision} `start` for a `pending` event under the cap;
 *   `give_up` for a `pending` one that has already used every attempt (the
 *   cap holds even if earlier runs died before recording an outcome); the
 *   others for an event already settled.
 */
export function decideAttempt(event: NotificationEvent): AttemptDecision {
  if (event.status === "processed") {
    return "skip_processed";
  }
  if (event.status === "failed") {
    return "skip_failed";
  }
  return event.attempts >= MAX_NOTIFICATION_ATTEMPTS ? "give_up" : "start";
}

/** What to do about a failed attempt: run again later, or stop for good. */
export type FailureDisposition = "retry" | "fail";

/**
 * Classifies a failed attempt. Pure.
 *
 * @param {unknown} error What the attempt threw.
 * @param {number} attempts How many attempts the event has now used,
 *   including the one that just failed.
 * @return {FailureDisposition} `fail` for a permanent error or once the cap is
 *   used up; `retry` for any other (transient) error with attempts left.
 */
export function dispositionForFailure(error: unknown, attempts: number): FailureDisposition {
  return error instanceof PermanentNotificationError || attempts >= MAX_NOTIFICATION_ATTEMPTS ? "fail" : "retry";
}

/** What claiming an attempt concluded. */
type Claim =
  | {kind: "claimed"; event: NotificationEvent}
  | Extract<ProcessNotificationEventResult, {kind: "skipped" | "failed"}>;

/**
 * Starts an attempt, in one transaction: reads the event and — if it is
 * `pending` and under the cap — counts the attempt before any work happens.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {DocumentReference} ref The event's reference.
 * @param {Timestamp} now The attempt's timestamp.
 * @return {Promise<Claim>} Whether to proceed, and with which event.
 */
async function claimAttempt(db: Firestore, ref: DocumentReference, now: Timestamp): Promise<Claim> {
  return db.runTransaction(async (tx): Promise<Claim> => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      return {kind: "skipped", reason: "missing"};
    }

    let event: NotificationEvent;
    try {
      event = parseNotificationEvent(snapshot.data(), snapshot.id);
    } catch (error) {
      const reason = describeNotificationError(error);
      tx.update(ref, {status: "failed", lastAttemptAt: now, lastError: reason});
      return {kind: "failed", reason};
    }

    const decision = decideAttempt(event);
    if (decision === "skip_processed") {
      return {kind: "skipped", reason: "already_processed"};
    }
    if (decision === "skip_failed") {
      return {kind: "skipped", reason: "already_failed"};
    }
    if (decision === "give_up") {
      const reason = `Gave up after ${event.attempts} attempts.`;
      tx.update(ref, {status: "failed", lastAttemptAt: now, lastError: reason});
      return {kind: "failed", reason};
    }

    tx.update(ref, {attempts: event.attempts + 1, lastAttemptAt: now});
    return {kind: "claimed", event: {...event, attempts: event.attempts + 1, lastAttemptAt: now}};
  });
}

/**
 * Confirms the event describes something that really happened to a real order:
 * the order exists where the event says, is that customer's, and has reached
 * (or passed) the status the event is about. The event is written by trusted
 * code in the transition's own transaction, so this never fails in practice;
 * it is the guard that keeps a notification from ever being created for a
 * transition that did not happen.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {NotificationEvent} event The event being processed.
 * @throws {PermanentNotificationError} If the order does not bear it out.
 */
async function assertOrderBearsOutEvent(db: Firestore, event: NotificationEvent): Promise<void> {
  const snapshot = await db
    .collection("organizations").doc(event.organizationId)
    .collection("outlets").doc(event.outletId)
    .collection("menus").doc(event.menuId)
    .collection("orders").doc(event.orderId)
    .get();
  if (!snapshot.exists) {
    throw new PermanentNotificationError("The order this event is about does not exist.");
  }
  const order = snapshot.data() ?? {};
  if (order.userId !== event.customerUserId || order.organizationId !== event.organizationId) {
    throw new PermanentNotificationError("The order does not match the event it produced.");
  }
  // A cancelled order has, by definition, been through confirmation (and, once
  // cancellation exists, may have been cancelled from any earlier status).
  if (order.status === "cancelled") {
    return;
  }
  const reached = typeof order.status === "string" ? ORDER_STATUS_RANK[order.status] : undefined;
  if (reached === undefined || reached < EVENT_STATUS_RANK[event.type]) {
    throw new PermanentNotificationError("The order has not reached the status this event reports.");
  }
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {NotificationEvent} event The event being processed.
 * @return {Promise<string | undefined>} The event's outlet's name, if its
 *   document exists — display text only; a missing outlet just drops the
 *   "from <outlet>" wording.
 */
async function readOutletName(db: Firestore, event: NotificationEvent): Promise<string | undefined> {
  const snapshot = await db
    .collection("organizations").doc(event.organizationId)
    .collection("outlets").doc(event.outletId)
    .get();
  const name: unknown = snapshot.data()?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

interface OrganizationRecipients {
  userIds: string[];
  /** Whether more active members exist than `NOTIFICATION_RECIPIENT_CAP`. */
  capExceeded: boolean;
}

/**
 * The organization's CURRENTLY active members with a notifying role, read from
 * `organizations/{organizationId}/members` — never from the request, and never
 * an invited or revoked member.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The event's organization.
 * @return {Promise<OrganizationRecipients>} The recipients, at most the cap.
 */
export async function findOrganizationRecipients(
  db: Firestore,
  organizationId: string,
): Promise<OrganizationRecipients> {
  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("members")
    .where("status", "==", "active")
    .limit(NOTIFICATION_RECIPIENT_CAP + 1)
    .get();

  const capExceeded = snapshot.size > NOTIFICATION_RECIPIENT_CAP;
  const userIds = snapshot.docs
    .slice(0, NOTIFICATION_RECIPIENT_CAP)
    .filter((doc) => {
      const role: unknown = doc.data().role;
      return isValidDocumentId(doc.id) &&
        (NOTIFICATION_ORG_ROLES as readonly unknown[]).includes(role);
    })
    .map((doc) => doc.id);
  return {userIds, capExceeded};
}

/**
 * @param {NotificationEvent} event The event.
 * @param {NotificationDraft} draft One notification the policy produced for it.
 * @return {Notification} The notification document (recipient-independent).
 */
function buildNotification(event: NotificationEvent, draft: NotificationDraft): Notification {
  return {
    id: notificationId(event.id, draft.audience),
    type: draft.type,
    scope: draft.audience === "customer" ? customerScope() : organizationScope(event.organizationId),
    title: draft.title,
    body: draft.body,
    orderId: event.orderId,
    organizationId: event.organizationId,
    outletId: event.outletId,
    eventId: event.id,
    createdAt: event.occurredAt,
    readAt: null,
    expiresAt: notificationExpiry(event.occurredAt),
  };
}

/**
 * The work of one attempt: policy -> recipients -> channels.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {NotificationEvent} event The claimed event.
 * @param {readonly NotificationChannel[]} channels The delivery channels.
 * @return {Promise<number>} How many notifications were handed to the channels.
 * @throws {PermanentNotificationError} For a failure retrying cannot fix. Any
 *   other error is transient.
 */
async function deliverEvent(
  db: Firestore,
  event: NotificationEvent,
  channels: readonly NotificationChannel[],
): Promise<number> {
  // An event the policy shows nothing for (`order_completed`) needs no reads at all.
  if (notificationsForEvent(event.type, {}).length === 0) {
    return 0;
  }

  await assertOrderBearsOutEvent(db, event);
  const drafts = notificationsForEvent(event.type, {outletName: await readOutletName(db, event)});

  const deliveries: NotificationDelivery[] = [];
  let capExceeded = false;
  for (const draft of drafts) {
    const notification = buildNotification(event, draft);
    let recipients: string[];
    if (draft.audience === "customer") {
      recipients = [event.customerUserId];
    } else {
      const found = await findOrganizationRecipients(db, event.organizationId);
      capExceeded = capExceeded || found.capExceeded;
      recipients = found.userIds;
    }
    for (const recipientUserId of recipients) {
      deliveries.push({recipientUserId, notification});
    }
  }

  for (const channel of channels) {
    await channel.deliver(db, deliveries);
  }

  if (capExceeded) {
    // Deliver to the capped set (better than nobody), but never pretend everyone was told.
    throw new PermanentNotificationError(
      `More than ${NOTIFICATION_RECIPIENT_CAP} active members; delivered to the first ${NOTIFICATION_RECIPIENT_CAP} only.`,
    );
  }
  return deliveries.length;
}

/**
 * Processes one outbox event: claim an attempt, deliver, record the outcome.
 * See the module doc comment for the guarantees and the retry model.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} eventId The `notificationEvents` document to process.
 * @param {ProcessNotificationEventOptions} [options] Channels/clock overrides.
 * @return {Promise<ProcessNotificationEventResult>} What happened, when it did
 *   not throw.
 * @throws {unknown} A transient failure with attempts left, so the trigger's
 *   retry runs the event again.
 */
export async function processNotificationEvent(
  db: Firestore,
  eventId: string,
  options: ProcessNotificationEventOptions = {},
): Promise<ProcessNotificationEventResult> {
  const channels = options.channels ?? [inAppChannel];
  const clock = options.now ?? (() => Timestamp.now());

  if (!isValidDocumentId(eventId)) {
    return {kind: "skipped", reason: "missing"};
  }
  const ref = notificationEventRef(db, eventId);

  const claim = await claimAttempt(db, ref, clock());
  if (claim.kind === "failed") {
    logger.error("Notification event could not be processed.", {eventId, reason: claim.reason});
    return claim;
  }
  if (claim.kind === "skipped") {
    return claim;
  }
  const {event} = claim;

  let delivered: number;
  try {
    delivered = await deliverEvent(db, event, channels);
  } catch (error) {
    const reason = describeNotificationError(error);
    const permanent = error instanceof PermanentNotificationError;

    if (dispositionForFailure(error, event.attempts) === "fail") {
      await ref.update({status: "failed", lastAttemptAt: clock(), lastError: reason});
      logger.error("Notification event failed permanently.", {
        eventId, type: event.type, orderId: event.orderId, attempts: event.attempts, permanent, reason,
      });
      return {kind: "failed", reason};
    }

    // Best effort: the attempt is already counted, so losing this note changes nothing.
    await ref.update({lastAttemptAt: clock(), lastError: reason}).catch(() => undefined);
    logger.warn("Notification event failed; it will be retried.", {
      eventId, type: event.type, orderId: event.orderId, attempts: event.attempts, reason,
    });
    throw error;
  }

  await ref.update({
    status: "processed",
    processedAt: clock(),
    lastError: FieldValue.delete(),
  });
  return {kind: "processed", delivered};
}

import {createHash} from "node:crypto";
import {
  FieldPath,
  Timestamp,
  type CollectionReference,
  type Firestore,
  type Query,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";
import {NOTIFICATION_TYPES, type NotificationAudience, type NotificationType} from "./notificationPolicy";

/**
 * The in-app inbox: `users/{userId}/notifications/{eventId}.{audience}`.
 *
 * Nested under the recipient, so isolation is structural: every read and write
 * here derives the path from the VERIFIED session's user (`userId` is never a
 * request value), and there is no path through which one user's request can
 * address another user's inbox. A notification ID from someone else's inbox
 * simply does not exist under the caller's own, and is the same 404 as any
 * other missing one.
 *
 * One person can be both a customer and a staff member (even of the same
 * organization), so a user's inbox holds both kinds, told apart by `scope`:
 * `"customer"`, or `"org:<organizationId>"`. Every list/count/mark operation
 * is for ONE scope, which the route derives (the customer routes: `customer`;
 * the organization routes: the caller's verified membership's organization).
 *
 * Documents are written only by `notificationProcessor.ts`, with `create`
 * semantics, so a retry can never reset `readAt` on an already-read
 * notification. `readAt` is stored as an explicit `null` while unread (an
 * absent field would not match the `readAt == null` queries below).
 *
 * The queries need the composite indexes in `firestore.indexes.json`
 * (`notifications`: `scope` ASC, `createdAt` DESC; and `scope` ASC, `readAt`
 * ASC, `createdAt` DESC); the emulator does not enforce them. The `__name__`
 * tie-break is implicit in those indexes, in the same direction as their last
 * field.
 */

export const NOTIFICATIONS_SUBCOLLECTION = "notifications";

/** Page size when the caller does not ask for one. */
export const NOTIFICATION_DEFAULT_PAGE_SIZE = 20;
/** Hard server-side ceiling on a page, whatever `limit` the caller sends. */
export const NOTIFICATION_MAX_PAGE_SIZE = 50;
/** The unread count stops counting here (the UI shows it as "99+"), so a count is always cheap. */
export const NOTIFICATION_UNREAD_COUNT_CAP = 100;
/** Notifications updated per transaction by `markAllNotificationsRead`. */
export const NOTIFICATION_READ_ALL_BATCH_SIZE = 400;
/** Transactions one `markAllNotificationsRead` call runs at most. */
export const NOTIFICATION_READ_ALL_MAX_BATCHES = 5;
/** How long a notification is kept before it becomes eligible for a TTL policy. */
export const NOTIFICATION_RETENTION_DAYS = 90;

const CURSOR_MAX_LENGTH = 512;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

export interface Notification {
  /** `notificationId(eventId, audience)` — equals the document ID. */
  id: string;
  type: NotificationType;
  /** `"customer"` or `"org:<organizationId>"`. */
  scope: string;
  title: string;
  body: string;
  orderId: string;
  organizationId: string;
  outletId: string;
  eventId: string;
  /** The event's `occurredAt`, so a retried write rebuilds an identical document. */
  createdAt: Timestamp;
  readAt: Timestamp | null;
  expiresAt: Timestamp;
}

/**
 * The client-facing shape of a `Notification`: just what the inbox and a deep
 * link need. No `scope`, `eventId`, `organizationId`, `outletId`, user ID or
 * TTL field.
 */
export interface NotificationResponse {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  orderId: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsPageResponse {
  notifications: NotificationResponse[];
  /** Pass back as `cursor` for the next page; `null` when this is the last. */
  nextCursor: string | null;
}

/** A refund event's ID: `${refundId}_${type}`. The refund ID is internal and must not reach a client. */
const REFUND_EVENT_ID_PATTERN = /_refund_(?:requested|completed|failed)$/;

/**
 * @param {string} eventId The notification event's ID.
 * @param {NotificationAudience} audience Which inbox it is for.
 * @return {string} The notification's deterministic document ID — which is also the ID a client
 *   sees and sends back to mark it read. For an order or cancellation event it is
 *   `${eventId}.${audience}`; for a REFUND event it is an opaque, equally deterministic
 *   `refund-<hash>.${audience}`, so the internal refund ID (`${orderId}-r${seq}`) never appears
 *   in anything a client can read.
 */
export function notificationId(eventId: string, audience: NotificationAudience): string {
  if (REFUND_EVENT_ID_PATTERN.test(eventId)) {
    return `refund-${createHash("sha256").update(eventId).digest("hex").slice(0, 24)}.${audience}`;
  }
  return `${eventId}.${audience}`;
}

/** @return {string} The scope of every customer notification. */
export function customerScope(): string {
  return "customer";
}

/**
 * @param {string} organizationId An organization's ID.
 * @return {string} The scope of that organization's notifications.
 */
export function organizationScope(organizationId: string): string {
  return `org:${organizationId}`;
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The recipient's Descope user ID (always the verified session's).
 * @return {CollectionReference} Their inbox.
 */
export function notificationsCollection(db: Firestore, userId: string): CollectionReference {
  return db.collection("users").doc(userId).collection(NOTIFICATIONS_SUBCOLLECTION);
}

/**
 * @param {Timestamp} createdAt A notification's creation time.
 * @return {Timestamp} When it expires.
 */
export function notificationExpiry(createdAt: Timestamp): Timestamp {
  return Timestamp.fromMillis(createdAt.toMillis() + NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

const timestampSchema = (field: string) => z.custom<Timestamp>(
  (value) => value instanceof Timestamp,
  `${field} must be a Firestore Timestamp`,
);

const notificationDocSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NOTIFICATION_TYPES as [NotificationType, ...NotificationType[]]),
  scope: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  orderId: z.string().min(1),
  organizationId: z.string().min(1),
  outletId: z.string().min(1),
  eventId: z.string().min(1),
  createdAt: timestampSchema("createdAt"),
  readAt: timestampSchema("readAt").nullable(),
  expiresAt: timestampSchema("expiresAt"),
});

/**
 * @param {unknown} data The document's raw field data.
 * @param {string} expectedId The document ID it was read from.
 * @return {Notification} The parsed notification.
 * @throws {Error} If the stored document does not match the expected shape.
 */
export function parseNotification(data: unknown, expectedId: string): Notification {
  const parsed = notificationDocSchema.safeParse(data);
  if (!parsed.success || parsed.data.id !== expectedId) {
    throw new Error(`Malformed notification document ${NOTIFICATIONS_SUBCOLLECTION}/${expectedId}.`);
  }
  return parsed.data;
}

/**
 * @param {Notification} notification A stored notification.
 * @return {NotificationResponse} Its client-facing shape.
 */
export function toNotificationResponse(notification: Notification): NotificationResponse {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    orderId: notification.orderId,
    createdAt: notification.createdAt.toDate().toISOString(),
    readAt: notification.readAt ? notification.readAt.toDate().toISOString() : null,
  };
}

/**
 * Validates a list request's query string. `limit` is validated for shape only
 * (the maximum is enforced by `listNotifications` itself, so no caller can
 * bypass it); `unread` is `"true"`/`"false"`. Anything else — in particular a
 * `userId` or `scope` — is not a field here, so `safeParse` strips it.
 */
export const listNotificationsQuerySchema = z.object({
  limit: z
    .string({error: "limit must be a single positive integer."})
    .regex(/^[1-9]\d{0,8}$/, "limit must be a positive integer.")
    .transform(Number)
    .optional(),
  cursor: z
    .string({error: "cursor must be a single string."})
    .min(1, "cursor must not be empty.")
    .max(CURSOR_MAX_LENGTH, "cursor is too long.")
    .optional(),
  unread: z
    .enum(["true", "false"], {error: "unread must be true or false."})
    .transform((value) => value === "true")
    .optional(),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

const cursorPayloadSchema = z.object({
  s: z.number().int().min(0).max(MAX_TIMESTAMP_SECONDS),
  n: z.number().int().min(0).max(999_999_999),
  i: z.string().max(CURSOR_MAX_LENGTH).refine((id) => isValidDocumentId(id)),
});

/** The decoded form of a cursor: the last returned notification's position. */
export interface NotificationCursor {
  createdAt: Timestamp;
  id: string;
}

/**
 * @param {Timestamp} createdAt The last returned notification's `createdAt`.
 * @param {string} id Its ID (the `__name__` tie-break).
 * @return {string} The opaque cursor for the page that follows it.
 */
export function encodeNotificationCursor(createdAt: Timestamp, id: string): string {
  return Buffer.from(JSON.stringify({s: createdAt.seconds, n: createdAt.nanoseconds, i: id}), "utf8")
    .toString("base64url");
}

/**
 * The cursor carries no authority: it is only a boundary inside a query that is
 * already scoped to the caller's own inbox and scope, so a forged one can only
 * move where in the caller's own list a page starts. It is still validated
 * strictly so garbage is a clean 400.
 *
 * @param {string} raw A cursor as the client sent it.
 * @return {NotificationCursor} The decoded boundary.
 * @throws {HttpsError} `invalid-argument` (400) if `raw` is not a cursor this
 *   endpoint could have issued.
 */
export function decodeNotificationCursor(raw: string): NotificationCursor {
  const invalid = new HttpsError("invalid-argument", "Invalid cursor.");
  // `Buffer.from(..., "base64url")` silently skips characters it doesn't
  // understand, so check the alphabet first rather than accept near-misses.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalid;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  const parsed = cursorPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw invalid;
  }
  return {createdAt: new Timestamp(parsed.data.s, parsed.data.n), id: parsed.data.i};
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's user ID.
 * @param {string} scope The scope to restrict to.
 * @param {boolean} unreadOnly Whether to match only unread notifications.
 * @return {Query} The scoped query (unordered).
 */
function scopedQuery(db: Firestore, userId: string, scope: string, unreadOnly: boolean): Query {
  let query: Query = notificationsCollection(db, userId).where("scope", "==", scope);
  if (unreadOnly) {
    query = query.where("readAt", "==", null);
  }
  return query;
}

/**
 * Lists one page of the caller's notifications in `scope`, newest first.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's user ID.
 * @param {string} scope `customerScope()` or the caller's verified
 *   `organizationScope(...)`.
 * @param {ListNotificationsQuery} query The validated query string.
 * @return {Promise<NotificationsPageResponse>} At most
 *   `NOTIFICATION_MAX_PAGE_SIZE` notifications, and the next cursor (or `null`).
 * @throws {HttpsError} `invalid-argument` (400) for a cursor this endpoint
 *   could not have issued.
 */
export async function listNotifications(
  db: Firestore,
  userId: string,
  scope: string,
  query: ListNotificationsQuery,
): Promise<NotificationsPageResponse> {
  const pageSize = Math.min(query.limit ?? NOTIFICATION_DEFAULT_PAGE_SIZE, NOTIFICATION_MAX_PAGE_SIZE);
  // Decoded before Firestore is touched, so a bad cursor is a cheap 400.
  const cursor = query.cursor === undefined ? undefined : decodeNotificationCursor(query.cursor);

  let notificationsQuery = scopedQuery(db, userId, scope, query.unread === true)
    .orderBy("createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (cursor) {
    notificationsQuery = notificationsQuery.startAfter(cursor.createdAt, cursor.id);
  }

  // One extra document tells us whether another page exists, without a count.
  const snapshot = await notificationsQuery.limit(pageSize + 1).get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const notifications = pageDocs.map((doc) => parseNotification(doc.data(), doc.id));
  // Belt and braces: the query is already scoped, but a result that is not
  // must fail loudly rather than be returned.
  if (notifications.some((notification) => notification.scope !== scope)) {
    throw new Error("Notification query returned a notification outside the requested scope.");
  }

  const last = notifications[notifications.length - 1];
  return {
    notifications: notifications.map(toNotificationResponse),
    nextCursor: snapshot.docs.length > pageSize && last ? encodeNotificationCursor(last.createdAt, last.id) : null,
  };
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's user ID.
 * @param {string} scope The scope to count in.
 * @return {Promise<number>} How many notifications are unread, counting no
 *   further than `NOTIFICATION_UNREAD_COUNT_CAP`.
 */
export async function countUnreadNotifications(
  db: Firestore,
  userId: string,
  scope: string,
): Promise<number> {
  const aggregate = await scopedQuery(db, userId, scope, true)
    .limit(NOTIFICATION_UNREAD_COUNT_CAP)
    .count()
    .get();
  return aggregate.data().count;
}

/**
 * Marks one of the caller's own notifications in `scope` read. Idempotent: an
 * already-read notification is returned unchanged, keeping its ORIGINAL
 * `readAt`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's user ID.
 * @param {string} scope The scope the route is for.
 * @param {unknown} notificationIdValue The notification's ID, from the request path.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<NotificationResponse>} The notification after the call.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed ID;
 *   `not-found` (404) if the caller's inbox has no such notification in this
 *   scope — another user's notification, another scope's, and a missing one
 *   are indistinguishable.
 */
export async function markNotificationRead(
  db: Firestore,
  userId: string,
  scope: string,
  notificationIdValue: unknown,
  now: Timestamp = Timestamp.now(),
): Promise<NotificationResponse> {
  if (!isValidDocumentId(notificationIdValue)) {
    throw new HttpsError("invalid-argument", "Invalid notification ID.");
  }
  const ref = notificationsCollection(db, userId).doc(notificationIdValue);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Notification not found.");
    }
    const notification = parseNotification(snapshot.data(), snapshot.id);
    if (notification.scope !== scope) {
      throw new HttpsError("not-found", "Notification not found.");
    }
    if (notification.readAt !== null) {
      return toNotificationResponse(notification);
    }
    tx.update(ref, {readAt: now});
    return toNotificationResponse({...notification, readAt: now});
  });
}

export interface MarkAllReadResult {
  /** How many notifications this call marked read. */
  updated: number;
  /** Whether unread notifications may remain (the per-call bound was reached). */
  hasMore: boolean;
}

/**
 * Marks the caller's unread notifications in `scope` read, in bounded
 * transactions (`NOTIFICATION_READ_ALL_BATCH_SIZE` each, at most
 * `NOTIFICATION_READ_ALL_MAX_BATCHES` per call). Each transaction re-reads its
 * batch, so a notification marked read in the meantime keeps its original
 * `readAt`; one that arrives meanwhile simply stays unread.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's user ID.
 * @param {string} scope The scope the route is for.
 * @param {Timestamp} [now] Injected clock, for tests.
 * @return {Promise<MarkAllReadResult>} What was done.
 */
export async function markAllNotificationsRead(
  db: Firestore,
  userId: string,
  scope: string,
  now: Timestamp = Timestamp.now(),
): Promise<MarkAllReadResult> {
  let updated = 0;
  for (let round = 0; round < NOTIFICATION_READ_ALL_MAX_BATCHES; round++) {
    const batchSize = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(
        scopedQuery(db, userId, scope, true).limit(NOTIFICATION_READ_ALL_BATCH_SIZE),
      );
      for (const doc of snapshot.docs) {
        tx.update(doc.ref, {readAt: now});
      }
      return snapshot.size;
    });
    updated += batchSize;
    if (batchSize < NOTIFICATION_READ_ALL_BATCH_SIZE) {
      return {updated, hasMore: false};
    }
  }
  return {updated, hasMore: true};
}

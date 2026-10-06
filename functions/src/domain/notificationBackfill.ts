import {FieldPath, Timestamp, type Firestore} from "firebase-admin/firestore";
import {NOTIFICATION_EVENTS_COLLECTION, REFUND_NOTIFICATION_EVENT_TYPES, isRefundNotificationEventType} from "./notificationEvents";
import {processNotificationEvent, type ProcessNotificationEventOptions} from "./notificationProcessor";

/**
 * One-shot BACKFILL for refund notification events that were written while nothing consumed
 * them (Checkpoint 7.5 produced `refund_requested|completed|failed` events; the processor left
 * them `pending`). The `onNotificationEventCreated` trigger fires only when a document is
 * CREATED, so changing the policy re-triggers none of them: this sweep hands the already-pending
 * ones to the very same `processNotificationEvent` the trigger runs.
 *
 * Properties:
 * - Recognised events only: it selects `type in REFUND_NOTIFICATION_EVENT_TYPES` AND
 *   `status == "pending"`, and re-checks both on every document it reads. Order events are never
 *   selected; a processed or failed event is never reprocessed.
 * - Deterministic and bounded: events are taken in document-ID order, at most `limit` per call
 *   (`REFUND_BACKFILL_MAX_LIMIT` at the very most), and a `nextCursor` continues where the call
 *   stopped. Processed events drop out of the query on their own, so a re-run only ever sees
 *   what is left.
 * - Idempotent: processing is exactly the trigger's (deterministic inbox IDs, `create`
 *   semantics), so a sweep that races the trigger, or is repeated, cannot duplicate a
 *   notification or reset a `readAt`.
 * - A dry run reads and counts only; it writes nothing.
 * - Not a scheduler and not wired to anything: it is called by hand (see
 *   `scripts/backfill-refund-notifications.mjs`).
 *
 * The query is three equality-filtered, ID-ordered reads (one per refund type, each
 * `status == "pending"`), which Firestore serves from its automatic single-field indexes; a
 * dry run therefore also proves, before any write, that no composite index is missing.
 */

export const REFUND_BACKFILL_DEFAULT_LIMIT = 100;
export const REFUND_BACKFILL_MAX_LIMIT = 500;

export interface BackfillRefundNotificationsOptions extends ProcessNotificationEventOptions {
  /** Events per call. Default 100, clamped to 1..500. */
  limit?: number;
  /** Continue after this event ID (the previous call's `nextCursor`). */
  after?: string;
  /** Count and list what would be processed, process nothing. */
  dryRun?: boolean;
  /** Orders whose events must be left alone (counted as `excluded`, never processed). */
  excludeOrderIds?: readonly string[];
}

export interface BackfillRefundNotificationsResult {
  dryRun: boolean;
  /** Pending refund events this call looked at (including excluded ones). */
  scanned: number;
  /** Processed by this call (always 0 on a dry run). */
  processed: number;
  /** Left alone because their order is in `excludeOrderIds`. */
  excluded: number;
  /** Ended `failed` (permanent failure or attempt cap) — needs a person. */
  failed: number;
  /** Not processed by this call: another run settled them first, or a transient error left them pending. */
  notProcessed: number;
  /** The IDs this call processes (or, on a dry run, would process), in order; excluded events are not listed. */
  eventIds: string[];
  /** Pass back as `after` to continue; `null` when nothing is left past this call. */
  nextCursor: string | null;
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {BackfillRefundNotificationsOptions} [options] Bounds, mode and processor overrides.
 * @return {Promise<BackfillRefundNotificationsResult>} What the call found and did.
 */
export async function backfillRefundNotifications(
  db: Firestore,
  options: BackfillRefundNotificationsOptions = {},
): Promise<BackfillRefundNotificationsResult> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? REFUND_BACKFILL_DEFAULT_LIMIT), 1), REFUND_BACKFILL_MAX_LIMIT);
  const dryRun = options.dryRun === true;
  const excluded = new Set(options.excludeOrderIds ?? []);

  const pages = await Promise.all(REFUND_NOTIFICATION_EVENT_TYPES.map(async (type) => {
    let query = db.collection(NOTIFICATION_EVENTS_COLLECTION)
      .where("type", "==", type)
      .where("status", "==", "pending")
      .orderBy(FieldPath.documentId());
    if (options.after !== undefined) {
      query = query.startAfter(options.after);
    }
    return query.limit(limit).get();
  }));

  const candidates = pages
    .flatMap((page) => page.docs)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = candidates.slice(0, limit);
  const mayHaveMore = candidates.length > limit || pages.some((page) => page.size === limit);

  const result: BackfillRefundNotificationsResult = {
    dryRun,
    scanned: 0,
    processed: 0,
    excluded: 0,
    failed: 0,
    notProcessed: 0,
    eventIds: [],
    nextCursor: mayHaveMore && selected.length > 0 ? selected[selected.length - 1].id : null,
  };

  for (const doc of selected) {
    const data = doc.data();
    // Belt and braces: the query already guarantees both.
    if (!isRefundNotificationEventType(data.type) || data.status !== "pending") {
      continue;
    }
    result.scanned += 1;
    if (typeof data.orderId === "string" && excluded.has(data.orderId)) {
      result.excluded += 1;
      continue;
    }
    result.eventIds.push(doc.id);
    if (dryRun) {
      continue;
    }

    try {
      const outcome = await processNotificationEvent(db, doc.id, {
        ...(options.channels !== undefined ? {channels: options.channels} : {}),
        now: options.now ?? (() => Timestamp.now()),
      });
      if (outcome.kind === "processed") {
        result.processed += 1;
      } else if (outcome.kind === "failed") {
        result.failed += 1;
      } else {
        result.notProcessed += 1;
      }
    } catch {
      // A transient failure: the processor already counted the attempt and noted the error; the
      // event stays pending for the next sweep (or its own retry).
      result.notProcessed += 1;
    }
  }
  return result;
}

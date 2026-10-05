import type {Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {processNotificationEvent} from "./notificationProcessor";

/**
 * The body of the `onNotificationEventCreated` Firestore trigger (`index.ts`),
 * kept here so it is testable without the Functions runtime — `index.ts` only
 * wires it to `notificationEvents/{eventId}`.
 *
 * It processes exactly the event it was triggered for. A transient failure
 * propagates (so the trigger's `retry: true` runs it again, up to the
 * processor's attempt cap); everything else — processed, skipped, permanently
 * failed — returns normally, which is what stops the platform retrying.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} eventId The created `notificationEvents` document's ID.
 */
export async function handleNotificationEventCreated(db: Firestore, eventId: string): Promise<void> {
  const result = await processNotificationEvent(db, eventId);
  logger.info("Notification event handled.", {
    eventId,
    outcome: result.kind,
    ...(result.kind === "processed" ? {delivered: result.delivered} : {}),
    ...(result.kind === "skipped" ? {reason: result.reason} : {}),
  });
}

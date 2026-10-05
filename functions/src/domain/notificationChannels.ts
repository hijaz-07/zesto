import type {Firestore} from "firebase-admin/firestore";
import {notificationsCollection, type Notification} from "./notifications";

/**
 * Delivery CHANNELS: how a notification reaches a person. Notification
 * generation (`notificationPolicy.ts` + `notificationProcessor.ts`) is
 * independent of how any one channel delivers, so adding browser push, email or
 * mobile push later means registering another `NotificationChannel`, not
 * touching order logic or the policy. Only `in_app` exists today.
 */

export type NotificationChannelName = "in_app" | "web_push" | "email" | "mobile_push";

/** One notification, addressed to one recipient. */
export interface NotificationDelivery {
  recipientUserId: string;
  notification: Notification;
}

export interface NotificationChannel {
  readonly name: NotificationChannelName;
  /**
   * Delivers every item, idempotently: delivering the same notification again
   * (a retried event) must change nothing visible. Must attempt EVERY item
   * before reporting a failure, so a retry only has what is left to do; throws
   * if any item failed.
   *
   * @param {Firestore} db Admin Firestore instance.
   * @param {NotificationDelivery[]} deliveries The notifications to deliver.
   */
  deliver(db: Firestore, deliveries: readonly NotificationDelivery[]): Promise<void>;
}

/** gRPC `ALREADY_EXISTS`: the document is already there. */
const ALREADY_EXISTS = 6;

/**
 * @param {unknown} error A thrown value.
 * @return {boolean} Whether Firestore reported that a document already exists.
 */
export function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === ALREADY_EXISTS || error.code === "already-exists");
}

/**
 * The in-app channel: persists the notification in the recipient's inbox
 * (`users/{userId}/notifications`), which is all "delivery" means for a
 * pull-based inbox. `create` semantics: a notification that already exists is
 * left exactly as it is, so a retry can never reset `readAt` on one the user
 * has already read — and a partially delivered fan-out converges on retry,
 * writing only what is missing.
 */
export const inAppChannel: NotificationChannel = {
  name: "in_app",
  async deliver(db, deliveries) {
    const results = await Promise.allSettled(deliveries.map(({recipientUserId, notification}) =>
      notificationsCollection(db, recipientUserId).doc(notification.id).create(notification)));

    for (const result of results) {
      if (result.status === "rejected" && !isAlreadyExists(result.reason)) {
        throw result.reason;
      }
    }
  },
};

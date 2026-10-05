import type {OrganizationMemberRole} from "../auth/membership";
import type {NotificationEventType} from "./notificationEvents";

/**
 * WHO is told WHAT about each order event — the single table that decides it.
 * An event with no rule here is still recorded (the outbox is the audit/future
 * channels' feed) but produces no visible notification.
 *
 * Customer: confirmed, preparing, ready, picked up. `order_completed` is
 * recorded but deliberately NOT shown: staff close an order out seconds after
 * handing it over, so "Picked up" and "Completed" would arrive back to back.
 *
 * Organization: only `order_confirmed` (as `new_order`). Preparing, ready,
 * picked up and completed are done by the organization's own staff, who can see
 * them on the order dashboard.
 *
 * Copy names the outlet rather than an order number (orders have none) and
 * carries nothing else: no phone/email, payment or provider data, pickup
 * credential, or internal ID. The order's ID travels separately, as
 * `Notification.orderId`, for the client's deep link.
 */

/** Which inbox a notification lands in. */
export type NotificationAudience = "customer" | "org";

export const CUSTOMER_NOTIFICATION_TYPES = [
  "order_confirmed",
  "order_preparing",
  "order_ready",
  "order_picked_up",
] as const;
export const ORG_NOTIFICATION_TYPES = ["new_order"] as const;

export type NotificationType =
  (typeof CUSTOMER_NOTIFICATION_TYPES)[number] | (typeof ORG_NOTIFICATION_TYPES)[number];
export const NOTIFICATION_TYPES: readonly NotificationType[] =
  [...CUSTOMER_NOTIFICATION_TYPES, ...ORG_NOTIFICATION_TYPES];

/**
 * The organization roles that receive organization notifications, and that may
 * therefore read the organization inbox. Active members only (see the
 * processor); an invited or revoked member is neither.
 */
export const NOTIFICATION_ORG_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

/** Display context the copy may use. Never anything customer-identifying. */
export interface NotificationCopyContext {
  /** The outlet's name, if its document could be read. */
  outletName?: string;
}

/** A notification's content before it is addressed to a recipient. */
export interface NotificationDraft {
  audience: NotificationAudience;
  type: NotificationType;
  title: string;
  body: string;
}

interface NotificationRule {
  audience: NotificationAudience;
  type: NotificationType;
  title: string;
  /** Builds the body from `from`, e.g. "from Main Canteen"; empty if the outlet is unknown. */
  body(from: string): string;
}

/**
 * @param {NotificationCopyContext} context The copy context.
 * @return {string} " from <outlet>" or "" when the outlet's name is unknown, so
 *   copy degrades to a complete sentence rather than naming nothing.
 */
function fromOutlet(context: NotificationCopyContext): string {
  return context.outletName ? ` from ${context.outletName}` : "";
}

/** The whole policy: event type -> the notifications it produces. */
const NOTIFICATION_POLICY: Readonly<Record<NotificationEventType, readonly NotificationRule[]>> = {
  order_confirmed: [
    {
      audience: "customer",
      type: "order_confirmed",
      title: "Order confirmed",
      body: (from) => `Your order${from} has been confirmed.`,
    },
    {
      audience: "org",
      type: "new_order",
      title: "New order",
      body: (from) => `New order received${from}.`,
    },
  ],
  order_preparing: [
    {
      audience: "customer",
      type: "order_preparing",
      title: "Being prepared",
      body: (from) => `Your order${from} is being prepared.`,
    },
  ],
  order_ready: [
    {
      audience: "customer",
      type: "order_ready",
      title: "Ready for pickup",
      body: (from) => `Your order${from} is ready for pickup.`,
    },
  ],
  order_picked_up: [
    {
      audience: "customer",
      type: "order_picked_up",
      title: "Picked up",
      body: (from) => `Your order${from} has been picked up.`,
    },
  ],
  // Recorded, never shown — see the module doc comment.
  order_completed: [],
};

/**
 * @param {NotificationEventType} eventType An event type.
 * @param {NotificationCopyContext} context Display context for the copy.
 * @return {NotificationDraft[]} The notifications the event produces (none for
 *   `order_completed`). Pure.
 */
export function notificationsForEvent(
  eventType: NotificationEventType,
  context: NotificationCopyContext,
): NotificationDraft[] {
  const from = fromOutlet(context);
  return NOTIFICATION_POLICY[eventType].map((rule) => ({
    audience: rule.audience,
    type: rule.type,
    title: rule.title,
    body: rule.body(from),
  }));
}

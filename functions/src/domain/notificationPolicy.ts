import type {OrganizationMemberRole} from "../auth/membership";
import type {AnyNotificationEventType} from "./notificationEvents";

/**
 * WHO is told WHAT about each outbox event — the single table that decides it.
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
 * Cancellation. The audience is whoever did NOT do it: a customer's own cancellation tells the
 * organization (owners, managers and staff), not the customer; an outlet's or the system's tells
 * the customer, not the organization. When the cancelling transaction also reserved a refund the
 * customer's copy says one was started — which is why `refund_requested` itself shows nothing:
 * two back-to-back notifications about one act would be noise.
 *
 * Refund. `refund_requested`: nothing visible (consumed, no inbox document). `refund_completed`:
 * the customer. `refund_failed`: the customer, and the organization's owners and managers only
 * (money is theirs to chase; staff cannot cancel orders either). No refund copy carries an
 * amount, a provider ID or error, or an internal identifier.
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

/** Cancellation and refund notifications. `refund_failed` is shown to both audiences, with their own copy. */
export const CANCELLATION_NOTIFICATION_TYPES = [
  "order_cancelled_by_customer",
  "order_cancelled_by_outlet",
  "order_cancelled_by_system",
] as const;
export const REFUND_NOTIFICATION_TYPES = ["refund_completed", "refund_failed"] as const;

export type NotificationType =
  | (typeof CUSTOMER_NOTIFICATION_TYPES)[number]
  | (typeof ORG_NOTIFICATION_TYPES)[number]
  | (typeof CANCELLATION_NOTIFICATION_TYPES)[number]
  | (typeof REFUND_NOTIFICATION_TYPES)[number];
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  ...CUSTOMER_NOTIFICATION_TYPES,
  ...ORG_NOTIFICATION_TYPES,
  ...CANCELLATION_NOTIFICATION_TYPES,
  ...REFUND_NOTIFICATION_TYPES,
];

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
  /** Cancellation events: whether the cancelling transaction also reserved a refund. */
  refundInitiated?: boolean;
}

/** A notification's content before it is addressed to a recipient. */
export interface NotificationDraft {
  audience: NotificationAudience;
  type: NotificationType;
  title: string;
  body: string;
  /**
   * Organization drafts only, and only when narrower than every notifying role: the roles that
   * receive it. Absent means every role in `NOTIFICATION_ORG_ROLES`.
   */
  roles?: readonly OrganizationMemberRole[];
}

interface NotificationRule {
  audience: NotificationAudience;
  type: NotificationType;
  title: string;
  /** Narrows an organization notification to these roles (see `NotificationDraft.roles`). */
  roles?: readonly OrganizationMemberRole[];
  /**
   * Builds the body from `from` (e.g. "from Main Canteen"; empty if the outlet is unknown) and
   * the full copy context.
   */
  body(from: string, context: NotificationCopyContext): string;
}

/** The sentence a cancellation appends when a refund was started. */
const REFUND_STARTED_SENTENCE = " A refund has been initiated.";

/**
 * @param {NotificationCopyContext} context The copy context.
 * @return {string} The refund sentence for a cancellation, or "".
 */
function refundStarted(context: NotificationCopyContext): string {
  return context.refundInitiated === true ? REFUND_STARTED_SENTENCE : "";
}

/** Organization roles that handle money: the only ones told a refund failed. */
const REFUND_ATTENTION_ROLES: readonly OrganizationMemberRole[] = ["owner", "manager"];

/**
 * @param {NotificationCopyContext} context The copy context.
 * @return {string} " from <outlet>" or "" when the outlet's name is unknown, so
 *   copy degrades to a complete sentence rather than naming nothing.
 */
function fromOutlet(context: NotificationCopyContext): string {
  return context.outletName ? ` from ${context.outletName}` : "";
}

/** The whole policy: event type -> the notifications it produces. */
const NOTIFICATION_POLICY: Readonly<Record<AnyNotificationEventType, readonly NotificationRule[]>> = {
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

  // The customer cancelled: the organization hears of it; the customer did it themselves.
  order_cancelled_by_customer: [
    {
      audience: "org",
      type: "order_cancelled_by_customer",
      title: "Order cancelled",
      body: (from) => `An order${from} was cancelled by the customer.`,
    },
  ],
  // The outlet cancelled: the customer hears of it.
  order_cancelled_by_outlet: [
    {
      audience: "customer",
      type: "order_cancelled_by_outlet",
      title: "Order cancelled",
      body: (from, context) => `Your order${from} was cancelled by the outlet.${refundStarted(context)}`,
    },
  ],
  // Reserved for a future automatic cancellation; no producer exists yet.
  order_cancelled_by_system: [
    {
      audience: "customer",
      type: "order_cancelled_by_system",
      title: "Order cancelled",
      body: (from, context) => `Your order${from} was cancelled.${refundStarted(context)}`,
    },
  ],

  // Internal lifecycle event: consumed, never shown (the cancellation copy carries the news).
  refund_requested: [],
  refund_completed: [
    {
      audience: "customer",
      type: "refund_completed",
      title: "Refund processed",
      body: () => "Your refund has been processed. It may take a few business days to appear in your account.",
    },
  ],
  refund_failed: [
    {
      audience: "customer",
      type: "refund_failed",
      title: "Refund issue",
      body: () => "We couldn't complete your refund automatically. We're looking into it. " +
        "Please contact support with your order ID.",
    },
    {
      audience: "org",
      type: "refund_failed",
      title: "Refund failed",
      roles: REFUND_ATTENTION_ROLES,
      body: () => "A refund failed and needs attention.",
    },
  ],
};

/**
 * @param {AnyNotificationEventType} eventType An event type.
 * @param {NotificationCopyContext} context Display context for the copy.
 * @return {NotificationDraft[]} The notifications the event produces (none for
 *   `order_completed` or `refund_requested`). Pure.
 */
export function notificationsForEvent(
  eventType: AnyNotificationEventType,
  context: NotificationCopyContext,
): NotificationDraft[] {
  const from = fromOutlet(context);
  return NOTIFICATION_POLICY[eventType].map((rule) => ({
    audience: rule.audience,
    type: rule.type,
    title: rule.title,
    body: rule.body(from, context),
    ...(rule.roles !== undefined ? {roles: rule.roles} : {}),
  }));
}

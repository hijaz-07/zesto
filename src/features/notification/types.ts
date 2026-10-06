import type { OrganizationId } from '../../domain/types';
import type { ISODateString } from '../../types/common';

/**
 * The in-app notification inbox, mirroring the backend's client-facing shape
 * (functions/src/domain/notifications.ts's `NotificationResponse`). The
 * frontend only ever READS notifications and marks them read: they are created
 * by the backend from order events, never by anything here.
 */

/**
 * Every notification type a screen shows. `order_completed` is deliberately
 * absent: the backend records that event but produces no notification for it,
 * and nothing here would invent one.
 */
export const CUSTOMER_NOTIFICATION_TYPES = [
  'order_confirmed',
  'order_preparing',
  'order_ready',
  'order_picked_up',
  'order_cancelled_by_outlet',
  'order_cancelled_by_system',
  'refund_completed',
  'refund_failed',
] as const;
/** `refund_failed` is in both lists: the customer and the organization each get their own copy of it. */
export const ORGANIZATION_NOTIFICATION_TYPES = [
  'new_order',
  'order_cancelled_by_customer',
  'refund_failed',
] as const;

export type NotificationType =
  | (typeof CUSTOMER_NOTIFICATION_TYPES)[number]
  | (typeof ORGANIZATION_NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  ...new Set<NotificationType>([...CUSTOMER_NOTIFICATION_TYPES, ...ORGANIZATION_NOTIFICATION_TYPES]),
];

export type NotificationId = string;

/** Exactly the fields a screen may use: no scope, event id, organization id, user id or audit field. */
export interface AppNotification {
  id: NotificationId;
  type: NotificationType;
  title: string;
  body: string;
  /** What a deep link is built from. */
  orderId: string;
  createdAt: ISODateString;
  /** `null` while unread. Set once by the backend and never overwritten. */
  readAt: ISODateString | null;
}

export interface NotificationsPage {
  notifications: AppNotification[];
  /** Pass back as `cursor` for the next page; `null` when this is the last. */
  nextCursor: string | null;
}

export interface MarkAllReadResult {
  /** How many notifications the backend marked read in this call. */
  updated: number;
  /** Whether unread notifications may remain (the backend's per-call bound was reached). */
  hasMore: boolean;
}

/**
 * Which inbox a screen is about. This is only a choice of ENDPOINT: the customer
 * routes serve the signed-in user's customer notifications, the organization
 * routes serve their notifications for one organization — and the backend
 * decides from the verified session (and, for an organization, the caller's own
 * membership) what that means. No user id, recipient or scope is ever sent.
 */
export type NotificationScope =
  | { kind: 'customer' }
  | { kind: 'organization'; organizationId: OrganizationId };

export type NotificationFilter = 'all' | 'unread';

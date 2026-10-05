import { ApiError, apiFetch } from '../../lib/api/client';
import {
  NOTIFICATION_TYPES,
  type AppNotification,
  type MarkAllReadResult,
  type NotificationId,
  type NotificationScope,
  type NotificationType,
  type NotificationsPage,
} from './types';

/**
 * The notification inbox API (functions/src/routes/notifications.ts), through
 * the same `apiFetch` every other feature uses. The scope only selects which
 * set of routes to call:
 *
 * - customer: `/notifications...`
 * - organization: `/organizations/{organizationId}/notifications...`
 *
 * Nothing about WHO is asking (a user id, a recipient, a scope) is ever sent —
 * the backend reads the signed-in session, and for an organization the caller's
 * own active membership. The organization id in the path is only a request.
 *
 * Every response is checked and rebuilt field by field, so a field the server
 * one day adds (or a type this app doesn't show) can never reach a screen.
 */

function basePath(scope: NotificationScope): string {
  return scope.kind === 'customer'
    ? '/notifications'
    : `/organizations/${encodeURIComponent(scope.organizationId)}/notifications`;
}

function invalidResponse(): ApiError {
  return new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/**
 * @returns The notification with only the approved fields, `null` for one of a
 *   type this app does not show (skipped, not an error: a newer backend may know
 *   more types than this bundle).
 * @throws {ApiError} `invalid_response` if the entry is not a notification at all.
 */
function toNotification(raw: unknown): AppNotification | null {
  if (!isRecord(raw)) {
    throw invalidResponse();
  }
  const { id, type, title, body, orderId, createdAt, readAt } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof orderId !== 'string' ||
    typeof createdAt !== 'string' ||
    (readAt !== null && typeof readAt !== 'string')
  ) {
    throw invalidResponse();
  }
  if (!isNotificationType(type)) {
    return null;
  }
  return { id, type, title, body, orderId, createdAt, readAt };
}

export interface ListNotificationsParams {
  /** Only unread notifications. */
  unread?: boolean;
  /** The `nextCursor` of the previous page; omit for the first page. */
  cursor?: string;
  /** A hint only: the backend enforces its own default (20) and maximum (50). */
  limit?: number;
}

/** Reads one page of the caller's notifications in this scope, newest first. */
export async function listNotifications(
  scope: NotificationScope,
  params: ListNotificationsParams = {},
): Promise<NotificationsPage> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  if (params.unread) {
    query.set('unread', 'true');
  }
  const queryString = query.toString();
  const path = basePath(scope);
  const data = await apiFetch<unknown>(queryString ? `${path}?${queryString}` : path);

  if (!isRecord(data) || !Array.isArray(data.notifications)) {
    throw invalidResponse();
  }
  const nextCursor = data.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw invalidResponse();
  }
  const notifications = data.notifications
    .map(toNotification)
    .filter((notification): notification is AppNotification => notification !== null);
  return { notifications, nextCursor };
}

/** How many of the caller's notifications in this scope are unread (the backend stops counting at 100). */
export async function getUnreadCount(scope: NotificationScope): Promise<number> {
  const data = await apiFetch<unknown>(`${basePath(scope)}/unread-count`);
  if (!isRecord(data) || typeof data.unreadCount !== 'number' || !Number.isInteger(data.unreadCount) || data.unreadCount < 0) {
    throw invalidResponse();
  }
  return data.unreadCount;
}

/**
 * Marks one of the caller's own notifications read. Idempotent: the backend
 * keeps the original `readAt` of one that was already read. Resolves with the
 * backend's own copy of the notification.
 */
export async function markNotificationRead(
  scope: NotificationScope,
  notificationId: NotificationId,
): Promise<AppNotification> {
  const data = await apiFetch<unknown>(`${basePath(scope)}/${encodeURIComponent(notificationId)}/read`, {
    method: 'POST',
  });
  const notification = isRecord(data) ? toNotification(data.notification) : null;
  if (!notification) {
    throw invalidResponse();
  }
  return notification;
}

/** Marks the caller's unread notifications in this scope read, in the backend's bounded batches. */
export async function markAllNotificationsRead(scope: NotificationScope): Promise<MarkAllReadResult> {
  const data = await apiFetch<unknown>(`${basePath(scope)}/read-all`, { method: 'POST' });
  if (
    !isRecord(data) ||
    typeof data.updated !== 'number' ||
    !Number.isInteger(data.updated) ||
    data.updated < 0 ||
    typeof data.hasMore !== 'boolean'
  ) {
    throw invalidResponse();
  }
  return { updated: data.updated, hasMore: data.hasMore };
}

import { ApiError } from '../../lib/api/client';
import type { NotificationScope } from './types';

/**
 * A failure that no amount of waiting fixes: the session is gone (401) or the
 * caller no longer has access to this inbox (403). Background polling stops
 * for good on one of these.
 */
export function isPermanentNotificationFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** Whether the backend refused this caller access to the organization's notifications. */
export function isNotificationsForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/**
 * Maps a failed notification list read to a message. Backend text is never
 * shown for a failure that has its own wording here, and an unknown failure is
 * a generic sentence: no raw server or Firestore error reaches a screen.
 */
export function listNotificationsErrorMessage(error: unknown, scope: NotificationScope): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return scope.kind === 'organization'
      ? "You don't have access to this organization's notifications."
      : "You don't have access to these notifications.";
  }
  return 'Something went wrong. Please check your connection and try again.';
}

/** Maps a failed mark-read (one or all) to a message; the notification is left exactly as it was. */
export function markReadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You don't have access to these notifications.";
  }
  if (error instanceof ApiError && error.status === 404) {
    return "This notification couldn't be found. The list has been refreshed.";
  }
  return "Couldn't mark as read. Please check your connection and try again.";
}

/** Whether a failed mark-read means the list on screen is out of date and should be re-read. */
export function markReadNeedsRefresh(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

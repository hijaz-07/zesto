import { ApiError } from '../../lib/api/client';

/** Whether the backend refused this caller access to the organization's orders. */
export function isOrganizationOrdersForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** Maps a failure from the organization order-list API to a message for the person running the organization. */
export function listOrganizationOrdersErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You don't have access to this organization's orders.";
  }
  if (error instanceof ApiError && error.status === 404) {
    return "That outlet couldn't be found. Choose another outlet or show all outlets.";
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please check your connection and try again.';
}

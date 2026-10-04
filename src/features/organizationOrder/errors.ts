import { ApiError } from '../../lib/api/client';

/** Whether the backend refused this caller access to the organization's orders. */
export function isOrganizationOrdersForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/**
 * Whether a failed fulfilment action means the list on screen is out of date and
 * should be re-read: the order is not in the state this showed (409), is no
 * longer there (404), or access to it has changed (403 — the re-read then shows
 * the access error itself if access is really gone). A network failure or a 5xx
 * says nothing about the order, so it keeps the list and offers another try.
 */
export function fulfillmentFailureNeedsRefresh(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 409);
}

/** Maps a failed fulfilment action (start preparing / mark ready) to a message for the person who pressed it. */
export function fulfillmentErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You don't have access to change this order.";
  }
  if (error instanceof ApiError && error.status === 404) {
    return "This order couldn't be found. The list has been refreshed.";
  }
  if (error instanceof ApiError && error.status === 409) {
    return 'This order has changed since you loaded it. The list has been refreshed.';
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please check your connection and try again.';
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

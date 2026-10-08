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

/**
 * What to say when it is not known whether a pickup was recorded: the request
 * was sent, but no usable answer came back (the connection dropped, a 5xx, an
 * answer that was not the expected shape). The order may already be `picked_up`,
 * so staff are told to check before handing anything over rather than invited to
 * retry blindly — presenting the same code again is safe, and gets a definite
 * answer ("already picked up", or the pickup itself).
 */
const PICKUP_OUTCOME_UNKNOWN =
  "Couldn't confirm the pickup. It may or may not have been recorded — check the order's status in Orders before handing anything over, or enter the code again.";

/**
 * Maps a failed pickup redemption to a message for the staff member.
 *
 * The backend's own 400/404/409 messages are used as they are: they are short,
 * specific ("This order has already been picked up.", "This order is for a
 * different outlet.", "No order awaiting pickup matches this code.") and written
 * never to echo the code or to say anything about an order the caller cannot
 * open — a 404 is the same sentence for an unknown order, another
 * organization's, and a wrong code. A 503 means the request was not processed
 * (the session could not be checked), so nothing was recorded; anything else
 * leaves the outcome unknown (see `PICKUP_OUTCOME_UNKNOWN`).
 */
export function redeemPickupErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return "You don't have access to hand over orders.";
    case 503:
      return 'Zesto is temporarily unavailable. Nothing was recorded. Please try again in a moment.';
    case 400:
    case 404:
    case 409:
      return error.message.trim() || PICKUP_OUTCOME_UNKNOWN;
    default:
      return PICKUP_OUTCOME_UNKNOWN;
    }
  }
  return PICKUP_OUTCOME_UNKNOWN;
}

/**
 * Maps a failed "Mark completed" on the pickup page to a message. Unlike
 * `fulfillmentErrorMessage` (which says the dashboard list was refreshed), this
 * page has no list to refresh, so a conflict just reports the backend's reason.
 * Completing is safe to repeat, so a lost connection simply offers another try.
 */
export function completeOrderErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return "You don't have access to change this order.";
    case 404:
      return "This order couldn't be found.";
    case 409:
      return error.message.trim() || 'This order has changed since the pickup. Check Orders for where it stands.';
    case 503:
      return 'Zesto is temporarily unavailable. Please try again in a moment.';
    default:
      return error.message;
    }
  }
  return "Couldn't reach Zesto. Please check your connection and try again.";
}

/**
 * Whether a failed cancellation leaves it unknown whether the order was
 * cancelled: the request was sent but no usable answer came back (the connection
 * dropped, a 5xx other than 503, an answer that was not the expected shape). A
 * 503 means the request was not processed, and a 4xx is a definite refusal.
 */
export function cancelOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }
  return error.status === 200 || (error.status >= 500 && error.status !== 503);
}

/**
 * Maps a failed organization cancellation to a message for the person who asked
 * for it. A 403 says only that they may not do this (it does not explain the
 * organization's roles or reveal anything about the order); a 409 and a 404 say
 * the list on screen was out of date and has been refreshed; a lost answer says
 * so plainly and does not claim either outcome. Repeating a cancellation is safe,
 * which is why the last case invites another try.
 */
export function cancelOrganizationOrderErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
    case 400:
      return 'Choose a reason for cancelling this order.';
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return "You don't have permission to cancel orders.";
    case 404:
      return "This order couldn't be found. The list has been refreshed.";
    case 409:
      return 'This order has changed since you opened it and can no longer be cancelled. The list has been refreshed.';
    case 503:
      return 'Zesto is temporarily unavailable. The order was not cancelled. Please try again in a moment.';
    default:
      if (!cancelOutcomeUnknown(error)) {
        return "Couldn't cancel this order. Please try again.";
      }
    }
  }
  return "Couldn't confirm the cancellation. The order may or may not have been cancelled — check its status below, or try again.";
}

/**
 * Maps a failed refund retry to a message for the person who pressed it. A 403 says
 * only that they may not do this; a 404 and a 409 say the list on screen was out of
 * date and has been refreshed (the refund may already have been retried, or never
 * failed); a lost answer says so plainly and does not claim either outcome, and
 * does not invite a blind repeat — the refreshed row shows whether a new refund exists.
 */
export function retryRefundErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return "You don't have permission to retry refunds.";
    case 404:
      return "This order couldn't be found. The list has been refreshed.";
    case 409:
      return "This refund can't be retried right now: it may already have been retried, or it hasn't failed. The list has been refreshed.";
    case 503:
      return 'Zesto is temporarily unavailable. The refund was not retried. Please try again in a moment.';
    default:
      if (!cancelOutcomeUnknown(error)) {
        return "Couldn't retry this refund. Please try again.";
      }
    }
  }
  return "Couldn't confirm the retry. A new refund may or may not have been started — check the order's refund status once the list refreshes.";
}

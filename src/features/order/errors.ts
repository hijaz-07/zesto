import { ApiError } from '../../lib/api/client';

/**
 * Maps a failure from the order-creation API to a customer-facing message.
 * Unlike some other features' error maps, this doesn't special-case every
 * backend scenario (ordering closed, item disabled, outlet inactive,
 * idempotency-key conflict, ...) by status/code: the backend's own
 * `error.message` for each of those is already a short, customer-safe
 * sentence (see functions/src/routes/orders.ts's `mapKnownError` and
 * functions/src/domain/orders.ts's `createOrder`), so surfacing it directly
 * naturally gives each scenario its own distinct wording without this file
 * having to guess at or duplicate that text — the same approach
 * `../organization/errors.ts`'s `organizationErrorMessage` already takes.
 */
export function createOrderErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Couldn't place your order. Please check your connection and try again.";
}

/** Maps a failure from the order-history list API to a customer-facing message. */
export function listOrdersErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please check your connection and try again.';
}

/** Maps a failure from the pickup-credential API to a customer-facing message. */
export function getPickupCredentialErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return "We couldn't find this order.";
  }
  if (error instanceof ApiError && error.status === 409) {
    // The order has moved on (picked up, say) since the page last looked.
    return "This order isn't ready for pickup any more. Refresh to see where it stands.";
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Couldn't load your pickup code. Please check your connection and try again.";
}

/** Maps a failure from the single-order read API to a customer-facing message. */
export function getOrderErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'Order not found.';
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

/**
 * Why an order that is past cancelling can't be cancelled, in the customer's own
 * words — from the order's status alone, which the server set (this is an
 * explanation, never the decision). `null` where there is nothing to explain:
 * an order that is still cancellable, already cancelled, or already collected.
 */
export function cancellationUnavailableMessage(order: {
  status: string;
  cancellation?: { canCancel: boolean };
}): string | null {
  switch (order.status) {
    case 'preparing':
      return 'Preparation has already started, so this order can no longer be cancelled.';
    case 'ready':
      return 'This order is ready for pickup, so it can no longer be cancelled.';
    case 'confirmed':
      // Only when the server has said so: a confirmed order is cancellable until its ordering deadline.
      return order.cancellation && !order.cancellation.canCancel
        ? 'The cancellation window for this order has closed.'
        : null;
    default:
      return null;
  }
}

/** Maps a failure from the cancel-order API to a customer-facing message. Never shows the backend's own wording or codes. */
export function cancelOrderErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'Order not found.';
  }
  if (error instanceof ApiError && error.status === 409) {
    return 'This order can no longer be cancelled.';
  }
  if (error instanceof ApiError) {
    return "Couldn't cancel your order. Please try again.";
  }
  return "Couldn't cancel your order. Please check your connection and try again.";
}

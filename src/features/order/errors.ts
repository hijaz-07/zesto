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

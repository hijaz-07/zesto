import { ApiError } from '../../lib/api/client';

/** Maps a failure from the menu items API to a user-safe message; never echoes backend internals. */
export function menuItemErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

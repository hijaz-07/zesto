import { ApiError } from '../../lib/api/client';

/** Maps a failure from the explore-outlets-list API to a customer-facing message; never echoes backend internals. */
export function exploreOutletsErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError) {
    return "Couldn't load outlets right now.";
  }
  return 'Something went wrong. Please try again.';
}

/** Maps a failure from the single-outlet explore API to a customer-facing message; never echoes backend internals. */
export function exploreOutletErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'Outlet not available.';
  }
  if (error instanceof ApiError) {
    return "Couldn't load this outlet right now.";
  }
  return 'Something went wrong. Please try again.';
}

/**
 * Maps a failure from the explore menu-detail API to a customer-facing
 * message; never echoes backend internals. The backend's secure-not-found
 * behavior returns the same generic 404 whether the outlet or the menu is
 * the one that isn't visible (functions/src/routes/explore.ts never
 * distinguishes them, on purpose — see docs/architecture/http-api.md#explore),
 * so this always reads as "menu not available" rather than guessing which.
 */
export function exploreMenuErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return 'Zesto is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'Menu not available.';
  }
  if (error instanceof ApiError) {
    return "Couldn't load this menu right now.";
  }
  return 'Something went wrong. Please try again.';
}

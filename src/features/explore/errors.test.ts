import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { exploreMenuErrorMessage, exploreOutletErrorMessage, exploreOutletsErrorMessage } from './errors';

describe('exploreOutletsErrorMessage', () => {
  it('replaces a 503 server message with a generic, safe message', () => {
    const error = new ApiError(503, 'unavailable', 'Session validation backend detail.');

    expect(exploreOutletsErrorMessage(error)).toBe(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it('does not pass through a raw backend message for any other ApiError', () => {
    const error = new ApiError(400, 'invalid_argument', 'internal detail');

    expect(exploreOutletsErrorMessage(error)).toBe("Couldn't load outlets right now.");
  });

  it('falls back to a generic message for a non-ApiError (network failure)', () => {
    expect(exploreOutletsErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('falls back to a generic message for a non-Error thrown value', () => {
    expect(exploreOutletsErrorMessage('some string')).toBe('Something went wrong. Please try again.');
  });
});

describe('exploreOutletErrorMessage', () => {
  it('maps a 404 to a customer-facing "not available" message, never "not found"', () => {
    const error = new ApiError(404, 'not_found', 'Outlet not found.');

    expect(exploreOutletErrorMessage(error)).toBe('Outlet not available.');
  });

  it('replaces a 503 server message with a generic, safe message', () => {
    const error = new ApiError(503, 'unavailable', 'Session validation backend detail.');

    expect(exploreOutletErrorMessage(error)).toBe(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it('falls back to a generic load-failure message for any other ApiError status', () => {
    const error = new ApiError(400, 'invalid_argument', 'internal detail');

    expect(exploreOutletErrorMessage(error)).toBe("Couldn't load this outlet right now.");
  });

  it('falls back to a generic message for a non-ApiError (network failure)', () => {
    expect(exploreOutletErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

describe('exploreMenuErrorMessage', () => {
  it('maps a 404 to a customer-facing "not available" message, never "not found"', () => {
    const error = new ApiError(404, 'not_found', 'Menu not found.');

    expect(exploreMenuErrorMessage(error)).toBe('Menu not available.');
  });

  it('maps a 404 the same way even when it was really the outlet that was not visible', () => {
    // The backend deliberately never distinguishes "outlet not visible" from
    // "menu not visible" for this endpoint (secure not-found) — the message
    // it sends may literally say "Outlet not found.", but the frontend must
    // still surface this as a menu-detail failure, not echo the backend text.
    const error = new ApiError(404, 'not_found', 'Outlet not found.');

    expect(exploreMenuErrorMessage(error)).toBe('Menu not available.');
  });

  it('replaces a 503 server message with a generic, safe message', () => {
    const error = new ApiError(503, 'unavailable', 'Session validation backend detail.');

    expect(exploreMenuErrorMessage(error)).toBe(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it('falls back to a generic load-failure message for any other ApiError status', () => {
    const error = new ApiError(400, 'invalid_argument', 'internal detail');

    expect(exploreMenuErrorMessage(error)).toBe("Couldn't load this menu right now.");
  });

  it('falls back to a generic message for a non-ApiError (network failure)', () => {
    expect(exploreMenuErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

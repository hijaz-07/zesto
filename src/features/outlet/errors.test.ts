import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { outletErrorMessage } from './errors';

describe('outletErrorMessage', () => {
  it('passes through a validation (400) message', () => {
    const error = new ApiError(
      400,
      'invalid_argument',
      'Slug must be lowercase letters, numbers, and single hyphens only.',
    );

    expect(outletErrorMessage(error)).toBe(
      'Slug must be lowercase letters, numbers, and single hyphens only.',
    );
  });

  it('passes through the duplicate-slug (409) message', () => {
    const error = new ApiError(409, 'already_exists', 'This outlet URL is already taken.');

    expect(outletErrorMessage(error)).toBe('This outlet URL is already taken.');
  });

  it('passes through an authentication (401) message', () => {
    const error = new ApiError(401, 'unauthenticated', 'The session is invalid or has expired.');

    expect(outletErrorMessage(error)).toBe('The session is invalid or has expired.');
  });

  it('passes through a permission (403) message', () => {
    const error = new ApiError(403, 'permission_denied', 'You do not have access to this organization.');

    expect(outletErrorMessage(error)).toBe('You do not have access to this organization.');
  });

  it('passes through a not-found (404) message', () => {
    const error = new ApiError(404, 'not_found', 'Outlet not found.');

    expect(outletErrorMessage(error)).toBe('Outlet not found.');
  });

  it('replaces a 503 server message with a generic, safe message', () => {
    const error = new ApiError(503, 'unavailable', 'Session validation backend detail.');

    expect(outletErrorMessage(error)).toBe('Zesto is temporarily unavailable. Please try again in a moment.');
  });

  it('falls back to a generic message for a non-ApiError', () => {
    expect(outletErrorMessage(new Error('network down'))).toBe('Something went wrong. Please try again.');
  });

  it('falls back to a generic message for a non-Error thrown value', () => {
    expect(outletErrorMessage('some string')).toBe('Something went wrong. Please try again.');
  });
});

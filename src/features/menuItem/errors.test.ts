import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { menuItemErrorMessage } from './errors';

describe('menuItemErrorMessage', () => {
  it('passes through a validation (400) message', () => {
    const error = new ApiError(400, 'invalid_argument', 'priceInPaise must be a non-negative integer.');

    expect(menuItemErrorMessage(error)).toBe('priceInPaise must be a non-negative integer.');
  });

  it('passes through the ordering-closed (400) message', () => {
    const error = new ApiError(
      400,
      'invalid_argument',
      "Ordering has closed; this menu's items can no longer be changed.",
    );

    expect(menuItemErrorMessage(error)).toBe(
      "Ordering has closed; this menu's items can no longer be changed.",
    );
  });

  it('passes through the archived-menu (400) message', () => {
    const error = new ApiError(400, 'invalid_argument', 'Items on an archived menu cannot be changed.');

    expect(menuItemErrorMessage(error)).toBe('Items on an archived menu cannot be changed.');
  });

  it('passes through the inactive-outlet (400) message', () => {
    const error = new ApiError(400, 'invalid_argument', 'This outlet is not active.');

    expect(menuItemErrorMessage(error)).toBe('This outlet is not active.');
  });

  it('passes through the published-menu delete-rejection (400) message', () => {
    const error = new ApiError(
      400,
      'invalid_argument',
      'Only items on a draft menu can be deleted; disable the item instead.',
    );

    expect(menuItemErrorMessage(error)).toBe(
      'Only items on a draft menu can be deleted; disable the item instead.',
    );
  });

  it('passes through an authentication (401) message', () => {
    const error = new ApiError(401, 'unauthenticated', 'The session is invalid or has expired.');

    expect(menuItemErrorMessage(error)).toBe('The session is invalid or has expired.');
  });

  it('passes through a permission (403) message', () => {
    const error = new ApiError(403, 'permission_denied', 'You do not have access to this organization.');

    expect(menuItemErrorMessage(error)).toBe('You do not have access to this organization.');
  });

  it('passes through a not-found (404) message', () => {
    const error = new ApiError(404, 'not_found', 'Menu item not found.');

    expect(menuItemErrorMessage(error)).toBe('Menu item not found.');
  });

  it('replaces a 503 server message with a generic, safe message', () => {
    const error = new ApiError(503, 'unavailable', 'Session validation backend detail.');

    expect(menuItemErrorMessage(error)).toBe(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it('falls back to a generic message for a non-ApiError', () => {
    expect(menuItemErrorMessage(new Error('network down'))).toBe('Something went wrong. Please try again.');
  });

  it('falls back to a generic message for a non-Error thrown value', () => {
    expect(menuItemErrorMessage('some string')).toBe('Something went wrong. Please try again.');
  });
});

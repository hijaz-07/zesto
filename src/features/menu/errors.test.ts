import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { menuErrorMessage } from './errors';

describe('menuErrorMessage', () => {
  it('passes through a validation (400) message', () => {
    const error = new ApiError(400, 'invalid_argument', 'orderingOpensAt must be before orderingClosesAt.');

    expect(menuErrorMessage(error)).toBe('orderingOpensAt must be before orderingClosesAt.');
  });

  it('passes through the publish-rejected (400) message for a non-draft menu', () => {
    const error = new ApiError(400, 'invalid_argument', 'Only a draft menu can be published.');

    expect(menuErrorMessage(error)).toBe('Only a draft menu can be published.');
  });

  it('passes through the no-enabled-items (400) message', () => {
    const error = new ApiError(
      400,
      'invalid_argument',
      'A menu must have at least one enabled item before it can be published.',
    );

    expect(menuErrorMessage(error)).toBe(
      'A menu must have at least one enabled item before it can be published.',
    );
  });

  it('passes through the archived-menu (400) message', () => {
    const error = new ApiError(400, 'invalid_argument', 'Archived menus cannot be edited.');

    expect(menuErrorMessage(error)).toBe('Archived menus cannot be edited.');
  });

  it('passes through the ordering-closed (400) message', () => {
    const error = new ApiError(
      400,
      'invalid_argument',
      "Ordering has closed; this menu's schedule can no longer be changed.",
    );

    expect(menuErrorMessage(error)).toBe(
      "Ordering has closed; this menu's schedule can no longer be changed.",
    );
  });

  it('passes through the inactive-outlet (400) message', () => {
    const error = new ApiError(400, 'invalid_argument', 'This outlet is not active.');

    expect(menuErrorMessage(error)).toBe('This outlet is not active.');
  });

  it('passes through an authentication (401) message', () => {
    const error = new ApiError(401, 'unauthenticated', 'The session is invalid or has expired.');

    expect(menuErrorMessage(error)).toBe('The session is invalid or has expired.');
  });

  it('passes through a permission (403) message', () => {
    const error = new ApiError(403, 'permission_denied', 'You do not have access to this organization.');

    expect(menuErrorMessage(error)).toBe('You do not have access to this organization.');
  });

  it('passes through a not-found (404) message', () => {
    const error = new ApiError(404, 'not_found', 'Menu not found.');

    expect(menuErrorMessage(error)).toBe('Menu not found.');
  });

  it('replaces a 503 server message with a generic, safe message', () => {
    const error = new ApiError(503, 'unavailable', 'Session validation backend detail.');

    expect(menuErrorMessage(error)).toBe('Zesto is temporarily unavailable. Please try again in a moment.');
  });

  it('falls back to a generic message for a non-ApiError', () => {
    expect(menuErrorMessage(new Error('network down'))).toBe('Something went wrong. Please try again.');
  });

  it('falls back to a generic message for a non-Error thrown value', () => {
    expect(menuErrorMessage('some string')).toBe('Something went wrong. Please try again.');
  });
});

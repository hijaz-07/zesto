import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { completeOrderErrorMessage, redeemPickupErrorMessage } from './errors';

describe('redeemPickupErrorMessage', () => {
  it('asks for a new sign-in on a 401', () => {
    expect(redeemPickupErrorMessage(new ApiError(401, 'unauthenticated', 'x'))).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  it('says plainly that the member has no access on a 403, without any detail', () => {
    expect(redeemPickupErrorMessage(new ApiError(403, 'permission_denied', 'internal wording'))).toBe(
      "You don't have access to hand over orders.",
    );
  });

  it('says nothing was recorded on a 503: the session could not be checked, so the request was not processed', () => {
    const message = redeemPickupErrorMessage(new ApiError(503, 'unavailable', 'x'));

    expect(message).toContain('temporarily unavailable');
    expect(message).toContain('Nothing was recorded');
  });

  it.each([
    [400, "That doesn't look like a Zesto pickup code."],
    [404, 'No order awaiting pickup matches this code.'],
    [409, 'This order has already been picked up.'],
    [409, 'This order is for a different outlet.'],
    [409, 'This order is not ready for pickup yet.'],
  ])("shows the backend's own specific %i message as it is: %s", (status, message) => {
    expect(redeemPickupErrorMessage(new ApiError(status, 'x', message))).toBe(message);
  });

  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    ['a 500', new ApiError(500, 'internal', 'boom')],
    ['a 502', new ApiError(502, 'x', 'bad gateway')],
    [
      'an unexpected response shape',
      new ApiError(200, 'invalid_response', 'The server returned a response in an unexpected shape.'),
    ],
    ['a non-error', 'nope'],
  ])('says it may or may not have been recorded after %s — and never shows its raw message', (_label, failure) => {
    const message = redeemPickupErrorMessage(failure);

    expect(message).toContain('may or may not have been recorded');
    expect(message).toContain('check');
    expect(message).not.toContain('boom');
    expect(message).not.toContain('bad gateway');
  });

  it('falls back to the uncertain message for a blank backend message', () => {
    expect(redeemPickupErrorMessage(new ApiError(409, 'conflict', '   '))).toContain('may or may not');
  });
});

describe('completeOrderErrorMessage', () => {
  it.each([
    [401, 'Your session has expired. Please sign in again.'],
    [403, "You don't have access to change this order."],
    [404, "This order couldn't be found."],
    [503, 'Zesto is temporarily unavailable. Please try again in a moment.'],
  ])('maps a %i', (status, message) => {
    expect(completeOrderErrorMessage(new ApiError(status, 'x', 'x'))).toBe(message);
  });

  it("shows the backend's reason for a 409, and does NOT claim a list was refreshed (this page has none)", () => {
    const message = completeOrderErrorMessage(new ApiError(409, 'conflict', 'This order has not been picked up yet.'));

    expect(message).toBe('This order has not been picked up yet.');
    expect(message).not.toContain('refreshed');
  });

  it('offers another try after a lost connection: completing is safe to repeat', () => {
    expect(completeOrderErrorMessage(new TypeError('Failed to fetch'))).toBe(
      "Couldn't reach Zesto. Please check your connection and try again.",
    );
  });
});

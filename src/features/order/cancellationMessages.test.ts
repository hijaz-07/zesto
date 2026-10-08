import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { cancelOrderErrorMessage, cancellationUnavailableMessage } from './errors';

describe('cancellationUnavailableMessage', () => {
  it('explains that preparation has started', () => {
    expect(cancellationUnavailableMessage({ status: 'preparing' })).toBe(
      'Preparation has already started, so this order can no longer be cancelled.',
    );
  });

  it('explains that a ready order can no longer be cancelled', () => {
    expect(cancellationUnavailableMessage({ status: 'ready' })).toBe(
      'This order is ready for pickup, so it can no longer be cancelled.',
    );
  });

  it('explains a confirmed order only when the server has said it cannot be cancelled', () => {
    expect(cancellationUnavailableMessage({ status: 'confirmed', cancellation: { canCancel: false } })).toBe(
      'The cancellation window for this order has closed.',
    );
    expect(cancellationUnavailableMessage({ status: 'confirmed', cancellation: { canCancel: true } })).toBeNull();
    // No hint at all: nothing is claimed.
    expect(cancellationUnavailableMessage({ status: 'confirmed' })).toBeNull();
  });

  it.each(['pending_payment', 'picked_up', 'completed', 'cancelled', 'something_new'])(
    'has nothing to say for %s',
    (status) => {
      expect(cancellationUnavailableMessage({ status, cancellation: { canCancel: false } })).toBeNull();
    },
  );
});

describe('cancelOrderErrorMessage', () => {
  it("409: the order can no longer be cancelled, without the backend's wording", () => {
    expect(cancelOrderErrorMessage(new ApiError(409, 'conflict', 'payment_state_inconsistent: internal'))).toBe(
      'This order can no longer be cancelled.',
    );
  });

  it('503: temporarily unavailable', () => {
    expect(cancelOrderErrorMessage(new ApiError(503, 'unavailable', 'x'))).toBe(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it('401: the session has expired', () => {
    expect(cancelOrderErrorMessage(new ApiError(401, 'unauthenticated', 'x'))).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  it('404: the order is unavailable', () => {
    expect(cancelOrderErrorMessage(new ApiError(404, 'not_found', 'Not found by backend'))).toBe('Order not found.');
  });

  it("any other API error is generic, never the backend's text or code", () => {
    const message = cancelOrderErrorMessage(new ApiError(400, 'invalid_argument', 'Invalid cancellation reason.'));
    expect(message).toBe("Couldn't cancel your order. Please try again.");
    expect(message).not.toContain('invalid');
  });

  it('a network failure is retryable wording', () => {
    expect(cancelOrderErrorMessage(new TypeError('Failed to fetch'))).toBe(
      "Couldn't cancel your order. Please check your connection and try again.",
    );
  });
});

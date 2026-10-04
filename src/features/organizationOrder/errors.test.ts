import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import {
  fulfillmentErrorMessage,
  fulfillmentFailureNeedsRefresh,
  isOrganizationOrdersForbidden,
  listOrganizationOrdersErrorMessage,
} from './errors';

describe('fulfillmentFailureNeedsRefresh', () => {
  it.each([403, 404, 409])('is true for a %i: what was on screen no longer matches the server', (status) => {
    expect(fulfillmentFailureNeedsRefresh(new ApiError(status, 'x', 'x'))).toBe(true);
  });

  it.each([400, 401, 500, 503])('is false for a %i: it says nothing about the order', (status) => {
    expect(fulfillmentFailureNeedsRefresh(new ApiError(status, 'x', 'x'))).toBe(false);
  });

  it('is false for a network failure or a non-error', () => {
    expect(fulfillmentFailureNeedsRefresh(new TypeError('Failed to fetch'))).toBe(false);
    expect(fulfillmentFailureNeedsRefresh(null)).toBe(false);
  });
});

describe('fulfillmentErrorMessage', () => {
  it('explains a 409 as the order having changed, and says the list was refreshed', () => {
    expect(fulfillmentErrorMessage(new ApiError(409, 'conflict', 'internal wording'))).toBe(
      'This order has changed since you loaded it. The list has been refreshed.',
    );
  });

  it('explains a 403 without echoing the backend text', () => {
    expect(fulfillmentErrorMessage(new ApiError(403, 'permission_denied', 'internal wording'))).toBe(
      "You don't have access to change this order.",
    );
  });

  it('explains a 404, and says the list was refreshed', () => {
    expect(fulfillmentErrorMessage(new ApiError(404, 'not_found', 'Order not found.'))).toBe(
      "This order couldn't be found. The list has been refreshed.",
    );
  });

  it('asks the person to sign in again on a 401', () => {
    expect(fulfillmentErrorMessage(new ApiError(401, 'unauthenticated', 'x'))).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  it('reports an outage on a 503', () => {
    expect(fulfillmentErrorMessage(new ApiError(503, 'unavailable', 'x'))).toBe(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it("passes through the backend's own message for any other API error", () => {
    expect(fulfillmentErrorMessage(new ApiError(400, 'invalid_argument', 'Invalid order ID.'))).toBe('Invalid order ID.');
  });

  it('falls back to a generic message for a non-API failure (e.g. the network)', () => {
    expect(fulfillmentErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Please check your connection and try again.',
    );
  });
});

describe('isOrganizationOrdersForbidden', () => {
  it('is true only for a 403 from the backend', () => {
    expect(isOrganizationOrdersForbidden(new ApiError(403, 'permission_denied', 'No.'))).toBe(true);
    expect(isOrganizationOrdersForbidden(new ApiError(401, 'unauthenticated', 'No.'))).toBe(false);
    expect(isOrganizationOrdersForbidden(new ApiError(404, 'not_found', 'No.'))).toBe(false);
    expect(isOrganizationOrdersForbidden(new Error('boom'))).toBe(false);
    expect(isOrganizationOrdersForbidden(null)).toBe(false);
  });
});

describe('listOrganizationOrdersErrorMessage', () => {
  it('explains a 403 without echoing the backend text', () => {
    expect(listOrganizationOrdersErrorMessage(new ApiError(403, 'permission_denied', 'internal wording'))).toBe(
      "You don't have access to this organization's orders.",
    );
  });

  it('asks the person to sign in again on a 401', () => {
    expect(listOrganizationOrdersErrorMessage(new ApiError(401, 'unauthenticated', 'x'))).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  it('explains a missing outlet on a 404', () => {
    expect(listOrganizationOrdersErrorMessage(new ApiError(404, 'not_found', 'Outlet not found.'))).toMatch(
      /outlet couldn't be found/,
    );
  });

  it('reports an outage on a 503', () => {
    expect(listOrganizationOrdersErrorMessage(new ApiError(503, 'unavailable', 'x'))).toBe(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
  });

  it("passes through the backend's own message for any other API error", () => {
    expect(listOrganizationOrdersErrorMessage(new ApiError(400, 'invalid_argument', 'Invalid cursor.'))).toBe(
      'Invalid cursor.',
    );
  });

  it('falls back to a generic message for a non-API failure (e.g. the network)', () => {
    expect(listOrganizationOrdersErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Please check your connection and try again.',
    );
  });
});

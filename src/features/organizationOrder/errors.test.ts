import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { isOrganizationOrdersForbidden, listOrganizationOrdersErrorMessage } from './errors';

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

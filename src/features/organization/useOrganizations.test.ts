import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useOrganizations } from './useOrganizations';

const getOrganizationsMock = vi.hoisted(() => vi.fn());
const createOrganizationMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getOrganizations: getOrganizationsMock,
  createOrganization: createOrganizationMock,
}));

const organization = {
  id: 'org-1',
  name: 'Test Canteen',
  slug: 'test-canteen',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'U-1',
};

describe('useOrganizations', () => {
  beforeEach(() => {
    getOrganizationsMock.mockReset();
    createOrganizationMock.mockReset();
  });

  it('starts loading, then becomes ready with the fetched organizations', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [{ ...organization, role: 'owner' }] });

    const { result } = renderHook(() => useOrganizations());
    expect(result.current.status).toBe('loading');
    expect(result.current.organizations).toEqual([]);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.organizations).toEqual([{ ...organization, role: 'owner' }]);
    expect(getOrganizationsMock).toHaveBeenCalledTimes(1);
  });

  it('moves to an error state when the fetch fails, and retry() re-fetches', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getOrganizationsMock.mockRejectedValueOnce(error);
    getOrganizationsMock.mockResolvedValueOnce({ organizations: [] });

    const { result } = renderHook(() => useOrganizations());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.organizations).toEqual([]);
    expect(getOrganizationsMock).toHaveBeenCalledTimes(2);
  });

  it('appends the created organization from the POST response without refetching', async () => {
    getOrganizationsMock.mockResolvedValue({ organizations: [] });
    createOrganizationMock.mockResolvedValue({
      organization,
      membership: {
        userId: 'U-1',
        organizationId: 'org-1',
        role: 'owner',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const { result } = renderHook(() => useOrganizations());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.createOrganization({ name: 'Test Canteen', slug: 'test-canteen' });
    });

    expect(result.current.organizations).toEqual([{ ...organization, role: 'owner' }]);
    expect(getOrganizationsMock).toHaveBeenCalledTimes(1);
  });
});

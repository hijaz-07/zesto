import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useOutlets } from './useOutlets';

const getOutletsMock = vi.hoisted(() => vi.fn());
const createOutletMock = vi.hoisted(() => vi.fn());
const updateOutletMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getOutlets: getOutletsMock,
  createOutlet: createOutletMock,
  updateOutlet: updateOutletMock,
}));

const outlet = {
  id: 'outlet-1',
  organizationId: 'org-1',
  name: 'Main Canteen',
  slug: 'main-canteen',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'U-1',
};

describe('useOutlets', () => {
  beforeEach(() => {
    getOutletsMock.mockReset();
    createOutletMock.mockReset();
    updateOutletMock.mockReset();
  });

  it('starts loading, then becomes ready with the fetched outlets', async () => {
    getOutletsMock.mockResolvedValue({ outlets: [outlet] });

    const { result } = renderHook(() => useOutlets('org-1'));
    expect(result.current.status).toBe('loading');
    expect(result.current.outlets).toEqual([]);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlets).toEqual([outlet]);
    expect(getOutletsMock).toHaveBeenCalledWith('org-1');
  });

  it('moves to an error state when the fetch fails, and retry() re-fetches', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getOutletsMock.mockRejectedValueOnce(error);
    getOutletsMock.mockResolvedValueOnce({ outlets: [] });

    const { result } = renderHook(() => useOutlets('org-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outlets).toEqual([]);
    expect(getOutletsMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when the organizationId changes', async () => {
    getOutletsMock.mockResolvedValue({ outlets: [outlet] });

    const { result, rerender } = renderHook(({ organizationId }) => useOutlets(organizationId), {
      initialProps: { organizationId: 'org-1' },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ organizationId: 'org-2' });

    await waitFor(() => expect(getOutletsMock).toHaveBeenCalledTimes(2));
    expect(getOutletsMock).toHaveBeenNthCalledWith(2, 'org-2');
  });

  it('appends the created outlet from the POST response without refetching', async () => {
    getOutletsMock.mockResolvedValue({ outlets: [] });
    createOutletMock.mockResolvedValue({ outlet });

    const { result } = renderHook(() => useOutlets('org-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.createOutlet({ name: 'Main Canteen', slug: 'main-canteen' });
    });

    expect(result.current.outlets).toEqual([outlet]);
    expect(createOutletMock).toHaveBeenCalledWith('org-1', { name: 'Main Canteen', slug: 'main-canteen' });
    expect(getOutletsMock).toHaveBeenCalledTimes(1);
  });

  it('rejects and leaves the list unchanged when create fails on a duplicate slug', async () => {
    getOutletsMock.mockResolvedValue({ outlets: [outlet] });
    const error = new ApiError(409, 'already_exists', 'This outlet URL is already taken.');
    createOutletMock.mockRejectedValue(error);

    const { result } = renderHook(() => useOutlets('org-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.createOutlet({ name: 'Main Canteen', slug: 'main-canteen' });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.outlets).toEqual([outlet]);
  });

  it('rejects and leaves the list unchanged when create is forbidden', async () => {
    getOutletsMock.mockResolvedValue({ outlets: [] });
    const error = new ApiError(403, 'permission_denied', 'You do not have access to this organization.');
    createOutletMock.mockRejectedValue(error);

    const { result } = renderHook(() => useOutlets('org-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.createOutlet({ name: 'Main Canteen', slug: 'main-canteen' });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.outlets).toEqual([]);
  });

  it('replaces the updated outlet in place from the PATCH response', async () => {
    getOutletsMock.mockResolvedValue({ outlets: [outlet] });
    const updated = { ...outlet, status: 'inactive' };
    updateOutletMock.mockResolvedValue({ outlet: updated });

    const { result } = renderHook(() => useOutlets('org-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.updateOutlet('outlet-1', { status: 'inactive' });
    });

    expect(result.current.outlets).toEqual([updated]);
    expect(updateOutletMock).toHaveBeenCalledWith('org-1', 'outlet-1', { status: 'inactive' });
  });

  it('rejects and leaves the list unchanged when update targets a missing outlet', async () => {
    getOutletsMock.mockResolvedValue({ outlets: [outlet] });
    const error = new ApiError(404, 'not_found', 'Outlet not found.');
    updateOutletMock.mockRejectedValue(error);

    const { result } = renderHook(() => useOutlets('org-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.updateOutlet('missing-outlet', { status: 'inactive' });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.outlets).toEqual([outlet]);
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useMenu } from './useMenu';

const getMenuMock = vi.hoisted(() => vi.fn());
const updateMenuMock = vi.hoisted(() => vi.fn());
const publishMenuMock = vi.hoisted(() => vi.fn());
const archiveMenuMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getMenu: getMenuMock,
  updateMenu: updateMenuMock,
  publishMenu: publishMenuMock,
  archiveMenu: archiveMenuMock,
}));

const menu = {
  id: 'menu-1',
  organizationId: 'org-1',
  outletId: 'outlet-1',
  menuDate: '2026-09-29',
  title: 'Tuesday Special Menu',
  status: 'draft',
  orderingOpensAt: '2026-09-28T04:00:00+05:30',
  orderingClosesAt: '2026-09-29T10:00:00+05:30',
  pickupStartsAt: '2026-09-29T12:00:00+05:30',
  pickupEndsAt: '2026-09-29T14:00:00+05:30',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: 'U-1',
};

describe('useMenu', () => {
  beforeEach(() => {
    getMenuMock.mockReset();
    updateMenuMock.mockReset();
    publishMenuMock.mockReset();
    archiveMenuMock.mockReset();
  });

  it('starts loading, then becomes ready with the fetched menu', async () => {
    getMenuMock.mockResolvedValue({ menu });

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));
    expect(result.current.status).toBe('loading');
    expect(result.current.menu).toBeNull();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menu).toEqual(menu);
    expect(getMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1');
  });

  it('moves to an error state when the fetch fails, and retry() re-fetches', async () => {
    const error = new ApiError(404, 'not_found', 'Menu not found.');
    getMenuMock.mockRejectedValueOnce(error);
    getMenuMock.mockResolvedValueOnce({ menu });

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);
    expect(result.current.menu).toBeNull();

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menu).toEqual(menu);
    expect(getMenuMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when the menuId changes', async () => {
    getMenuMock.mockResolvedValue({ menu });

    const { result, rerender } = renderHook(
      ({ organizationId, outletId, menuId }) => useMenu(organizationId, outletId, menuId),
      { initialProps: { organizationId: 'org-1', outletId: 'outlet-1', menuId: 'menu-1' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ organizationId: 'org-1', outletId: 'outlet-1', menuId: 'menu-2' });

    await waitFor(() => expect(getMenuMock).toHaveBeenCalledTimes(2));
    expect(getMenuMock).toHaveBeenNthCalledWith(2, 'org-1', 'outlet-1', 'menu-2');
  });

  it('replaces the displayed menu with the PATCH response, without refetching', async () => {
    getMenuMock.mockResolvedValue({ menu });
    const updated = { ...menu, title: 'Updated title' };
    updateMenuMock.mockResolvedValue({ menu: updated });

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.updateMenu({ title: 'Updated title' });
    });

    expect(returned).toEqual(updated);
    expect(result.current.menu).toEqual(updated);
    expect(updateMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1', { title: 'Updated title' });
    expect(getMenuMock).toHaveBeenCalledTimes(1);
  });

  it('propagates an update rejection and leaves the displayed menu unchanged', async () => {
    getMenuMock.mockResolvedValue({ menu });
    const error = new ApiError(
      400,
      'failed_precondition',
      "Ordering has closed; this menu's schedule can no longer be changed.",
    );
    updateMenuMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.updateMenu({ orderingClosesAt: '2026-09-29T11:00:00+05:30' });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.menu).toEqual(menu);
  });

  it('replaces the displayed menu with the publish response, without refetching', async () => {
    getMenuMock.mockResolvedValue({ menu });
    const published = { ...menu, status: 'published', publishedAt: '2026-09-28T12:00:00.000Z' };
    publishMenuMock.mockResolvedValue({ menu: published });

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.publishMenu();
    });

    expect(returned).toEqual(published);
    expect(result.current.menu).toEqual(published);
    expect(publishMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1');
    expect(getMenuMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a publish rejection and leaves the displayed menu unchanged', async () => {
    getMenuMock.mockResolvedValue({ menu });
    const error = new ApiError(
      400,
      'invalid_argument',
      'A menu must have at least one enabled item before it can be published.',
    );
    publishMenuMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.publishMenu();
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.menu).toEqual(menu);
  });

  it('replaces the displayed menu with the archive response, without refetching', async () => {
    const published = { ...menu, status: 'published' as const };
    getMenuMock.mockResolvedValue({ menu: published });
    const archived = { ...published, status: 'archived' };
    archiveMenuMock.mockResolvedValue({ menu: archived });

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.archiveMenu();
    });

    expect(returned).toEqual(archived);
    expect(result.current.menu).toEqual(archived);
    expect(archiveMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1');
    expect(getMenuMock).toHaveBeenCalledTimes(1);
  });

  it('propagates an archive rejection and leaves the displayed menu unchanged', async () => {
    const published = { ...menu, status: 'published' as const };
    getMenuMock.mockResolvedValue({ menu: published });
    const error = new ApiError(400, 'invalid_argument', 'Only a published menu can be archived.');
    archiveMenuMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenu('org-1', 'outlet-1', 'menu-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.archiveMenu();
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.menu).toEqual(published);
  });
});

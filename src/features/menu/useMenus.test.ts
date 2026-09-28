import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useMenus } from './useMenus';

const getMenusMock = vi.hoisted(() => vi.fn());
const createMenuMock = vi.hoisted(() => vi.fn());
const updateMenuMock = vi.hoisted(() => vi.fn());
const publishMenuMock = vi.hoisted(() => vi.fn());
const archiveMenuMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getMenus: getMenusMock,
  createMenu: createMenuMock,
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

describe('useMenus', () => {
  beforeEach(() => {
    getMenusMock.mockReset();
    createMenuMock.mockReset();
    updateMenuMock.mockReset();
    publishMenuMock.mockReset();
    archiveMenuMock.mockReset();
  });

  it('starts loading, then becomes ready with the fetched menus', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    expect(result.current.status).toBe('loading');
    expect(result.current.menus).toEqual([]);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menus).toEqual([menu]);
    expect(getMenusMock).toHaveBeenCalledWith('org-1', 'outlet-1');
  });

  it('moves to an error state when the fetch fails, and retry() re-fetches', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getMenusMock.mockRejectedValueOnce(error);
    getMenusMock.mockResolvedValueOnce({ menus: [] });

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.menus).toEqual([]);
    expect(getMenusMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when the organizationId changes', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });

    const { result, rerender } = renderHook(
      ({ organizationId, outletId }) => useMenus(organizationId, outletId),
      { initialProps: { organizationId: 'org-1', outletId: 'outlet-1' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ organizationId: 'org-2', outletId: 'outlet-1' });

    await waitFor(() => expect(getMenusMock).toHaveBeenCalledTimes(2));
    expect(getMenusMock).toHaveBeenNthCalledWith(2, 'org-2', 'outlet-1');
  });

  it('re-fetches when the outletId changes', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });

    const { result, rerender } = renderHook(
      ({ organizationId, outletId }) => useMenus(organizationId, outletId),
      { initialProps: { organizationId: 'org-1', outletId: 'outlet-1' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ organizationId: 'org-1', outletId: 'outlet-2' });

    await waitFor(() => expect(getMenusMock).toHaveBeenCalledTimes(2));
    expect(getMenusMock).toHaveBeenNthCalledWith(2, 'org-1', 'outlet-2');
  });

  it('appends the created menu from the POST response without refetching', async () => {
    getMenusMock.mockResolvedValue({ menus: [] });
    createMenuMock.mockResolvedValue({ menu });

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const input = {
      menuDate: '2026-09-29',
      title: 'Tuesday Special Menu',
      orderingOpensAt: '2026-09-28T04:00:00+05:30',
      orderingClosesAt: '2026-09-29T10:00:00+05:30',
      pickupStartsAt: '2026-09-29T12:00:00+05:30',
      pickupEndsAt: '2026-09-29T14:00:00+05:30',
    };
    await act(async () => {
      await result.current.createMenu(input);
    });

    expect(result.current.menus).toEqual([menu]);
    expect(createMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', input);
    expect(getMenusMock).toHaveBeenCalledTimes(1);
  });

  it('rejects and leaves the list unchanged when create fails', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });
    const error = new ApiError(400, 'invalid_argument', 'This outlet is not active.');
    createMenuMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.createMenu({
          menuDate: '2026-09-29',
          title: 'Tuesday Special Menu',
          orderingOpensAt: '2026-09-28T04:00:00+05:30',
          orderingClosesAt: '2026-09-29T10:00:00+05:30',
          pickupStartsAt: '2026-09-29T12:00:00+05:30',
          pickupEndsAt: '2026-09-29T14:00:00+05:30',
        });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.menus).toEqual([menu]);
  });

  it('replaces the updated menu in place from the PATCH response', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });
    const updated = { ...menu, title: 'Updated title' };
    updateMenuMock.mockResolvedValue({ menu: updated });

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.updateMenu('menu-1', { title: 'Updated title' });
    });

    expect(result.current.menus).toEqual([updated]);
    expect(updateMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1', { title: 'Updated title' });
  });

  it('replaces the published menu in place from the publish response', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });
    const published = { ...menu, status: 'published', publishedAt: '2026-09-28T12:00:00.000Z' };
    publishMenuMock.mockResolvedValue({ menu: published });

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.publishMenu('menu-1');
    });

    expect(result.current.menus).toEqual([published]);
    expect(publishMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1');
  });

  it('rejects and leaves the list unchanged when publish fails', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });
    const error = new ApiError(
      400,
      'invalid_argument',
      'A menu must have at least one enabled item before it can be published.',
    );
    publishMenuMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.publishMenu('menu-1');
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.menus).toEqual([menu]);
  });

  it('replaces the archived menu in place from the archive response', async () => {
    const published = { ...menu, status: 'published' as const };
    getMenusMock.mockResolvedValue({ menus: [published] });
    const archived = { ...published, status: 'archived' };
    archiveMenuMock.mockResolvedValue({ menu: archived });

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.archiveMenu('menu-1');
    });

    expect(result.current.menus).toEqual([archived]);
    expect(archiveMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1');
  });

  it('rejects and leaves the list unchanged when update targets a missing menu', async () => {
    getMenusMock.mockResolvedValue({ menus: [menu] });
    const error = new ApiError(404, 'not_found', 'Menu not found.');
    updateMenuMock.mockRejectedValue(error);

    const { result } = renderHook(() => useMenus('org-1', 'outlet-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.updateMenu('missing-menu', { title: 'New title' });
      } catch (caught) {
        thrown = caught;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.menus).toEqual([menu]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api/client';
import { getExploreMenu, getExploreOutlet, getExploreOutlets } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', () => ({
  apiFetch: apiFetchMock,
}));

describe('explore api', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('getExploreOutlets GETs /explore/outlets with no body', async () => {
    apiFetchMock.mockResolvedValue({ outlets: [] });

    await getExploreOutlets();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/explore/outlets');
  });

  it('getExploreOutlet GETs /explore/outlets/{outletId} with no body', async () => {
    apiFetchMock.mockResolvedValue({ outlet: {}, menus: [] });

    await getExploreOutlet('outlet-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/explore/outlets/outlet-1');
  });

  it('getExploreMenu GETs /explore/outlets/{outletId}/menus/{menuId} with no body', async () => {
    apiFetchMock.mockResolvedValue({ outlet: {}, menu: {} });

    await getExploreMenu('outlet-1', 'menu-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/explore/outlets/outlet-1/menus/menu-1');
  });

  it('never constructs an Authorization header or any custom init itself, for any of the 3 calls', async () => {
    apiFetchMock.mockResolvedValue({ outlets: [], outlet: {}, menus: [], menu: {} });

    await getExploreOutlets();
    await getExploreOutlet('outlet-1');
    await getExploreMenu('outlet-1', 'menu-1');

    for (const call of apiFetchMock.mock.calls) {
      // Exactly one argument (the path) — no `init` object, so no headers,
      // no method override, nothing that could carry an Authorization
      // header. Whether a header is actually attached is entirely
      // `apiFetch`'s own concern (see `src/lib/api/client.ts`).
      expect(call).toHaveLength(1);
    }
  });

  it('resolves with the exact response returned by apiFetch (pass-through, no transformation)', async () => {
    const response = {
      outlets: [{ id: 'outlet-1', name: 'Main Canteen' }],
    };
    apiFetchMock.mockResolvedValue(response);

    const result = await getExploreOutlets();

    expect(result).toEqual(response);
  });

  it('propagates a rejection from apiFetch as-is', async () => {
    const error = new Error('boom');
    apiFetchMock.mockRejectedValue(error);

    await expect(getExploreOutlets()).rejects.toBe(error);
  });
});

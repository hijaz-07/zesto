import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import {
  cancelledOrgOrder,
  confirmedOrgOrder,
  manyOrgOrders,
  pendingOrgOrder,
} from '../../test/organizationOrderFixtures';
import type { OrganizationOrdersPage } from './types';
import { useOrganizationOrders } from './useOrganizationOrders';

const listMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  listOrganizationOrders: listMock,
}));

function page(orders: OrganizationOrdersPage['orders'], nextCursor: string | null = null): OrganizationOrdersPage {
  return { orders, nextCursor };
}

/** A promise the test settles by hand, to control response ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderOrders(organizationId = 'org-1', outletId: string | null = null) {
  return renderHook(
    (props: { organizationId: string; outletId: string | null }) =>
      useOrganizationOrders(props.organizationId, props.outletId),
    { initialProps: { organizationId, outletId } },
  );
}

describe('useOrganizationOrders', () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  describe('first page', () => {
    it('starts loading and requests the first page for the organization, with a page-size hint and no cursor', async () => {
      listMock.mockResolvedValue(page([confirmedOrgOrder]));

      const { result } = renderOrders();

      expect(result.current.status).toBe('loading');
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(listMock).toHaveBeenCalledWith('org-1', { outletId: undefined, limit: 20 });
    });

    it('becomes ready with the orders in the order the backend returned them', async () => {
      listMock.mockResolvedValue(page([cancelledOrgOrder, pendingOrgOrder, confirmedOrgOrder]));

      const { result } = renderOrders();

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.orders.map((order) => order.id)).toEqual([
        'order-cancelled-3',
        'order-pending-2',
        'order-confirmed-1',
      ]);
      expect(result.current.hasMore).toBe(false);
    });

    it('is ready with no orders for an organization that has none', async () => {
      listMock.mockResolvedValue(page([]));

      const { result } = renderOrders();

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.orders).toEqual([]);
      expect(result.current.hasMore).toBe(false);
    });

    it('reports the failure, then loads on retry', async () => {
      const error = new ApiError(503, 'unavailable', 'down');
      listMock.mockRejectedValueOnce(error);
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder]));

      const { result } = renderOrders();

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.error).toBe(error);
      expect(result.current.orders).toEqual([]);

      act(() => result.current.retry());
      expect(result.current.status).toBe('loading');
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.orders).toHaveLength(1);
    });

    it('surfaces a 403 as the error, with no orders', async () => {
      const forbidden = new ApiError(403, 'permission_denied', 'No access.');
      listMock.mockRejectedValue(forbidden);

      const { result } = renderOrders();

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.error).toBe(forbidden);
      expect(result.current.orders).toEqual([]);
    });
  });

  describe('load more', () => {
    it('reports another page exists when the backend returns a cursor, and appends it with that cursor', async () => {
      listMock.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
      listMock.mockResolvedValueOnce(page(manyOrgOrders(2, 'b'), null));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.hasMore).toBe(true));

      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.orders).toHaveLength(4));

      expect(listMock).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20, cursor: 'cursor-1' });
      expect(result.current.orders.map((order) => order.id)).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);
      expect(result.current.hasMore).toBe(false);
      expect(result.current.loadingMore).toBe(false);
    });

    it('carries the outlet filter into every later page', async () => {
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'a'), 'cursor-1'));
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'b'), null));

      const { result } = renderOrders('org-1', 'outlet-2');
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.orders).toHaveLength(2));

      expect(listMock).toHaveBeenNthCalledWith(1, 'org-1', { outletId: 'outlet-2', limit: 20 });
      expect(listMock).toHaveBeenNthCalledWith(2, 'org-1', { outletId: 'outlet-2', limit: 20, cursor: 'cursor-1' });
    });

    it('is a no-op when there is no next page', async () => {
      listMock.mockResolvedValue(page([confirmedOrgOrder], null));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => result.current.loadMore());

      expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('ignores a second request while one is already in flight', async () => {
      const second = deferred<OrganizationOrdersPage>();
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'a'), 'cursor-1'));
      listMock.mockReturnValueOnce(second.promise);

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => {
        result.current.loadMore();
        result.current.loadMore();
      });

      expect(listMock).toHaveBeenCalledTimes(2);
      expect(result.current.loadingMore).toBe(true);
      await act(async () => second.resolve(page([], null)));
    });

    it('keeps the pages already loaded when a later page fails, and can try that page again', async () => {
      const failure = new ApiError(503, 'unavailable', 'down');
      listMock.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
      listMock.mockRejectedValueOnce(failure);
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'b'), null));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.loadMoreError).toBe(failure));

      expect(result.current.status).toBe('ready');
      expect(result.current.orders).toHaveLength(2);
      expect(result.current.hasMore).toBe(true);

      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.orders).toHaveLength(3));
      expect(listMock).toHaveBeenLastCalledWith('org-1', { outletId: undefined, limit: 20, cursor: 'cursor-1' });
      expect(result.current.loadMoreError).toBeNull();
    });

    it('never renders an order twice, even if a page repeats one', async () => {
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], 'cursor-1'));
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder, pendingOrgOrder], null));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.orders).toHaveLength(2));

      expect(result.current.orders.map((order) => order.id)).toEqual(['order-confirmed-1', 'order-pending-2']);
    });
  });

  describe('refresh', () => {
    it('re-fetches the first page without blanking the list, then replaces it', async () => {
      const fresh = deferred<OrganizationOrdersPage>();
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], null));
      listMock.mockReturnValueOnce(fresh.promise);

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => result.current.refresh());

      expect(result.current.status).toBe('ready');
      expect(result.current.refreshing).toBe(true);
      expect(result.current.orders.map((order) => order.id)).toEqual(['order-confirmed-1']);

      await act(async () => fresh.resolve(page([pendingOrgOrder, confirmedOrgOrder], null)));

      expect(result.current.refreshing).toBe(false);
      expect(result.current.orders.map((order) => order.id)).toEqual(['order-pending-2', 'order-confirmed-1']);
    });

    it('keeps the list and reports refreshError when the refresh fails; the next success clears it', async () => {
      const failure = new ApiError(503, 'unavailable', 'down');
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], null));
      listMock.mockRejectedValueOnce(failure);
      listMock.mockResolvedValueOnce(page([pendingOrgOrder], null));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.refreshError).toBe(failure));

      expect(result.current.status).toBe('ready');
      expect(result.current.refreshing).toBe(false);
      expect(result.current.orders.map((order) => order.id)).toEqual(['order-confirmed-1']);

      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.orders[0].id).toBe('order-pending-2'));
      expect(result.current.refreshError).toBeNull();
    });

    describe('when the refresh is refused with a 403 (access lost while the page was open)', () => {
      const forbidden = new ApiError(403, 'permission_denied', 'You do not have access to this organization.');

      it('clears the loaded rows and the pagination state, and reports the 403 as the error', async () => {
        listMock.mockResolvedValueOnce(page(manyOrgOrders(3, 'a'), 'cursor-1'));
        listMock.mockRejectedValueOnce(forbidden);

        const { result } = renderOrders();
        await waitFor(() => expect(result.current.hasMore).toBe(true));
        expect(result.current.orders).toHaveLength(3);

        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.status).toBe('error'));

        expect(result.current.error).toBe(forbidden);
        expect(result.current.orders).toEqual([]);
        expect(result.current.hasMore).toBe(false);
        expect(result.current.loadingMore).toBe(false);
        expect(result.current.loadMoreError).toBeNull();
        expect(result.current.refreshing).toBe(false);
        expect(result.current.refreshError).toBeNull();
      });

      it('leaves no way to load further pages of the orders it dropped', async () => {
        listMock.mockResolvedValueOnce(page(manyOrgOrders(3, 'a'), 'cursor-1'));
        listMock.mockRejectedValueOnce(forbidden);

        const { result } = renderOrders();
        await waitFor(() => expect(result.current.hasMore).toBe(true));
        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.status).toBe('error'));
        act(() => result.current.loadMore());

        expect(listMock).toHaveBeenCalledTimes(2);
      });

      it('also clears a "load more" that was still in flight, whose page can then never land', async () => {
        const staleMore = deferred<OrganizationOrdersPage>();
        listMock.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
        listMock.mockReturnValueOnce(staleMore.promise);
        listMock.mockRejectedValueOnce(forbidden);

        const { result } = renderOrders();
        await waitFor(() => expect(result.current.hasMore).toBe(true));
        act(() => result.current.loadMore());
        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.status).toBe('error'));
        await act(async () => staleMore.resolve(page(manyOrgOrders(2, 'stale'), null)));

        expect(result.current.status).toBe('error');
        expect(result.current.orders).toEqual([]);
        expect(result.current.loadingMore).toBe(false);
      });

      it('lets Refresh ask again afterwards, and shows the orders if access was restored', async () => {
        listMock.mockResolvedValueOnce(page([confirmedOrgOrder], null));
        listMock.mockRejectedValueOnce(forbidden);
        listMock.mockResolvedValueOnce(page([pendingOrgOrder, confirmedOrgOrder], null));

        const { result } = renderOrders();
        await waitFor(() => expect(result.current.status).toBe('ready'));
        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.status).toBe('error'));

        act(() => result.current.refresh());
        expect(result.current.status).toBe('loading');
        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(result.current.orders.map((order) => order.id)).toEqual(['order-pending-2', 'order-confirmed-1']);
      });
    });

    it.each([
      ['a 500', new ApiError(500, 'internal', 'boom')],
      ['a 503', new ApiError(503, 'unavailable', 'down')],
      ['a 401', new ApiError(401, 'unauthenticated', 'expired')],
      ['a 404', new ApiError(404, 'not_found', 'Outlet not found.')],
      ['a network failure', new TypeError('Failed to fetch')],
    ])('still keeps the loaded list when the refresh fails with %s', async (_label, failure) => {
      listMock.mockResolvedValueOnce(page(manyOrgOrders(2, 'a'), 'cursor-1'));
      listMock.mockRejectedValueOnce(failure);

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.refreshError).toBe(failure));

      expect(result.current.status).toBe('ready');
      expect(result.current.orders.map((order) => order.id)).toEqual(['a-1', 'a-2']);
      expect(result.current.hasMore).toBe(true);
    });

    it('is a no-op while the first load is still in flight', () => {
      listMock.mockReturnValue(new Promise(() => {}));

      const { result } = renderOrders();
      act(() => result.current.refresh());

      expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('is a no-op while another refresh is in flight', async () => {
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], null));
      listMock.mockReturnValueOnce(new Promise(() => {}));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        result.current.refresh();
        result.current.refresh();
      });

      expect(listMock).toHaveBeenCalledTimes(2);
    });

    it('reloads from scratch, with the loading state, when the first load had failed', async () => {
      listMock.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], null));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.status).toBe('error'));
      act(() => result.current.refresh());

      expect(result.current.status).toBe('loading');
      await waitFor(() => expect(result.current.status).toBe('ready'));
    });

    it('drops a "load more" that was in flight, so its page cannot be appended to the refreshed list', async () => {
      const staleMore = deferred<OrganizationOrdersPage>();
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'a'), 'cursor-1'));
      listMock.mockReturnValueOnce(staleMore.promise);
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'fresh'), 'cursor-fresh'));

      const { result } = renderOrders();
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => result.current.loadMore());
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.orders[0].id).toBe('fresh-1'));
      await act(async () => staleMore.resolve(page(manyOrgOrders(1, 'stale'), null)));

      expect(result.current.orders.map((order) => order.id)).toEqual(['fresh-1']);
      expect(result.current.loadingMore).toBe(false);
    });
  });

  describe('changing scope', () => {
    it('starts over for a new outlet filter: loading, not the previous outlet\'s orders', async () => {
      const second = deferred<OrganizationOrdersPage>();
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], 'cursor-1'));
      listMock.mockReturnValueOnce(second.promise);

      const { result, rerender } = renderOrders('org-1', null);
      await waitFor(() => expect(result.current.status).toBe('ready'));

      rerender({ organizationId: 'org-1', outletId: 'outlet-2' });

      expect(result.current.status).toBe('loading');
      expect(result.current.orders).toEqual([]);
      expect(result.current.hasMore).toBe(false);
      expect(listMock).toHaveBeenLastCalledWith('org-1', { outletId: 'outlet-2', limit: 20 });

      await act(async () => second.resolve(page([pendingOrgOrder], null)));
      expect(result.current.status).toBe('ready');
      expect(result.current.orders.map((order) => order.id)).toEqual(['order-pending-2']);
    });

    it('discards a slow response that belongs to the previous filter', async () => {
      const slowAll = deferred<OrganizationOrdersPage>();
      const outlet2 = deferred<OrganizationOrdersPage>();
      listMock.mockReturnValueOnce(slowAll.promise);
      listMock.mockReturnValueOnce(outlet2.promise);

      const { result, rerender } = renderOrders('org-1', null);
      rerender({ organizationId: 'org-1', outletId: 'outlet-2' });
      await act(async () => outlet2.resolve(page([pendingOrgOrder], null)));
      await act(async () => slowAll.resolve(page([confirmedOrgOrder, cancelledOrgOrder], null)));

      expect(result.current.orders.map((order) => order.id)).toEqual(['order-pending-2']);
    });

    it('does not let a "load more" of the previous filter land on the new one', async () => {
      const staleMore = deferred<OrganizationOrdersPage>();
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'all'), 'cursor-all'));
      listMock.mockReturnValueOnce(staleMore.promise);
      listMock.mockResolvedValueOnce(page(manyOrgOrders(1, 'o2'), null));

      const { result, rerender } = renderOrders('org-1', null);
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => result.current.loadMore());
      rerender({ organizationId: 'org-1', outletId: 'outlet-2' });
      await waitFor(() => expect(result.current.orders.map((order) => order.id)).toEqual(['o2-1']));
      await act(async () => staleMore.resolve(page(manyOrgOrders(1, 'stale'), null)));

      expect(result.current.orders.map((order) => order.id)).toEqual(['o2-1']);
    });

    it('reloads when the organization changes', async () => {
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], null));
      listMock.mockResolvedValueOnce(page([pendingOrgOrder], null));

      const { result, rerender } = renderOrders('org-1', null);
      await waitFor(() => expect(result.current.status).toBe('ready'));
      rerender({ organizationId: 'org-2', outletId: null });
      await waitFor(() => expect(result.current.orders[0]?.id).toBe('order-pending-2'));

      expect(listMock).toHaveBeenLastCalledWith('org-2', { outletId: undefined, limit: 20 });
    });

    it('returns to a previous filter by fetching it afresh', async () => {
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder], null));
      listMock.mockResolvedValueOnce(page([pendingOrgOrder], null));
      listMock.mockResolvedValueOnce(page([confirmedOrgOrder, cancelledOrgOrder], null));

      const { result, rerender } = renderOrders('org-1', null);
      await waitFor(() => expect(result.current.status).toBe('ready'));
      rerender({ organizationId: 'org-1', outletId: 'outlet-2' });
      await waitFor(() => expect(result.current.orders[0]?.id).toBe('order-pending-2'));
      rerender({ organizationId: 'org-1', outletId: null });
      await waitFor(() => expect(result.current.orders).toHaveLength(2));

      expect(listMock).toHaveBeenCalledTimes(3);
    });
  });
});

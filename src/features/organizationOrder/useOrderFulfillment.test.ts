import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { confirmedOrgOrder, preparingOrgOrder } from '../../test/organizationOrderFixtures';
import { runFulfillmentAction } from './api';
import type { OrganizationOrderSummary } from './types';
import { useOrderFulfillment } from './useOrderFulfillment';

vi.mock('./api');

const mockedRun = vi.mocked(runFulfillmentAction);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * `listLoadId` is the load the rows on screen came from; `rerender({ listLoadId })` plays the list
 * landing a newer one. The refresh a failure asks for is, unless a test says otherwise, the load right
 * after the one on screen.
 */
function setup(organizationId = 'org-1', initialLoadId = 1) {
  const onOrderUpdated = vi.fn<(order: OrganizationOrderSummary) => void>();
  const onNeedsRefresh = vi.fn<() => number>(() => initialLoadId + 1);
  const hook = renderHook(
    (props: { listLoadId: number }) =>
      useOrderFulfillment({ organizationId, onOrderUpdated, onNeedsRefresh, listLoadId: props.listLoadId }),
    { initialProps: { listLoadId: initialLoadId } },
  );
  return { ...hook, onOrderUpdated, onNeedsRefresh };
}

describe('useOrderFulfillment', () => {
  beforeEach(() => {
    mockedRun.mockReset();
  });

  it('starts idle: nothing pending, no errors', () => {
    const { result } = setup();

    expect(result.current.pendingOrderIds.size).toBe(0);
    expect(result.current.errors).toEqual({});
  });

  it("sends the organization, order and action, and hands the backend's row to onOrderUpdated", async () => {
    mockedRun.mockResolvedValue(preparingOrgOrder);
    const { result, onOrderUpdated, onNeedsRefresh } = setup('org-7');

    await act(() => result.current.run('order-confirmed-1', 'start-preparing'));

    expect(mockedRun).toHaveBeenCalledWith('org-7', 'order-confirmed-1', 'start-preparing');
    expect(onOrderUpdated).toHaveBeenCalledTimes(1);
    expect(onOrderUpdated).toHaveBeenCalledWith(preparingOrgOrder);
    expect(onNeedsRefresh).not.toHaveBeenCalled();
    expect(result.current.pendingOrderIds.size).toBe(0);
    expect(result.current.errors).toEqual({});
  });

  it('marks the order pending while its request is in flight, then clears it', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValue(request.promise);
    const { result } = setup();

    let running!: Promise<void>;
    act(() => {
      running = result.current.run('order-confirmed-1', 'start-preparing');
    });

    expect(result.current.pendingOrderIds.has('order-confirmed-1')).toBe(true);

    await act(async () => {
      request.resolve(preparingOrgOrder);
      await running;
    });
    expect(result.current.pendingOrderIds.has('order-confirmed-1')).toBe(false);
  });

  it('ignores a second press for an order whose request is still in flight, even before React re-renders', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValue(request.promise);
    const { result } = setup();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.run('order-confirmed-1', 'start-preparing');
      second = result.current.run('order-confirmed-1', 'start-preparing');
    });

    expect(mockedRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      request.resolve(preparingOrgOrder);
      await Promise.all([first, second]);
    });
  });

  it('lets different orders be in flight at once', async () => {
    const a = deferred<OrganizationOrderSummary>();
    const b = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = setup();

    let runs!: Promise<void>[];
    act(() => {
      runs = [result.current.run('order-a', 'start-preparing'), result.current.run('order-b', 'mark-ready')];
    });

    expect(mockedRun).toHaveBeenCalledTimes(2);
    expect([...result.current.pendingOrderIds].sort()).toEqual(['order-a', 'order-b']);
    await act(async () => {
      a.resolve({ ...preparingOrgOrder, id: 'order-a' });
      b.resolve({ ...preparingOrgOrder, id: 'order-b' });
      await Promise.all(runs);
    });
  });

  it('allows the same order to be acted on again once its request has finished', async () => {
    mockedRun.mockResolvedValue(preparingOrgOrder);
    const { result } = setup();

    await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
    await act(() => result.current.run('order-confirmed-1', 'mark-ready'));

    expect(mockedRun).toHaveBeenCalledTimes(2);
    expect(mockedRun).toHaveBeenLastCalledWith('org-1', 'order-confirmed-1', 'mark-ready');
  });

  it.each([
    [409, 'This order has changed since you loaded it. The list has been refreshed.'],
    [404, "This order couldn't be found. The list has been refreshed."],
    [403, "You don't have access to change this order."],
  ])('on a %i: shows the message for that order, updates no row, and asks for a refresh', async (status, message) => {
    mockedRun.mockRejectedValue(new ApiError(status, 'x', 'x'));
    const { result, onOrderUpdated, onNeedsRefresh } = setup();

    await act(() => result.current.run('order-confirmed-1', 'start-preparing'));

    expect(result.current.errors).toEqual({ 'order-confirmed-1': message });
    expect(onOrderUpdated).not.toHaveBeenCalled();
    expect(onNeedsRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.pendingOrderIds.size).toBe(0);
  });

  it.each([
    [new ApiError(503, 'unavailable', 'x'), 'Zesto is temporarily unavailable. Please try again in a moment.'],
    [new TypeError('Failed to fetch'), 'Something went wrong. Please check your connection and try again.'],
  ])('on %s: shows the message and does NOT refresh — nothing is known to have changed', async (error, message) => {
    mockedRun.mockRejectedValue(error);
    const { result, onOrderUpdated, onNeedsRefresh } = setup();

    await act(() => result.current.run('order-confirmed-1', 'start-preparing'));

    expect(result.current.errors).toEqual({ 'order-confirmed-1': message });
    expect(onOrderUpdated).not.toHaveBeenCalled();
    expect(onNeedsRefresh).not.toHaveBeenCalled();
  });

  it("keeps one order's error from touching another's, and clears it when that order is tried again", async () => {
    mockedRun.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'));
    const { result } = setup();
    await act(() => result.current.run('order-a', 'start-preparing'));
    expect(Object.keys(result.current.errors)).toEqual(['order-a']);

    mockedRun.mockResolvedValueOnce({ ...preparingOrgOrder, id: 'order-b' });
    await act(() => result.current.run('order-b', 'start-preparing'));
    expect(Object.keys(result.current.errors)).toEqual(['order-a']);

    const retry = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValueOnce(retry.promise);
    let retrying!: Promise<void>;
    act(() => {
      retrying = result.current.run('order-a', 'start-preparing');
    });
    expect(result.current.errors).toEqual({});

    await act(async () => {
      retry.resolve({ ...preparingOrgOrder, id: 'order-a' });
      await retrying;
    });
    await waitFor(() => expect(result.current.pendingOrderIds.size).toBe(0));
  });

  it('hands an unchanged repeat (a 200 for an action already done) to onOrderUpdated like any other success', async () => {
    mockedRun.mockResolvedValue(confirmedOrgOrder);
    const { result, onOrderUpdated } = setup();

    await act(() => result.current.run('order-confirmed-1', 'start-preparing'));

    expect(onOrderUpdated).toHaveBeenCalledWith(confirmedOrgOrder);
  });

  describe('errors going stale once the list is read again', () => {
    const conflict = new ApiError(409, 'conflict', 'x');
    const conflictMessage = 'This order has changed since you loaded it. The list has been refreshed.';
    const unavailable = new ApiError(503, 'unavailable', 'x');
    const unavailableMessage = 'Zesto is temporarily unavailable. Please try again in a moment.';

    it('keeps the error of a refused action through the very load that action asked for', async () => {
      mockedRun.mockRejectedValue(conflict);
      const { result, rerender } = setup();

      await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
      rerender({ listLoadId: 2 });

      expect(result.current.errors).toEqual({ 'order-confirmed-1': conflictMessage });
    });

    it('drops it as soon as a later load lands', async () => {
      mockedRun.mockRejectedValue(conflict);
      const { result, rerender } = setup();

      await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
      rerender({ listLoadId: 2 });
      rerender({ listLoadId: 3 });

      expect(result.current.errors).toEqual({});
    });

    it('does not mistake a later load for its own when the load it asked for failed (access really lost, then restored)', async () => {
      mockedRun.mockRejectedValue(new ApiError(403, 'permission_denied', 'x'));
      const { result, rerender } = setup();

      await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
      // The re-read (load 2) is refused: the list goes to its error state, which has no load.
      rerender({ listLoadId: 0 });
      expect(result.current.errors).toEqual({ 'order-confirmed-1': "You don't have access to change this order." });

      // Access is back and the next load (3) lands.
      rerender({ listLoadId: 3 });

      expect(result.current.errors).toEqual({});
    });

    it('waits for the load that was already in flight when the refresh was asked for, and no longer', async () => {
      mockedRun.mockRejectedValue(conflict);
      const { result, onNeedsRefresh, rerender } = setup();
      // A refresh was already running (load 2); the one this failure asked for is that same load.
      onNeedsRefresh.mockReturnValue(2);

      await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
      rerender({ listLoadId: 2 });
      expect(result.current.errors).toEqual({ 'order-confirmed-1': conflictMessage });

      rerender({ listLoadId: 3 });
      expect(result.current.errors).toEqual({});
    });

    it('drops an error that asked for no refresh when the next load lands, and keeps it until then', async () => {
      mockedRun.mockRejectedValue(unavailable);
      const { result, onNeedsRefresh, rerender } = setup();

      await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
      rerender({ listLoadId: 1 });
      expect(result.current.errors).toEqual({ 'order-confirmed-1': unavailableMessage });
      expect(onNeedsRefresh).not.toHaveBeenCalled();

      rerender({ listLoadId: 2 });
      expect(result.current.errors).toEqual({});
    });

    it('keeps an error through a refresh that fails, since no load landed', async () => {
      mockedRun.mockRejectedValue(unavailable);
      const { result, rerender } = setup();

      await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
      // A failed refresh leaves the rows, and so the load id, as they were.
      rerender({ listLoadId: 1 });

      expect(result.current.errors).toEqual({ 'order-confirmed-1': unavailableMessage });
    });

    it('treats a load that landed while the action was in flight as older than the error it then fails with', async () => {
      const request = deferred<OrganizationOrderSummary>();
      mockedRun.mockReturnValue(request.promise);
      const { result, rerender } = setup();

      let running!: Promise<void>;
      act(() => {
        running = result.current.run('order-confirmed-1', 'start-preparing');
      });
      rerender({ listLoadId: 2 });
      await act(async () => {
        request.reject(unavailable);
        await running;
      });

      expect(result.current.errors).toEqual({ 'order-confirmed-1': unavailableMessage });
      rerender({ listLoadId: 3 });
      expect(result.current.errors).toEqual({});
    });

    it("drops every order's error when a later load lands, not just one's", async () => {
      mockedRun.mockRejectedValue(unavailable);
      const { result, rerender } = setup();

      await act(() => result.current.run('order-a', 'start-preparing'));
      await act(() => result.current.run('order-b', 'mark-ready'));
      expect(Object.keys(result.current.errors).sort()).toEqual(['order-a', 'order-b']);

      rerender({ listLoadId: 2 });

      expect(result.current.errors).toEqual({});
    });

    it('stays dropped across a stretch with no rows on screen (loading, or access lost) and rows again', async () => {
      mockedRun.mockRejectedValue(unavailable);
      const { result, rerender } = setup();

      await act(() => result.current.run('order-confirmed-1', 'start-preparing'));
      rerender({ listLoadId: 2 });
      expect(result.current.errors).toEqual({});

      rerender({ listLoadId: 0 });
      rerender({ listLoadId: 2 });

      expect(result.current.errors).toEqual({});
    });
  });
});

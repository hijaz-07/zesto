import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import {
  completedOrder,
  confirmedOrder,
  pendingOrder,
  pickedUpOrder,
  preparingOrder,
  readyOrder,
} from '../../test/paymentFixtures';
import { getOrder } from './api';
import type { Order } from './types';
import { READY_ORDER_REFRESH_MS, useReadyOrderRefresh } from './useReadyOrderRefresh';

vi.mock('./api');

const mockedGetOrder = vi.mocked(getOrder);

let visibility: DocumentVisibilityState = 'visible';

/** Hides or shows the page the way a browser does: change the state, then fire the event. */
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Lets `ms` of fake time pass, with the promises the timers start settling as they go. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useReadyOrderRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    mockedGetOrder.mockReset();
    mockedGetOrder.mockResolvedValue({ order: readyOrder });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('only a Ready order is polled', () => {
    it.each([
      ['pending_payment', pendingOrder],
      ['confirmed', confirmedOrder],
      ['preparing', preparingOrder],
      ['picked_up', pickedUpOrder],
      ['completed', completedOrder],
      ['cancelled', { ...pendingOrder, status: 'cancelled' as const }],
    ])('never reads a %s order, however long it is on screen', async (_status, order) => {
      const { result } = renderHook(() => useReadyOrderRefresh(order));

      await pass(READY_ORDER_REFRESH_MS * 6);
      act(() => setVisibility('hidden'));
      act(() => setVisibility('visible'));
      await pass(READY_ORDER_REFRESH_MS * 6);

      expect(mockedGetOrder).not.toHaveBeenCalled();
      expect(result.current).toBe(order);
    });

    it('does nothing while there is no order', async () => {
      const { result } = renderHook(() => useReadyOrderRefresh(null));

      await pass(READY_ORDER_REFRESH_MS * 3);

      expect(result.current).toBeNull();
      expect(mockedGetOrder).not.toHaveBeenCalled();
    });
  });

  describe('while Ready and visible', () => {
    it('reads the order through the existing order-detail API about every ten seconds — not sooner', async () => {
      renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS - 1);
      expect(mockedGetOrder).not.toHaveBeenCalled();

      await pass(1);
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
      expect(mockedGetOrder).toHaveBeenCalledWith('order-1');

      await pass(READY_ORDER_REFRESH_MS);
      expect(mockedGetOrder).toHaveBeenCalledTimes(2);
      await pass(READY_ORDER_REFRESH_MS);
      expect(mockedGetOrder).toHaveBeenCalledTimes(3);
    });

    it('reads only the order on screen, by id, and nothing else', async () => {
      renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS * 2);

      expect(mockedGetOrder.mock.calls).toEqual([['order-1'], ['order-1']]);
    });

    it('does not restart its beat when the page re-renders with an equal Ready order', async () => {
      const { rerender } = renderHook(({ order }) => useReadyOrderRefresh(order), {
        initialProps: { order: readyOrder as Order | null },
      });

      await pass(READY_ORDER_REFRESH_MS / 2);
      rerender({ order: { ...readyOrder } });
      await pass(READY_ORDER_REFRESH_MS / 2);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });

    it('returns the order it read, replacing the one it was given', async () => {
      const newer = { ...readyOrder, updatedAt: '2026-09-30T08:41:00+05:30' };
      mockedGetOrder.mockResolvedValue({ order: newer });
      const { result } = renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS);

      expect(result.current).toEqual(newer);
    });

    it('never overlaps requests: the next read is scheduled only after the previous one finishes', async () => {
      const slow = deferred<{ order: Order }>();
      mockedGetOrder.mockReturnValueOnce(slow.promise);
      renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS);
      await pass(READY_ORDER_REFRESH_MS * 5);
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);

      await act(async () => slow.resolve({ order: readyOrder }));
      await pass(READY_ORDER_REFRESH_MS);
      expect(mockedGetOrder).toHaveBeenCalledTimes(2);
    });
  });

  describe('it stops the instant the order is no longer Ready', () => {
    it.each([
      ['picked_up', pickedUpOrder],
      ['completed', completedOrder],
    ])('stops polling for good after a read shows %s, and returns that order', async (_status, moved) => {
      mockedGetOrder.mockResolvedValue({ order: moved });
      const { result } = renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS);
      expect(result.current).toEqual(moved);
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);

      await pass(READY_ORDER_REFRESH_MS * 10);
      act(() => setVisibility('hidden'));
      act(() => setVisibility('visible'));
      await pass(READY_ORDER_REFRESH_MS * 10);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
      expect(result.current).toEqual(moved);
    });

    it('stops without waiting for the next beat even if the read returned a state this build does not know', async () => {
      mockedGetOrder.mockResolvedValue({ order: { ...readyOrder, status: 'out_for_delivery' as never } });
      renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS * 5);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });

    it('stops when the page is handed an order that has moved on (it was refreshed elsewhere)', async () => {
      const { rerender } = renderHook(({ order }) => useReadyOrderRefresh(order), {
        initialProps: { order: readyOrder as Order | null },
      });
      await pass(READY_ORDER_REFRESH_MS);
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);

      rerender({ order: pickedUpOrder });
      await pass(READY_ORDER_REFRESH_MS * 5);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('the page being hidden', () => {
    it('reads nothing while the page is hidden', async () => {
      renderHook(() => useReadyOrderRefresh(readyOrder));
      await pass(READY_ORDER_REFRESH_MS);
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);

      act(() => setVisibility('hidden'));
      await pass(READY_ORDER_REFRESH_MS * 6);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });

    it('reads nothing when it mounts on a page that is already hidden', async () => {
      visibility = 'hidden';
      renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS * 6);

      expect(mockedGetOrder).not.toHaveBeenCalled();
    });

    it('re-reads at once when the page becomes visible again, then resumes the ten-second beat', async () => {
      renderHook(() => useReadyOrderRefresh(readyOrder));
      act(() => setVisibility('hidden'));
      await pass(READY_ORDER_REFRESH_MS * 3);

      await act(async () => setVisibility('visible'));
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);

      await pass(READY_ORDER_REFRESH_MS - 1);
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
      await pass(1);
      expect(mockedGetOrder).toHaveBeenCalledTimes(2);
    });

    it('does not read when a request that was in flight finishes after the page was hidden', async () => {
      const slow = deferred<{ order: Order }>();
      mockedGetOrder.mockReturnValueOnce(slow.promise);
      renderHook(() => useReadyOrderRefresh(readyOrder));
      await pass(READY_ORDER_REFRESH_MS);

      act(() => setVisibility('hidden'));
      await act(async () => slow.resolve({ order: readyOrder }));
      await pass(READY_ORDER_REFRESH_MS * 5);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });

    it('does not start a second read when the page becomes visible while one is still in flight', async () => {
      const slow = deferred<{ order: Order }>();
      mockedGetOrder.mockReturnValueOnce(slow.promise);
      renderHook(() => useReadyOrderRefresh(readyOrder));
      await pass(READY_ORDER_REFRESH_MS);

      act(() => setVisibility('hidden'));
      await act(async () => setVisibility('visible'));

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });

    it('does not read when the page becomes visible but the order has since moved on', async () => {
      mockedGetOrder.mockResolvedValue({ order: pickedUpOrder });
      renderHook(() => useReadyOrderRefresh(readyOrder));
      act(() => setVisibility('hidden'));
      await act(async () => setVisibility('visible'));
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);

      act(() => setVisibility('hidden'));
      await act(async () => setVisibility('visible'));

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('unmounting', () => {
    it('stops the beat', async () => {
      const { unmount } = renderHook(() => useReadyOrderRefresh(readyOrder));
      await pass(READY_ORDER_REFRESH_MS);
      expect(mockedGetOrder).toHaveBeenCalledTimes(1);

      unmount();
      await pass(READY_ORDER_REFRESH_MS * 6);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    });

    it('removes its visibility listener, so a later show/hide reads nothing', async () => {
      const { unmount } = renderHook(() => useReadyOrderRefresh(readyOrder));
      unmount();

      act(() => setVisibility('hidden'));
      await act(async () => setVisibility('visible'));

      expect(mockedGetOrder).not.toHaveBeenCalled();
    });

    it('leaves no timer pending', () => {
      const { unmount } = renderHook(() => useReadyOrderRefresh(readyOrder));

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores a read that finishes after unmount', async () => {
      const slow = deferred<{ order: Order }>();
      mockedGetOrder.mockReturnValueOnce(slow.promise);
      const { unmount } = renderHook(() => useReadyOrderRefresh(readyOrder));
      await pass(READY_ORDER_REFRESH_MS);

      unmount();
      await act(async () => slow.resolve({ order: pickedUpOrder }));
      await pass(READY_ORDER_REFRESH_MS * 3);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('a failed read changes nothing on screen', () => {
    it.each([
      ['a network failure', new TypeError('Failed to fetch')],
      ['a 503', new ApiError(503, 'unavailable', 'down')],
      ['a 500', new ApiError(500, 'internal', 'boom')],
    ])('after %s it keeps the order it had and tries again on the next beat', async (_label, failure) => {
      mockedGetOrder.mockRejectedValueOnce(failure);
      const { result } = renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS);
      expect(result.current).toBe(readyOrder);

      await pass(READY_ORDER_REFRESH_MS);
      expect(mockedGetOrder).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 404])('stops for good after a %s: the session or the order is no longer theirs', async (status) => {
      mockedGetOrder.mockRejectedValue(new ApiError(status, 'x', 'no'));
      const { result } = renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS * 6);

      expect(mockedGetOrder).toHaveBeenCalledTimes(1);
      expect(result.current).toBe(readyOrder);
    });

    it('ignores an answer about a different order', async () => {
      mockedGetOrder.mockResolvedValue({ order: { ...pickedUpOrder, id: 'order-other' } });
      const { result } = renderHook(() => useReadyOrderRefresh(readyOrder));

      await pass(READY_ORDER_REFRESH_MS * 2);

      expect(result.current).toBe(readyOrder);
      expect(mockedGetOrder).toHaveBeenCalledTimes(2);
    });
  });

  it('does not carry a read for one order over to a different order', async () => {
    mockedGetOrder.mockResolvedValue({ order: { ...readyOrder, updatedAt: '2026-10-01T10:00:00+05:30' } });
    const { result, rerender } = renderHook(({ order }) => useReadyOrderRefresh(order), {
      initialProps: { order: readyOrder as Order | null },
    });
    await pass(READY_ORDER_REFRESH_MS);

    const other = { ...readyOrder, id: 'order-2' };
    rerender({ order: other });

    expect(result.current).toBe(other);
  });
});

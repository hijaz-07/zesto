import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { cancellableConfirmedOrder, cancelledPaidOrder, lockedPreparingOrder } from '../../test/cancellationFixtures';
import { cancelOrder, getOrder } from './api';
import { useCancelOrder } from './useCancelOrder';

vi.mock('./api');

const mockedCancelOrder = vi.mocked(cancelOrder);
const mockedGetOrder = vi.mocked(getOrder);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useCancelOrder', () => {
  beforeEach(() => {
    mockedCancelOrder.mockReset();
    mockedGetOrder.mockReset();
  });

  it('sends one cancellation with the reason and reports the cancelled order the server returned', async () => {
    const cancelled = cancelledPaidOrder();
    mockedCancelOrder.mockResolvedValue({ order: cancelled });
    const { result } = renderHook(() => useCancelOrder('order-1'));

    let outcome;
    await act(async () => {
      outcome = await result.current.cancel('ordered_by_mistake');
    });

    expect(outcome).toBe('cancelled');
    expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
    expect(mockedCancelOrder).toHaveBeenCalledWith('order-1', 'ordered_by_mistake');
    expect(result.current.order).toBe(cancelled);
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.submitting).toBe(false);
  });

  it('works without a reason', async () => {
    mockedCancelOrder.mockResolvedValue({ order: cancelledPaidOrder() });
    const { result } = renderHook(() => useCancelOrder('order-1'));

    await act(async () => {
      await result.current.cancel();
    });

    expect(mockedCancelOrder).toHaveBeenCalledWith('order-1', undefined);
  });

  it('ignores a second cancel while one is in flight: one request, however many taps', async () => {
    const pending = deferred<{ order: ReturnType<typeof cancelledPaidOrder> }>();
    mockedCancelOrder.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCancelOrder('order-1'));

    let first: Promise<unknown> | undefined;
    let second: unknown;
    await act(async () => {
      first = result.current.cancel();
      second = await result.current.cancel();
    });

    expect(second).toBe('ignored');
    expect(result.current.submitting).toBe(true);
    expect(mockedCancelOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ order: cancelledPaidOrder() });
      await first;
    });
    expect(result.current.submitting).toBe(false);
  });

  it('does nothing when there is no order', async () => {
    const { result } = renderHook(() => useCancelOrder(undefined));

    let outcome;
    await act(async () => {
      outcome = await result.current.cancel();
    });

    expect(outcome).toBe('ignored');
    expect(mockedCancelOrder).not.toHaveBeenCalled();
  });

  describe('409: the order moved on', () => {
    it('re-reads the order and explains why, in words tied to where it now stands', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'internal'));
      mockedGetOrder.mockResolvedValue({ order: lockedPreparingOrder });
      const { result } = renderHook(() => useCancelOrder('order-1'));

      let outcome;
      await act(async () => {
        outcome = await result.current.cancel();
      });

      expect(outcome).toBe('refused');
      expect(mockedGetOrder).toHaveBeenCalledWith('order-1');
      expect(result.current.order).toBe(lockedPreparingOrder);
      expect(result.current.errorMessage).toBe('Preparation has already started, so this order can no longer be cancelled.');
    });

    it('treats an order that turns out to be cancelled already (another tab) as success, not an error', async () => {
      const cancelled = cancelledPaidOrder();
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'internal'));
      mockedGetOrder.mockResolvedValue({ order: cancelled });
      const { result } = renderHook(() => useCancelOrder('order-1'));

      let outcome;
      await act(async () => {
        outcome = await result.current.cancel();
      });

      expect(outcome).toBe('cancelled');
      expect(result.current.order).toBe(cancelled);
      expect(result.current.errorMessage).toBeNull();
    });

    it('falls back to a generic message if the re-read also fails', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'internal'));
      mockedGetOrder.mockRejectedValue(new ApiError(503, 'unavailable', 'x'));
      const { result } = renderHook(() => useCancelOrder('order-1'));

      let outcome;
      await act(async () => {
        outcome = await result.current.cancel();
      });

      expect(outcome).toBe('refused');
      expect(result.current.order).toBeNull();
      expect(result.current.errorMessage).toBe('This order can no longer be cancelled.');
    });

    it('does not retry the cancellation itself', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(409, 'conflict', 'internal'));
      mockedGetOrder.mockResolvedValue({ order: lockedPreparingOrder });
      const { result } = renderHook(() => useCancelOrder('order-1'));

      await act(async () => {
        await result.current.cancel();
      });

      expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('a failure the customer can retry', () => {
    it('503 is reported as a retryable failure and is never retried automatically', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(503, 'unavailable', 'x'));
      const { result } = renderHook(() => useCancelOrder('order-1'));

      let outcome;
      await act(async () => {
        outcome = await result.current.cancel();
      });

      expect(outcome).toBe('failed');
      expect(result.current.errorMessage).toBe('Zesto is temporarily unavailable. Please try again in a moment.');
      expect(result.current.submitting).toBe(false);
      expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
      expect(mockedGetOrder).not.toHaveBeenCalled();
    });

    it('a network error is reported as retryable, and a new attempt clears the old message', async () => {
      mockedCancelOrder.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      mockedCancelOrder.mockResolvedValueOnce({ order: cancellableConfirmedOrder });
      const { result } = renderHook(() => useCancelOrder('order-1'));

      await act(async () => {
        await result.current.cancel();
      });
      expect(result.current.errorMessage).toBe("Couldn't cancel your order. Please check your connection and try again.");

      await act(async () => {
        await result.current.cancel();
      });
      expect(result.current.errorMessage).toBeNull();
      expect(mockedCancelOrder).toHaveBeenCalledTimes(2);
    });

    it.each([
      [401, 'Your session has expired. Please sign in again.'],
      [404, 'Order not found.'],
    ])('%i is explained and not retried', async (status, message) => {
      mockedCancelOrder.mockRejectedValue(new ApiError(status, 'x', 'backend text'));
      const { result } = renderHook(() => useCancelOrder('order-1'));

      await act(async () => {
        await result.current.cancel();
      });

      expect(result.current.errorMessage).toBe(message);
      expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
    });

    it('clearError forgets the message', async () => {
      mockedCancelOrder.mockRejectedValue(new ApiError(503, 'unavailable', 'x'));
      const { result } = renderHook(() => useCancelOrder('order-1'));
      await act(async () => {
        await result.current.cancel();
      });

      act(() => result.current.clearError());

      expect(result.current.errorMessage).toBeNull();
    });
  });

  it('ignores an answer that arrives after unmount', async () => {
    const pending = deferred<{ order: ReturnType<typeof cancelledPaidOrder> }>();
    mockedCancelOrder.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useCancelOrder('order-1'));

    let running: Promise<unknown> | undefined;
    act(() => {
      running = result.current.cancel();
    });
    unmount();
    await act(async () => {
      pending.resolve({ order: cancelledPaidOrder() });
      await running;
    });

    expect(mockedCancelOrder).toHaveBeenCalledTimes(1);
  });
});

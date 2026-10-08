import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { cancelledPaidOrder, cancelledUnpaidOrder, refundOf } from '../../test/cancellationFixtures';
import { getOrder } from './api';
import type { Order } from './types';
import { READY_ORDER_REFRESH_MS, REFUND_REFRESH_MS, useReadyOrderRefresh } from './useReadyOrderRefresh';

/**
 * The same refresh the ready order uses, applied to a cancelled order whose
 * refund is still in flight: slower, only while the page is visible, and not at
 * all once the refund has settled or when there is no refund to wait for.
 */

vi.mock('./api');

const mockedGetOrder = vi.mocked(getOrder);

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useReadyOrderRefresh — a cancelled order with a refund in flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    mockedGetOrder.mockReset();
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('requested')) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is slower than the ready-order beat, so it is not aggressive', () => {
    expect(REFUND_REFRESH_MS).toBeGreaterThan(READY_ORDER_REFRESH_MS);
  });

  it.each(['requested', 'pending'] as const)('re-reads a %s refund every thirty seconds — not sooner', async (status) => {
    renderHook(() => useReadyOrderRefresh(cancelledPaidOrder(refundOf(status))));

    await pass(REFUND_REFRESH_MS - 1);
    expect(mockedGetOrder).not.toHaveBeenCalled();

    await pass(1);
    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
    expect(mockedGetOrder).toHaveBeenCalledWith('order-1');

    await pass(REFUND_REFRESH_MS);
    expect(mockedGetOrder).toHaveBeenCalledTimes(2);
  });

  it.each(['processed', 'failed'] as const)('never reads when the refund has already %s', async (status) => {
    const order = cancelledPaidOrder(refundOf(status));
    const { result } = renderHook(() => useReadyOrderRefresh(order));

    await pass(REFUND_REFRESH_MS * 6);

    expect(mockedGetOrder).not.toHaveBeenCalled();
    expect(result.current).toBe(order);
  });

  it('never reads a cancelled order that has no refund (cancelled before it was paid)', async () => {
    renderHook(() => useReadyOrderRefresh(cancelledUnpaidOrder));

    await pass(REFUND_REFRESH_MS * 6);

    expect(mockedGetOrder).not.toHaveBeenCalled();
  });

  it('shows the settled refund and stops the moment a read says it processed', async () => {
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('processed')) });
    const { result } = renderHook(() => useReadyOrderRefresh(cancelledPaidOrder(refundOf('requested'))));

    await pass(REFUND_REFRESH_MS);

    expect(result.current?.refund?.status).toBe('processed');
    expect(mockedGetOrder).toHaveBeenCalledTimes(1);

    await pass(REFUND_REFRESH_MS * 6);
    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
  });

  it('stops when the refund fails, and shows it', async () => {
    mockedGetOrder.mockResolvedValue({ order: cancelledPaidOrder(refundOf('failed')) });
    const { result } = renderHook(() => useReadyOrderRefresh(cancelledPaidOrder(refundOf('pending'))));

    await pass(REFUND_REFRESH_MS);
    await pass(REFUND_REFRESH_MS * 4);

    expect(result.current?.refund?.status).toBe('failed');
    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
  });

  it('keeps going while the refund is still pending, showing each state it reads', async () => {
    mockedGetOrder.mockResolvedValueOnce({ order: cancelledPaidOrder(refundOf('pending')) });
    const { result } = renderHook(() => useReadyOrderRefresh(cancelledPaidOrder(refundOf('requested'))));

    await pass(REFUND_REFRESH_MS);
    expect(result.current?.refund?.status).toBe('pending');

    await pass(REFUND_REFRESH_MS);
    expect(mockedGetOrder).toHaveBeenCalledTimes(2);
  });

  it('reads nothing while the page is hidden, and reads at once when it is shown again', async () => {
    renderHook(() => useReadyOrderRefresh(cancelledPaidOrder(refundOf('requested'))));

    act(() => setVisibility('hidden'));
    await pass(REFUND_REFRESH_MS * 4);
    expect(mockedGetOrder).not.toHaveBeenCalled();

    await act(async () => setVisibility('visible'));
    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
  });

  it('a failed read changes nothing on screen and the next beat tries again; a 404 stops for good', async () => {
    const order = cancelledPaidOrder(refundOf('requested'));
    mockedGetOrder.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'));
    const { result } = renderHook(() => useReadyOrderRefresh(order));

    await pass(REFUND_REFRESH_MS);
    expect(result.current).toBe(order);

    mockedGetOrder.mockRejectedValueOnce(new ApiError(404, 'not_found', 'x'));
    await pass(REFUND_REFRESH_MS);
    await pass(REFUND_REFRESH_MS * 4);

    expect(mockedGetOrder).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(order);
  });

  it('does not restart its beat when the page re-renders with an equal order', async () => {
    const { rerender } = renderHook(({ order }) => useReadyOrderRefresh(order), {
      initialProps: { order: cancelledPaidOrder(refundOf('requested')) as Order | null },
    });

    await pass(REFUND_REFRESH_MS / 2);
    rerender({ order: cancelledPaidOrder(refundOf('requested')) });
    await pass(REFUND_REFRESH_MS / 2);

    expect(mockedGetOrder).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer pending after unmount', async () => {
    const { unmount } = renderHook(() => useReadyOrderRefresh(cancelledPaidOrder(refundOf('requested'))));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    await pass(REFUND_REFRESH_MS * 3);
    expect(mockedGetOrder).not.toHaveBeenCalled();
  });
});

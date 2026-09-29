import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useOrder } from './useOrder';

const getOrderMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  getOrder: getOrderMock,
}));

const order = {
  id: 'order-1',
  organizationId: 'org-1',
  outletId: 'outlet-1',
  menuId: 'menu-1',
  status: 'pending_payment' as const,
  paymentStatus: 'pending' as const,
  currency: 'INR' as const,
  subtotalInPaise: 12000,
  totalInPaise: 12000,
  items: [{ itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1, lineTotalInPaise: 12000 }],
  createdAt: '2026-09-29T10:00:00+05:30',
  updatedAt: '2026-09-29T10:00:00+05:30',
};

describe('useOrder', () => {
  beforeEach(() => {
    getOrderMock.mockReset();
  });

  it('never calls the API when orderId is missing, and reports idle', () => {
    const { result } = renderHook(() => useOrder(undefined));

    expect(result.current.status).toBe('idle');
    expect(getOrderMock).not.toHaveBeenCalled();
  });

  it('starts loading once orderId is present', async () => {
    getOrderMock.mockResolvedValue({ order });

    const { result } = renderHook(() => useOrder('order-1'));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('becomes ready with the fetched order', async () => {
    getOrderMock.mockResolvedValue({ order });

    const { result } = renderHook(() => useOrder('order-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.order).toEqual(order);
    expect(getOrderMock).toHaveBeenCalledWith('order-1');
  });

  it('moves to an error state on a 404 not_found', async () => {
    const error = new ApiError(404, 'not_found', 'Order not found.');
    getOrderMock.mockRejectedValue(error);

    const { result } = renderHook(() => useOrder('no-such-order'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(error);
    expect(result.current.order).toBeNull();
  });

  it('retry() re-fetches after an error', async () => {
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    getOrderMock.mockRejectedValueOnce(error);
    getOrderMock.mockResolvedValueOnce({ order });

    const { result } = renderHook(() => useOrder('order-1'));
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.order).toEqual(order);
    expect(getOrderMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches on a fresh mount (e.g. a page refresh), never trusting stale in-memory state', async () => {
    getOrderMock.mockResolvedValue({ order });

    const first = renderHook(() => useOrder('order-1'));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    first.unmount();

    const second = renderHook(() => useOrder('order-1'));
    expect(second.result.current.status).toBe('loading');
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(getOrderMock).toHaveBeenCalledTimes(2);
  });
});

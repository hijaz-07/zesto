import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { useCreateOrder } from './useCreateOrder';

const createOrderMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  createOrder: createOrderMock,
}));

const generateIdempotencyKeyMock = vi.hoisted(() => vi.fn());
vi.mock('./idempotencyKey', () => ({
  generateIdempotencyKey: generateIdempotencyKeyMock,
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

const submission = { outletId: 'outlet-1', menuId: 'menu-1', items: [{ itemId: 'item-1', quantity: 1 }] };

describe('useCreateOrder', () => {
  beforeEach(() => {
    createOrderMock.mockReset();
    generateIdempotencyKeyMock.mockReset();
    let counter = 0;
    generateIdempotencyKeyMock.mockImplementation(() => `generated-key-${++counter}`);
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useCreateOrder());

    expect(result.current.status).toBe('idle');
    expect(result.current.order).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('goes through submitting then success, exposing the created order', async () => {
    createOrderMock.mockResolvedValue({ order });
    const { result } = renderHook(() => useCreateOrder());

    let submitPromise!: Promise<unknown>;
    act(() => {
      submitPromise = result.current.submit(submission);
    });
    expect(result.current.status).toBe('submitting');

    await submitPromise;
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.order).toEqual(order);
  });

  it('generates the idempotency key only once and reuses it across retries', async () => {
    createOrderMock.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Try again.'));
    createOrderMock.mockResolvedValueOnce({ order });
    const { result } = renderHook(() => useCreateOrder());

    await act(async () => {
      await expect(result.current.submit(submission)).rejects.toBeInstanceOf(ApiError);
    });
    await act(async () => {
      await result.current.submit(submission);
    });

    expect(generateIdempotencyKeyMock).toHaveBeenCalledTimes(1);
    expect(createOrderMock).toHaveBeenNthCalledWith(1, { ...submission, idempotencyKey: 'generated-key-1' });
    expect(createOrderMock).toHaveBeenNthCalledWith(2, { ...submission, idempotencyKey: 'generated-key-1' });
  });

  it('treats the idempotent-replay response (still a real order) as success like any other', async () => {
    createOrderMock.mockResolvedValue({ order });
    const { result } = renderHook(() => useCreateOrder());

    await act(async () => {
      await result.current.submit(submission);
    });

    expect(result.current.status).toBe('success');
    expect(result.current.order?.id).toBe('order-1');
  });

  it('moves to an error state on failure, without clearing to idle', async () => {
    const error = new ApiError(400, 'invalid_argument', 'Ordering has closed for this menu.');
    createOrderMock.mockRejectedValue(error);
    const { result } = renderHook(() => useCreateOrder());

    await act(async () => {
      await expect(result.current.submit(submission)).rejects.toBe(error);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(error);
  });

  it('reset() clears state and causes the next submit to generate a fresh idempotency key', async () => {
    createOrderMock.mockResolvedValue({ order });
    const { result } = renderHook(() => useCreateOrder());

    await act(async () => {
      await result.current.submit(submission);
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.order).toBeNull();
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.submit(submission);
    });

    expect(generateIdempotencyKeyMock).toHaveBeenCalledTimes(2);
    expect(createOrderMock).toHaveBeenNthCalledWith(2, { ...submission, idempotencyKey: 'generated-key-2' });
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { watchPersistence, type PersistenceGuard } from '../../test/persistenceGuard';
import { getPickupCredential } from './api';
import { useOrderPickup } from './useOrderPickup';

vi.mock('./api');

const mockedGetPickupCredential = vi.mocked(getPickupCredential);

const credential = { qrPayload: 'ZP1.order1.AAAAAAAAAAAAAAAAAAAAAA', code: 'K7QX-4M2P' };

/** A promise the test settles by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useOrderPickup', () => {
  let guard: PersistenceGuard;

  beforeEach(() => {
    mockedGetPickupCredential.mockReset();
    guard = watchPersistence();
  });

  afterEach(() => {
    guard.restore();
  });

  it('asks for nothing while the order is not wanted (not ready), and reports idle', () => {
    const { result } = renderHook(() => useOrderPickup('order-1', false));

    expect(result.current).toMatchObject({ status: 'idle', credential: null, error: null });
    expect(mockedGetPickupCredential).not.toHaveBeenCalled();
  });

  it('asks for nothing without an order id', () => {
    const { result } = renderHook(() => useOrderPickup(undefined, true));

    expect(result.current.status).toBe('idle');
    expect(mockedGetPickupCredential).not.toHaveBeenCalled();
  });

  it('shows loading from the moment the credential is wanted, then the credential', async () => {
    mockedGetPickupCredential.mockResolvedValue(credential);

    const { result } = renderHook(() => useOrderPickup('order-1', true));

    expect(result.current.status).toBe('loading');
    expect(result.current.credential).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.credential).toEqual(credential);
    expect(mockedGetPickupCredential).toHaveBeenCalledTimes(1);
    expect(mockedGetPickupCredential).toHaveBeenCalledWith('order-1');
  });

  it('asks only for the order it was given — never any other order, user or organization', async () => {
    mockedGetPickupCredential.mockResolvedValue(credential);

    const { result } = renderHook(() => useOrderPickup('order-42', true));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(mockedGetPickupCredential.mock.calls).toEqual([['order-42']]);
  });

  describe('memory only', () => {
    it('writes nothing to localStorage, sessionStorage, IndexedDB, cookies, history or the URL', async () => {
      mockedGetPickupCredential.mockResolvedValue(credential);

      const { result, unmount } = renderHook(() => useOrderPickup('order-1', true));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      guard.expectNothingPersisted([credential.qrPayload, credential.code, 'K7QX4M2P']);
      unmount();
      guard.expectNothingPersisted([credential.qrPayload, credential.code, 'K7QX4M2P']);
    });

    it('keeps nothing across a remount: every mount asks the backend afresh', async () => {
      mockedGetPickupCredential.mockResolvedValue(credential);
      const first = renderHook(() => useOrderPickup('order-1', true));
      await waitFor(() => expect(first.result.current.status).toBe('ready'));
      first.unmount();

      const second = renderHook(() => useOrderPickup('order-1', true));

      expect(second.result.current.status).toBe('loading');
      expect(second.result.current.credential).toBeNull();
      await waitFor(() => expect(second.result.current.status).toBe('ready'));
      expect(mockedGetPickupCredential).toHaveBeenCalledTimes(2);
    });

    it('lets go of the credential the moment it is no longer wanted (the order was picked up), not merely hides it', async () => {
      mockedGetPickupCredential.mockResolvedValue(credential);
      const { result, rerender } = renderHook(({ active }) => useOrderPickup('order-1', active), {
        initialProps: { active: true },
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));

      rerender({ active: false });

      expect(result.current).toMatchObject({ status: 'idle', credential: null });
      // And it is gone for real: wanting it again starts from nothing, not from a retained copy.
      mockedGetPickupCredential.mockReturnValue(new Promise(() => {}));
      rerender({ active: true });
      expect(result.current).toMatchObject({ status: 'loading', credential: null });
    });

    it('drops the previous order’s credential when shown a different order', async () => {
      mockedGetPickupCredential.mockResolvedValue(credential);
      const { result, rerender } = renderHook(({ id }) => useOrderPickup(id, true), {
        initialProps: { id: 'order-1' },
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));
      mockedGetPickupCredential.mockReturnValue(new Promise(() => {}));

      rerender({ id: 'order-2' });

      expect(result.current).toMatchObject({ status: 'loading', credential: null });
      expect(mockedGetPickupCredential).toHaveBeenLastCalledWith('order-2');
    });
  });

  it('ignores a response that arrives after the credential stopped being wanted', async () => {
    const slow = deferred<typeof credential>();
    mockedGetPickupCredential.mockReturnValue(slow.promise);
    const { result, rerender } = renderHook(({ active }) => useOrderPickup('order-1', active), {
      initialProps: { active: true },
    });

    rerender({ active: false });
    await act(async () => slow.resolve(credential));

    expect(result.current).toMatchObject({ status: 'idle', credential: null });
  });

  it('ignores a response that arrives after unmount', async () => {
    const slow = deferred<typeof credential>();
    mockedGetPickupCredential.mockReturnValue(slow.promise);
    const { unmount } = renderHook(() => useOrderPickup('order-1', true));

    unmount();

    await expect(act(async () => slow.resolve(credential))).resolves.not.toThrow();
  });

  describe('when the backend refuses or fails', () => {
    it.each([
      [new ApiError(404, 'not_found', 'Order not found.')],
      [new ApiError(409, 'conflict', "This order isn't ready for pickup.")],
      [new ApiError(401, 'unauthenticated', 'expired')],
      [new ApiError(503, 'unavailable', 'down')],
      [new TypeError('Failed to fetch')],
    ])('reports %j as an error, with no credential', async (failure) => {
      mockedGetPickupCredential.mockRejectedValue(failure);

      const { result } = renderHook(() => useOrderPickup('order-1', true));

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.error).toBe(failure);
      expect(result.current.credential).toBeNull();
    });

    it('treats a response that is not even a promise as an error to show, never a crash', async () => {
      mockedGetPickupCredential.mockReturnValue(undefined as never);

      const { result } = renderHook(() => useOrderPickup('order-1', true));

      await waitFor(() => expect(result.current.status).toBe('error'));
    });

    it('retry asks again, showing loading and then the credential, and the old error is gone', async () => {
      mockedGetPickupCredential.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down'));
      mockedGetPickupCredential.mockResolvedValueOnce(credential);
      const { result } = renderHook(() => useOrderPickup('order-1', true));
      await waitFor(() => expect(result.current.status).toBe('error'));

      act(() => result.current.retry());

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.error).toBeNull();
      expect(result.current.credential).toEqual(credential);
      expect(mockedGetPickupCredential).toHaveBeenCalledTimes(2);
    });

    it('does not keep showing a stale credential while a retry is in flight', async () => {
      mockedGetPickupCredential.mockResolvedValueOnce(credential);
      const { result } = renderHook(() => useOrderPickup('order-1', true));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      mockedGetPickupCredential.mockReturnValue(new Promise(() => {}));

      act(() => result.current.retry());

      expect(result.current).toMatchObject({ status: 'loading', credential: null });
    });
  });
});

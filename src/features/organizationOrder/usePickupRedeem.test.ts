import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { completedOrgOrder, pickedUpOrgOrder } from '../../test/organizationOrderFixtures';
import { watchPersistence, type PersistenceGuard } from '../../test/persistenceGuard';
import { redeemPickup, runFulfillmentAction } from './api';
import { PICKUP_INPUT_EMPTY, PICKUP_INPUT_MALFORMED } from './pickupInput';
import type { OrganizationOrderSummary } from './types';
import { usePickupRedeem } from './usePickupRedeem';

vi.mock('./api');

const mockedRedeem = vi.mocked(redeemPickup);
const mockedRun = vi.mocked(runFulfillmentAction);

const CODE = 'K7QX-4M2P';
const QR = 'ZP1.kQ3vR8nT2xLpA7mZdW1e.AbCdEfGhIjKlMnOpQrStUv';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  return renderHook(() => usePickupRedeem('org-1'));
}

describe('usePickupRedeem', () => {
  let guard: PersistenceGuard;

  beforeEach(() => {
    mockedRedeem.mockReset();
    mockedRun.mockReset();
    mockedRedeem.mockResolvedValue(pickedUpOrgOrder);
    guard = watchPersistence();
  });

  afterEach(() => {
    guard.restore();
  });

  describe('redeeming', () => {
    it('starts with nothing on screen', () => {
      const { result } = setup();

      expect(result.current).toMatchObject({ submitting: false, error: null, result: null });
    });

    it('sends the credential for this organization, and shows the backend row it gets back', async () => {
      const { result } = setup();

      await act(() => result.current.submit(CODE, null));

      expect(mockedRedeem).toHaveBeenCalledTimes(1);
      expect(mockedRedeem).toHaveBeenCalledWith('org-1', { credential: CODE, outletId: undefined });
      expect(result.current.result).toEqual({ order: pickedUpOrgOrder, completing: false, completionError: null });
      expect(result.current.error).toBeNull();
      expect(result.current.submitting).toBe(false);
    });

    it('sends the chosen outlet too', async () => {
      const { result } = setup();

      await act(() => result.current.submit(CODE, 'outlet-2'));

      expect(mockedRedeem).toHaveBeenCalledWith('org-1', { credential: CODE, outletId: 'outlet-2' });
    });

    it.each([
      ['a typed code in any form', 'k7qx 4m2p', CODE],
      ['a pasted QR payload', `${QR}\n`, QR],
    ])('normalizes %s before sending it', async (_label, raw, sent) => {
      const { result } = setup();

      await act(() => result.current.submit(raw, null));

      expect(mockedRedeem).toHaveBeenCalledWith('org-1', { credential: sent, outletId: undefined });
    });

    it('shows submitting for the whole request', async () => {
      const request = deferred<OrganizationOrderSummary>();
      mockedRedeem.mockReturnValue(request.promise);
      const { result } = setup();

      act(() => void result.current.submit(CODE, null));
      expect(result.current.submitting).toBe(true);

      await act(async () => request.resolve(pickedUpOrgOrder));
      expect(result.current.submitting).toBe(false);
    });
  });

  describe('input that is plainly not a pickup code', () => {
    it.each([
      ['nothing', '', PICKUP_INPUT_EMPTY],
      ['blank', '   ', PICKUP_INPUT_EMPTY],
      ['a short code', 'K7QX', PICKUP_INPUT_MALFORMED],
      ['a malformed payload', 'ZP1.nope', PICKUP_INPUT_MALFORMED],
    ])('refuses %s without sending anything', async (_label, raw, message) => {
      const { result } = setup();

      await act(() => result.current.submit(raw, null));

      expect(mockedRedeem).not.toHaveBeenCalled();
      expect(result.current.error).toBe(message);
      expect(result.current.result).toBeNull();
      expect(result.current.submitting).toBe(false);
    });
  });

  describe('no duplicate requests', () => {
    it('ignores a second submit while one is in flight — even one made before React re-rendered', async () => {
      const request = deferred<OrganizationOrderSummary>();
      mockedRedeem.mockReturnValue(request.promise);
      const { result } = setup();

      await act(async () => {
        void result.current.submit(CODE, null);
        void result.current.submit(CODE, null);
        void result.current.submit(QR, null);
      });

      expect(mockedRedeem).toHaveBeenCalledTimes(1);
      await act(async () => request.resolve(pickedUpOrgOrder));
    });

    it('accepts the next submit once the previous one has finished, even after a failure', async () => {
      mockedRedeem.mockRejectedValueOnce(new ApiError(404, 'not_found', 'No order awaiting pickup matches this code.'));
      const { result } = setup();
      await act(() => result.current.submit(CODE, null));

      await act(() => result.current.submit(CODE, null));

      expect(mockedRedeem).toHaveBeenCalledTimes(2);
      expect(result.current.result?.order).toEqual(pickedUpOrgOrder);
    });
  });

  describe('when the backend refuses or fails', () => {
    it.each([
      [new ApiError(400, 'invalid_argument', "That doesn't look like a Zesto pickup code."), "That doesn't look like a Zesto pickup code."],
      [new ApiError(404, 'not_found', 'No order awaiting pickup matches this code.'), 'No order awaiting pickup matches this code.'],
      [new ApiError(409, 'conflict', 'This order has already been picked up.'), 'This order has already been picked up.'],
      [new ApiError(409, 'conflict', 'This order is for a different outlet.'), 'This order is for a different outlet.'],
      [new ApiError(403, 'permission_denied', 'x'), "You don't have access to hand over orders."],
      [new ApiError(401, 'unauthenticated', 'x'), 'Your session has expired. Please sign in again.'],
      [new ApiError(503, 'unavailable', 'x'), 'Zesto is temporarily unavailable. Nothing was recorded. Please try again in a moment.'],
    ])('shows %j as an error and no result', async (failure, message) => {
      mockedRedeem.mockRejectedValue(failure);
      const { result } = setup();

      await act(() => result.current.submit(CODE, null));

      expect(result.current.error).toBe(message);
      expect(result.current.result).toBeNull();
      expect(result.current.submitting).toBe(false);
    });

    it.each([
      ['a network failure', new TypeError('Failed to fetch')],
      ['a 500', new ApiError(500, 'internal', 'boom')],
      ['an unexpected response', new ApiError(200, 'invalid_response', 'odd')],
    ])('says the outcome is unknown after %s, and shows no result', async (_label, failure) => {
      mockedRedeem.mockRejectedValue(failure);
      const { result } = setup();

      await act(() => result.current.submit(CODE, null));

      expect(result.current.error).toContain('may or may not have been recorded');
      expect(result.current.result).toBeNull();
    });
  });

  describe('stale results are never shown', () => {
    it('clears the previous success the moment a new attempt starts, so a failure cannot sit beside an old success', async () => {
      const { result } = setup();
      await act(() => result.current.submit(CODE, null));
      expect(result.current.result).not.toBeNull();
      const request = deferred<OrganizationOrderSummary>();
      mockedRedeem.mockReturnValue(request.promise);

      act(() => void result.current.submit(QR, null));

      expect(result.current.result).toBeNull();
      expect(result.current.error).toBeNull();
      await act(async () => request.reject(new ApiError(409, 'conflict', 'This order has already been picked up.')));
      expect(result.current.result).toBeNull();
      expect(result.current.error).toBe('This order has already been picked up.');
    });

    it('clears the previous error when the next attempt succeeds', async () => {
      mockedRedeem.mockRejectedValueOnce(new ApiError(404, 'not_found', 'No order awaiting pickup matches this code.'));
      const { result } = setup();
      await act(() => result.current.submit(CODE, null));
      expect(result.current.error).not.toBeNull();

      await act(() => result.current.submit(CODE, null));

      expect(result.current.error).toBeNull();
      expect(result.current.result).not.toBeNull();
    });

    it('clears the previous success when the next input is not even a code', async () => {
      const { result } = setup();
      await act(() => result.current.submit(CODE, null));

      await act(() => result.current.submit('nope', null));

      expect(result.current.result).toBeNull();
      expect(result.current.error).toBe(PICKUP_INPUT_MALFORMED);
    });
  });

  describe('the credential is never retained', () => {
    it.each([
      ['after a success', undefined],
      ['after a refusal', new ApiError(409, 'conflict', 'This order has already been picked up.')],
      ['after a network failure', new TypeError('Failed to fetch')],
    ])('leaves no trace of it in anything the hook exposes %s', async (_label, failure) => {
      if (failure) {
        mockedRedeem.mockRejectedValue(failure);
      }
      const { result } = setup();

      await act(() => result.current.submit(`  ${CODE}  `, 'outlet-1'));

      const exposed = JSON.stringify(result.current);
      expect(exposed).not.toContain('K7QX');
      expect(exposed).not.toContain('4M2P');
      expect(exposed).not.toContain('K7QX4M2P');
    });

    it('writes nothing to localStorage, sessionStorage, IndexedDB, cookies, history or the URL — success or failure', async () => {
      const { result } = setup();

      await act(() => result.current.submit(CODE, null));
      mockedRedeem.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await act(() => result.current.submit(QR, null));

      guard.expectNothingPersisted([CODE, 'K7QX4M2P', QR, 'AbCdEfGhIjKlMnOpQrStUv']);
    });
  });

  describe('dismissing', () => {
    it('clears the result and any error, ready for the next customer', async () => {
      const { result } = setup();
      await act(() => result.current.submit(CODE, null));

      act(() => result.current.dismiss());

      expect(result.current).toMatchObject({ result: null, error: null, submitting: false });
    });

    it('clears an error too', async () => {
      const { result } = setup();
      await act(() => result.current.submit('nope', null));

      act(() => result.current.dismiss());

      expect(result.current.error).toBeNull();
    });

    it('does nothing while an attempt is in flight: its answer would land on a cleared screen', async () => {
      const request = deferred<OrganizationOrderSummary>();
      mockedRedeem.mockReturnValue(request.promise);
      const { result } = setup();
      act(() => void result.current.submit(CODE, null));

      act(() => result.current.dismiss());

      expect(result.current.submitting).toBe(true);
      await act(async () => request.resolve(pickedUpOrgOrder));
      expect(result.current.result?.order).toEqual(pickedUpOrgOrder);
    });
  });

  it('copes with the component unmounting mid-request', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedRedeem.mockReturnValue(request.promise);
    const { result, unmount } = setup();
    act(() => void result.current.submit(CODE, null));

    unmount();

    await expect(act(async () => request.resolve(pickedUpOrgOrder))).resolves.not.toThrow();
  });
});

describe('usePickupRedeem — completing', () => {
  beforeEach(() => {
    mockedRedeem.mockReset();
    mockedRun.mockReset();
    mockedRedeem.mockResolvedValue(pickedUpOrgOrder);
    mockedRun.mockResolvedValue({ ...completedOrgOrder, id: pickedUpOrgOrder.id });
  });

  async function pickedUp() {
    const view = setup();
    await act(() => view.result.current.submit(CODE, null));
    return view;
  }

  it('asks the backend to complete exactly that order, for this organization', async () => {
    const { result } = await pickedUp();

    await act(() => result.current.complete(pickedUpOrgOrder.id));

    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun).toHaveBeenCalledWith('org-1', 'order-picked-up-7', 'complete');
  });

  it("replaces the order with the backend's completed row, with no completion action state left", async () => {
    const { result } = await pickedUp();

    await act(() => result.current.complete(pickedUpOrgOrder.id));

    expect(result.current.result).toEqual({
      order: { ...completedOrgOrder, id: pickedUpOrgOrder.id },
      completing: false,
      completionError: null,
    });
  });

  it('shows completing for the whole request, and ignores a second press', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValue(request.promise);
    const { result } = await pickedUp();

    await act(async () => {
      void result.current.complete(pickedUpOrgOrder.id);
      void result.current.complete(pickedUpOrgOrder.id);
    });

    expect(result.current.result?.completing).toBe(true);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve({ ...completedOrgOrder, id: pickedUpOrgOrder.id }));
    expect(result.current.result?.completing).toBe(false);
  });

  it.each([
    [new ApiError(409, 'conflict', 'This order has not been picked up yet.'), 'This order has not been picked up yet.'],
    [new ApiError(403, 'permission_denied', 'x'), "You don't have access to change this order."],
    [new ApiError(404, 'not_found', 'x'), "This order couldn't be found."],
    [new ApiError(503, 'unavailable', 'x'), 'Zesto is temporarily unavailable. Please try again in a moment.'],
    [new TypeError('Failed to fetch'), "Couldn't reach Zesto. Please check your connection and try again."],
  ])('on %j: keeps the picked-up order and shows why, ready to try again', async (failure, message) => {
    mockedRun.mockRejectedValueOnce(failure);
    const { result } = await pickedUp();

    await act(() => result.current.complete(pickedUpOrgOrder.id));

    expect(result.current.result?.order).toEqual(pickedUpOrgOrder);
    expect(result.current.result?.completing).toBe(false);
    expect(result.current.result?.completionError).toBe(message);
  });

  it('clears the failure when the next try succeeds', async () => {
    mockedRun.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = await pickedUp();
    await act(() => result.current.complete(pickedUpOrgOrder.id));
    expect(result.current.result?.completionError).not.toBeNull();

    await act(() => result.current.complete(pickedUpOrgOrder.id));

    expect(result.current.result?.completionError).toBeNull();
    expect(result.current.result?.order.status).toBe('completed');
  });

  it('does not show an answer that is not a completed order as a completion', async () => {
    mockedRun.mockResolvedValue({ ...pickedUpOrgOrder });
    const { result } = await pickedUp();

    await act(() => result.current.complete(pickedUpOrgOrder.id));

    expect(result.current.result?.order.status).toBe('picked_up');
    expect(result.current.result?.completionError).not.toBeNull();
  });

  it('applies the answer only to the order still on screen: a newer pickup is not overwritten by an older completion', async () => {
    const slow = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValue(slow.promise);
    const other = { ...pickedUpOrgOrder, id: 'order-other' };
    const { result } = await pickedUp();
    act(() => void result.current.complete(pickedUpOrgOrder.id));
    mockedRedeem.mockResolvedValue(other);

    await act(() => result.current.submit(QR, null));
    await act(async () => slow.resolve({ ...completedOrgOrder, id: pickedUpOrgOrder.id }));

    await waitFor(() => expect(result.current.result?.order.id).toBe('order-other'));
    expect(result.current.result?.order.status).toBe('picked_up');
  });

  it('does not let the screen be dismissed while completing', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValue(request.promise);
    const { result } = await pickedUp();
    act(() => void result.current.complete(pickedUpOrgOrder.id));

    act(() => result.current.dismiss());

    expect(result.current.result).not.toBeNull();
    await act(async () => request.resolve({ ...completedOrgOrder, id: pickedUpOrgOrder.id }));
  });
});

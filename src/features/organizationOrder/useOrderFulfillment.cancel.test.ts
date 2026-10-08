import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { cancelledPaidOrgOrder } from '../../test/organizationOrderFixtures';
import { cancelOrganizationOrder, runFulfillmentAction } from './api';
import type { OrganizationOrderSummary } from './types';
import { useOrderFulfillment } from './useOrderFulfillment';

vi.mock('./api');

const mockedCancel = vi.mocked(cancelOrganizationOrder);
const mockedRun = vi.mocked(runFulfillmentAction);
const cancelledRow = cancelledPaidOrgOrder(undefined, { id: 'order-confirmed-1' });

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
  const onOrderUpdated = vi.fn<(order: OrganizationOrderSummary) => void>();
  const onNeedsRefresh = vi.fn<() => number>(() => 2);
  const hook = renderHook(() =>
    useOrderFulfillment({ organizationId: 'org-1', onOrderUpdated, onNeedsRefresh, listLoadId: 1 }),
  );
  return { ...hook, onOrderUpdated, onNeedsRefresh };
}

describe('useOrderFulfillment — cancel', () => {
  beforeEach(() => {
    mockedCancel.mockReset();
    mockedRun.mockReset();
  });

  it("sends the organization, order and reason, and hands the backend's row on", async () => {
    mockedCancel.mockResolvedValue(cancelledRow);
    const { result, onOrderUpdated, onNeedsRefresh } = setup();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.cancel('order-confirmed-1', 'outlet_closed');
    });

    expect(mockedCancel).toHaveBeenCalledWith('org-1', 'order-confirmed-1', 'outlet_closed');
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(onOrderUpdated).toHaveBeenCalledWith(cancelledRow);
    expect(onNeedsRefresh).not.toHaveBeenCalled();
    expect(result.current.pendingOrderIds.size).toBe(0);
  });

  it('sends one request for two rapid calls, and reports the second as ignored', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedCancel.mockReturnValue(request.promise);
    const { result } = setup();

    let first!: Promise<unknown>;
    let second: unknown;
    await act(async () => {
      first = result.current.cancel('order-confirmed-1', 'other');
      second = await result.current.cancel('order-confirmed-1', 'other');
    });

    expect(second).toEqual({ kind: 'ignored' });
    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(result.current.pendingOrderIds.has('order-confirmed-1')).toBe(true);

    await act(async () => {
      request.resolve(cancelledRow);
      await first;
    });
    expect(result.current.pendingOrderIds.size).toBe(0);
  });

  it('will not cancel an order while a fulfilment action for it is in flight', async () => {
    const action = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValue(action.promise);
    const { result } = setup();

    let pendingAction!: Promise<void>;
    let outcome: unknown;
    await act(async () => {
      pendingAction = result.current.run('order-confirmed-1', 'start-preparing');
      outcome = await result.current.cancel('order-confirmed-1', 'other');
    });

    expect(outcome).toEqual({ kind: 'ignored' });
    expect(mockedCancel).not.toHaveBeenCalled();
    await act(async () => {
      action.reject(new ApiError(503, 'x', 'x'));
      await pendingAction;
    });
  });

  it.each([409, 404, 403])(
    'on a %s: re-reads the list, keeps the reason on the row and reports the order refused',
    async (status) => {
      mockedCancel.mockRejectedValue(new ApiError(status, 'x', 'x'));
      const { result, onOrderUpdated, onNeedsRefresh } = setup();

      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.cancel('order-confirmed-1', 'other');
      });

      expect(outcome).toEqual({ kind: 'refused' });
      expect(onNeedsRefresh).toHaveBeenCalledTimes(1);
      expect(onOrderUpdated).not.toHaveBeenCalled();
      expect(result.current.errors['order-confirmed-1']).toBeTruthy();
    },
  );

  it('on a 503: reports failed with a message for the dialog, does not re-read or repeat, and leaves no row error', async () => {
    mockedCancel.mockRejectedValue(new ApiError(503, 'unavailable', 'down'));
    const { result, onNeedsRefresh } = setup();

    let outcome: { kind: string; message?: string } | undefined;
    await act(async () => {
      outcome = await result.current.cancel('order-confirmed-1', 'other');
    });

    expect(outcome?.kind).toBe('failed');
    expect(outcome?.message).toContain('temporarily unavailable');
    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(onNeedsRefresh).not.toHaveBeenCalled();
    expect(result.current.errors).toEqual({});
  });

  it('on a lost answer: reports failed, and re-reads the list (a read, not a repeat) in case it went through', async () => {
    mockedCancel.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result, onNeedsRefresh } = setup();

    let outcome: { kind: string; message?: string } | undefined;
    await act(async () => {
      outcome = await result.current.cancel('order-confirmed-1', 'other');
    });

    expect(outcome?.kind).toBe('failed');
    expect(outcome?.message).toContain('may or may not have been cancelled');
    expect(onNeedsRefresh).toHaveBeenCalledTimes(1);
    expect(mockedCancel).toHaveBeenCalledTimes(1);
  });
});

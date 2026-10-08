import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { cancelledPaidOrgOrder } from '../../test/organizationOrderFixtures';
import { retryOrganizationRefund, runFulfillmentAction } from './api';
import type { OrganizationOrderSummary } from './types';
import { useOrderFulfillment } from './useOrderFulfillment';

vi.mock('./api');

const mockedRetry = vi.mocked(retryOrganizationRefund);
const mockedRun = vi.mocked(runFulfillmentAction);
const retriedRow = cancelledPaidOrgOrder({ state: 'in_progress', refundedInPaise: 0 }, { id: 'order-9' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup() {
  const onOrderUpdated = vi.fn<(order: OrganizationOrderSummary) => void>();
  const onNeedsRefresh = vi.fn<() => number>(() => 2);
  const hook = renderHook(() =>
    useOrderFulfillment({ organizationId: 'org-1', onOrderUpdated, onNeedsRefresh, listLoadId: 1 }),
  );
  return { ...hook, onOrderUpdated, onNeedsRefresh };
}

describe('useOrderFulfillment — retryRefund', () => {
  beforeEach(() => {
    mockedRetry.mockReset();
    mockedRun.mockReset();
  });

  it("sends the organization and order only, hands the backend's row on, and reports success", async () => {
    mockedRetry.mockResolvedValue(retriedRow);
    const { result, onOrderUpdated, onNeedsRefresh } = setup();

    let started: boolean | undefined;
    await act(async () => {
      started = await result.current.retryRefund('order-9');
    });

    expect(mockedRetry).toHaveBeenCalledWith('org-1', 'order-9');
    expect(started).toBe(true);
    expect(onOrderUpdated).toHaveBeenCalledWith(retriedRow);
    expect(onNeedsRefresh).not.toHaveBeenCalled();
    expect(result.current.pendingOrderIds.size).toBe(0);
    expect(result.current.errors).toEqual({});
  });

  it('sends one request for two rapid calls', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedRetry.mockReturnValue(request.promise);
    const { result } = setup();

    let first!: Promise<boolean>;
    let second: boolean | undefined;
    await act(async () => {
      first = result.current.retryRefund('order-9');
      second = await result.current.retryRefund('order-9');
    });

    expect(second).toBe(false);
    expect(mockedRetry).toHaveBeenCalledTimes(1);
    expect(result.current.pendingOrderIds.has('order-9')).toBe(true);
    await act(async () => {
      request.resolve(retriedRow);
      await first;
    });
    expect(result.current.pendingOrderIds.size).toBe(0);
  });

  it('will not retry while another request for the same order is in flight', async () => {
    const request = deferred<OrganizationOrderSummary>();
    mockedRun.mockReturnValue(request.promise);
    const { result } = setup();

    let pendingRun!: Promise<void>;
    let started: boolean | undefined;
    await act(async () => {
      pendingRun = result.current.run('order-9', 'mark-ready');
      started = await result.current.retryRefund('order-9');
    });

    expect(started).toBe(false);
    expect(mockedRetry).not.toHaveBeenCalled();
    await act(async () => {
      request.resolve(retriedRow);
      await pendingRun;
    });
  });

  it('on a 409: reports failure, re-reads the list, and keeps a message on the row beside the refreshed list', async () => {
    mockedRetry.mockRejectedValue(new ApiError(409, 'conflict', 'x'));
    const { result, onNeedsRefresh, onOrderUpdated } = setup();

    let started: boolean | undefined;
    await act(async () => {
      started = await result.current.retryRefund('order-9');
    });

    expect(started).toBe(false);
    expect(onNeedsRefresh).toHaveBeenCalledTimes(1);
    expect(onOrderUpdated).not.toHaveBeenCalled();
    expect(result.current.errors['order-9']).toMatch(/can't be retried right now/);
    expect(mockedRetry).toHaveBeenCalledTimes(1);
  });

  it('on a 503: reports failure with a message, does not re-read or repeat', async () => {
    mockedRetry.mockRejectedValue(new ApiError(503, 'unavailable', 'down'));
    const { result, onNeedsRefresh } = setup();

    await act(async () => {
      await result.current.retryRefund('order-9');
    });

    expect(result.current.errors['order-9']).toMatch(/refund was not retried/);
    expect(onNeedsRefresh).not.toHaveBeenCalled();
    expect(mockedRetry).toHaveBeenCalledTimes(1);
  });

  it('on a lost answer: re-reads the list (a read, never a repeat) in case a refund was started', async () => {
    mockedRetry.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result, onNeedsRefresh } = setup();

    await act(async () => {
      await result.current.retryRefund('order-9');
    });

    expect(onNeedsRefresh).toHaveBeenCalledTimes(1);
    expect(mockedRetry).toHaveBeenCalledTimes(1);
    expect(result.current.errors['order-9']).toContain('may or may not have been started');
  });
});

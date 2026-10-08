import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { cancelledPaidOrgOrder, confirmedOrgOrder } from '../../test/organizationOrderFixtures';
import { cancelOrganizationOrder, listOrganizationOrders, redeemPickup, runFulfillmentAction } from './api';
import { cancelOrganizationOrderErrorMessage, cancelOutcomeUnknown } from './errors';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: apiFetchMock,
}));

const cancelledRow = cancelledPaidOrgOrder({ state: 'in_progress', refundedInPaise: 0 }, { id: 'order-confirmed-1' });

describe('cancelOrganizationOrder', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ order: cancelledRow, cancellation: { state: 'cancelled', canCancel: false } });
  });

  it('POSTs the cancel route with exactly { reason } and nothing else', async () => {
    await cancelOrganizationOrder('org-1', 'order-confirmed-1', 'item_unavailable');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/organizations/org-1/orders/order-confirmed-1/cancel');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'item_unavailable' });
  });

  it('encodes the ids it puts in the path', async () => {
    apiFetchMock.mockResolvedValue({ order: { ...cancelledRow, id: 'a/b' } });

    await cancelOrganizationOrder('org 1', 'a/b', 'other');

    expect(apiFetchMock.mock.calls[0][0]).toBe('/organizations/org%201/orders/a%2Fb/cancel');
  });

  it('refuses to send a reason that is not one of the approved ones, without calling the backend', async () => {
    await expect(
      cancelOrganizationOrder('org-1', 'order-confirmed-1', 'because I said so' as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("resolves with the backend's cancelled row", async () => {
    await expect(cancelOrganizationOrder('org-1', 'order-confirmed-1', 'other')).resolves.toEqual(cancelledRow);
  });

  it.each([
    ['no order', {}],
    ['another order', { order: { ...cancelledRow, id: 'someone-elses' } }],
    ['an order that is not cancelled', { order: { ...cancelledRow, status: 'preparing' } }],
  ])('treats %s in the answer as an unexpected response, never as a cancellation', async (_name, body) => {
    apiFetchMock.mockResolvedValue(body);

    await expect(cancelOrganizationOrder('org-1', 'order-confirmed-1', 'other')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    });
  });

  it('passes a refusal on as the ApiError', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(409, 'conflict', 'x'));

    await expect(cancelOrganizationOrder('org-1', 'order-confirmed-1', 'other')).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('reading the cancellation and refund blocks of a row', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  async function readThroughList(row: unknown) {
    apiFetchMock.mockResolvedValue({ orders: [row], nextCursor: null });
    return (await listOrganizationOrders('org-1')).orders[0];
  }

  it('keeps a well-formed block and copies only the approved fields out of it', async () => {
    const row = await readThroughList({
      ...cancelledRow,
      refund: {
        state: 'attention_required',
        refundedInPaise: 0,
        providerRefundId: 'rfnd_secret',
        providerPaymentId: 'pay_secret',
      },
      cancellation: {
        cancelledBy: 'customer',
        cancelledAt: '2026-09-30T02:40:00.000Z',
        cancelledByUserId: 'U-internal',
        reason: 'changed_my_mind',
      },
    });

    expect(row.refund).toEqual({ state: 'attention_required', refundedInPaise: 0 });
    expect(row.cancellation).toEqual({ cancelledBy: 'customer', cancelledAt: '2026-09-30T02:40:00.000Z' });
    const serialized = JSON.stringify(row);
    for (const secret of ['rfnd_secret', 'pay_secret', 'U-internal', 'changed_my_mind']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    ['an unknown state', { state: 'weird', refundedInPaise: 0 }],
    ['a missing state', { refundedInPaise: 0 }],
    ['a fractional amount', { state: 'refunded', refundedInPaise: 10.5 }],
    ['a negative amount', { state: 'refunded', refundedInPaise: -1 }],
    ['a non-numeric amount', { state: 'refunded', refundedInPaise: '300' }],
    ['not an object', 'refunded'],
    ['null', null],
  ])('drops a refund block with %s, rather than guess', async (_name, refund) => {
    const row = await readThroughList({ ...cancelledRow, refund });

    expect(row).not.toHaveProperty('refund');
  });

  it.each([
    ['an unknown actor', { cancelledBy: 'robot', cancelledAt: '2026-09-30T02:40:00.000Z' }],
    ['an unreadable time', { cancelledBy: 'customer', cancelledAt: 'yesterday-ish' }],
    ['a missing time', { cancelledBy: 'customer' }],
    ['not an object', 7],
  ])('drops a cancellation block with %s', async (_name, cancellation) => {
    const row = await readThroughList({ ...cancelledRow, cancellation });

    expect(row).not.toHaveProperty('cancellation');
  });

  it('hands a row that has neither block on exactly as it came', async () => {
    const row = await readThroughList(confirmedOrgOrder);

    expect(row).toBe(confirmedOrgOrder);
  });

  it('reads the blocks on a fulfilment action answer and a pickup answer too', async () => {
    apiFetchMock.mockResolvedValueOnce({
      order: { ...confirmedOrgOrder, refund: { state: 'bogus', refundedInPaise: 1 } },
    });
    expect(await runFulfillmentAction('org-1', confirmedOrgOrder.id, 'start-preparing')).not.toHaveProperty('refund');

    apiFetchMock.mockResolvedValueOnce({
      order: { ...confirmedOrgOrder, status: 'picked_up', refund: { state: 'bogus', refundedInPaise: 1 } },
    });
    expect(await redeemPickup('org-1', { credential: 'X' })).not.toHaveProperty('refund');
  });
});

describe('cancelOrganizationOrderErrorMessage', () => {
  it.each([
    [400, 'Choose a reason'],
    [401, 'session has expired'],
    [403, "don't have permission to cancel orders"],
    [404, "couldn't be found"],
    [409, 'can no longer be cancelled'],
    [503, 'temporarily unavailable'],
  ])('says the right thing for a %s', (status, fragment) => {
    expect(cancelOrganizationOrderErrorMessage(new ApiError(status, 'x', 'raw backend words'))).toContain(fragment);
  });

  it('never repeats the backend wording or says it was cancelled', () => {
    const message = cancelOrganizationOrderErrorMessage(new ApiError(422, 'x', 'raw backend words'));

    expect(message).not.toContain('raw backend words');
    expect(message).toBe("Couldn't cancel this order. Please try again.");
  });

  it('says the outcome is unknown for a lost answer, without claiming either result', () => {
    const lost = [new TypeError('Failed to fetch'), new ApiError(502, 'x', 'bad gateway'), new ApiError(200, 'invalid_response', 'x')];
    for (const error of lost) {
      expect(cancelOutcomeUnknown(error)).toBe(true);
      expect(cancelOrganizationOrderErrorMessage(error)).toContain('may or may not have been cancelled');
    }
  });

  it('treats a 503 and definite refusals as known outcomes', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 503]) {
      expect(cancelOutcomeUnknown(new ApiError(status, 'x', 'x'))).toBe(false);
    }
  });
});

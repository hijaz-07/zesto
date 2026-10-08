import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { cancelledPaidOrgOrder } from '../../test/organizationOrderFixtures';
import { retryOrganizationRefund } from './api';
import { retryRefundErrorMessage } from './errors';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: apiFetchMock,
}));

const row = cancelledPaidOrgOrder({ state: 'in_progress', refundedInPaise: 0 }, { id: 'order-9' });

describe('retryOrganizationRefund', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ order: row, refund: { status: 'requested', amountInPaise: 30000 } });
  });

  it('POSTs the retry-refund route with no body, header or amount of any kind', async () => {
    await retryOrganizationRefund('org-1', 'order-9');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/organizations/org-1/orders/order-9/retry-refund');
    expect(init).toEqual({ method: 'POST' });
  });

  it('encodes the ids it puts in the path', async () => {
    apiFetchMock.mockResolvedValue({ order: { ...row, id: 'a/b' } });

    await retryOrganizationRefund('org 1', 'a/b');

    expect(apiFetchMock.mock.calls[0][0]).toBe('/organizations/org%201/orders/a%2Fb/retry-refund');
  });

  it("resolves with the backend's row", async () => {
    await expect(retryOrganizationRefund('org-1', 'order-9')).resolves.toEqual(row);
  });

  it.each([
    ['no order', {}],
    ['another order', { order: { ...row, id: 'someone-elses' } }],
    ['an order that is not cancelled', { order: { ...row, status: 'preparing' } }],
  ])('treats %s in the answer as an unexpected response, never as a retry', async (_name, body) => {
    apiFetchMock.mockResolvedValue(body);

    await expect(retryOrganizationRefund('org-1', 'order-9')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    });
  });

  it('passes a refusal on as the ApiError', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(409, 'conflict', 'x'));

    await expect(retryOrganizationRefund('org-1', 'order-9')).rejects.toMatchObject({ status: 409 });
  });
});

describe('retryRefundErrorMessage', () => {
  it.each([
    [401, /session has expired/],
    [403, /permission to retry refunds/],
    [404, /couldn't be found/],
    [409, /can't be retried right now/],
    [503, /refund was not retried/],
  ])('says the right thing for a %s', (status, expected) => {
    expect(retryRefundErrorMessage(new ApiError(status, 'x', 'backend wording'))).toMatch(expected);
  });

  it('never repeats the backend wording', () => {
    for (const status of [403, 404, 409, 503]) {
      expect(retryRefundErrorMessage(new ApiError(status, 'x', 'SECRET backend wording'))).not.toContain('SECRET');
    }
  });

  it('says the outcome is unknown for a lost answer, without claiming either result or inviting a blind repeat', () => {
    for (const error of [new TypeError('Failed to fetch'), new ApiError(500, 'internal', 'x'), new ApiError(200, 'invalid_response', 'x')]) {
      const message = retryRefundErrorMessage(error);
      expect(message).toContain('may or may not have been started');
      expect(message).not.toMatch(/try again/i);
    }
  });

  it('treats other 4xx as a plain, known failure', () => {
    expect(retryRefundErrorMessage(new ApiError(400, 'invalid_argument', 'x'))).toBe("Couldn't retry this refund. Please try again.");
  });
});

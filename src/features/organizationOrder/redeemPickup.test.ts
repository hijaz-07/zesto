import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { preparingOrgOrder } from '../../test/organizationOrderFixtures';
import { redeemPickup, runFulfillmentAction } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/client')>()),
  apiFetch: apiFetchMock,
}));

describe('redeemPickup', () => {
  const pickedUp = { ...preparingOrgOrder, id: 'order-9', status: 'picked_up' as const };

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ order: pickedUp });
  });

  it('POSTs the credential to the organization-scoped pickups path as JSON', async () => {
    await redeemPickup('org-1', { credential: 'K7QX-4M2P' });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/organizations/org-1/pickups');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body as string)).toEqual({ credential: 'K7QX-4M2P' });
  });

  it('sends the outlet too when one was chosen, and omits it otherwise', async () => {
    await redeemPickup('org-1', { credential: 'K7QX-4M2P', outletId: 'outlet-2' });
    await redeemPickup('org-1', { credential: 'K7QX-4M2P', outletId: undefined });

    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body as string)).toEqual({
      credential: 'K7QX-4M2P',
      outletId: 'outlet-2',
    });
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body as string)).toEqual({ credential: 'K7QX-4M2P' });
  });

  it('sends ONLY the credential and outlet: nothing else a caller object carries can ride along', async () => {
    await redeemPickup('org-1', {
      credential: 'K7QX-4M2P',
      outletId: 'outlet-2',
      // @ts-expect-error -- none of these are fields of RedeemPickupInput; the backend decides all of them.
      status: 'picked_up',
      orderId: 'order-9',
      userId: 'U-attacker',
      organizationId: 'org-attacker',
      paymentStatus: 'paid',
    });

    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(body).sort()).toEqual(['credential', 'outletId']);
  });

  it('puts the credential in the body only: never in the path or a query string', async () => {
    await redeemPickup('org-1', { credential: 'ZP1.order-9.AbCdEfGhIjKlMnOpQrStUv' });

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).not.toContain('ZP1');
    expect(path).not.toContain('?');
  });

  it('percent-encodes the organization id rather than splicing it into the path', async () => {
    await redeemPickup('a/b?c=d', { credential: 'K7QX-4M2P' });

    expect(apiFetchMock.mock.calls[0][0]).toBe('/organizations/a%2Fb%3Fc%3Dd/pickups');
  });

  it("resolves with the backend's row for the picked-up order", async () => {
    await expect(redeemPickup('org-1', { credential: 'K7QX-4M2P' })).resolves.toBe(pickedUp);
  });

  it.each([
    ['no body', undefined],
    ['no order', {}],
    ['an order without an id', { order: { ...pickedUp, id: undefined } }],
    ['an order that is not picked up (a stale or confused answer)', { order: { ...pickedUp, status: 'ready' } }],
    ['a completed order (not what a pickup produces)', { order: { ...pickedUp, status: 'completed' } }],
  ])('treats %s as an unexpected response, never as a successful pickup', async (_label, body) => {
    apiFetchMock.mockResolvedValue(body);

    await expect(redeemPickup('org-1', { credential: 'K7QX-4M2P' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('propagates the backend refusal as-is', async () => {
    const refusal = new ApiError(409, 'conflict', 'This order has already been picked up.');
    apiFetchMock.mockRejectedValue(refusal);

    await expect(redeemPickup('org-1', { credential: 'K7QX-4M2P' })).rejects.toBe(refusal);
  });
});

describe('runFulfillmentAction — complete', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('POSTs .../orders/{orderId}/complete with no body, and resolves with the row', async () => {
    const completed = { ...preparingOrgOrder, id: 'order-9', status: 'completed' as const };
    apiFetchMock.mockResolvedValue({ order: completed });

    const row = await runFulfillmentAction('org-1', 'order-9', 'complete');

    expect(apiFetchMock).toHaveBeenCalledWith('/organizations/org-1/orders/order-9/complete', { method: 'POST' });
    expect(row).toBe(completed);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api/client';
import { createOutlet, getOutlets, updateOutlet } from './api';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/client', () => ({
  apiFetch: apiFetchMock,
}));

describe('outlet api', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('getOutlets requests the organization\'s outlets with no body', async () => {
    apiFetchMock.mockResolvedValue({ outlets: [] });

    await getOutlets('org-1');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets');
  });

  it('createOutlet POSTs the exact input as a JSON body', async () => {
    apiFetchMock.mockResolvedValue({ outlet: {} });
    const input = {
      name: 'Main Canteen',
      slug: 'main-canteen',
      description: 'Main campus food outlet',
      phone: '0499xxxxxxx',
      address: { city: 'Kasaragod', state: 'Kerala' },
      location: { latitude: 12.5, longitude: 74.9 },
    };

    await createOutlet('org-1', input);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  });

  it('createOutlet sends only the fields provided, no extra keys', async () => {
    apiFetchMock.mockResolvedValue({ outlet: {} });

    await createOutlet('org-1', { name: 'Main Canteen', slug: 'main-canteen' });

    const [, init] = apiFetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'Main Canteen',
      slug: 'main-canteen',
    });
  });

  it('updateOutlet PATCHes the target outlet with the exact input as a JSON body', async () => {
    apiFetchMock.mockResolvedValue({ outlet: {} });
    const input = { status: 'inactive' as const };

    await updateOutlet('org-1', 'outlet-1', input);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/organizations/org-1/outlets/outlet-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  });

  it('resolves with the response returned by apiFetch', async () => {
    const outlet = { id: 'outlet-1', organizationId: 'org-1', name: 'Main Canteen', slug: 'main-canteen' };
    apiFetchMock.mockResolvedValue({ outlet });

    const result = await createOutlet('org-1', { name: 'Main Canteen', slug: 'main-canteen' });

    expect(result).toEqual({ outlet });
  });

  it('propagates a rejection from apiFetch as-is', async () => {
    const error = new Error('boom');
    apiFetchMock.mockRejectedValue(error);

    await expect(getOutlets('org-1')).rejects.toBe(error);
  });
});

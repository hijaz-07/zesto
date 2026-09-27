import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';

const descopeMocks = vi.hoisted(() => ({
  getSessionToken: vi.fn<() => string>(),
  isSessionTokenExpired: vi.fn<(token?: string) => boolean>(),
  refresh: vi.fn<() => Promise<{ ok: boolean }>>(),
}));

vi.mock('@descope/react-sdk', () => ({
  getSessionToken: descopeMocks.getSessionToken,
  isSessionTokenExpired: descopeMocks.isSessionTokenExpired,
  refresh: descopeMocks.refresh,
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch', () => {
  beforeEach(() => {
    descopeMocks.getSessionToken.mockReturnValue('session-jwt-1');
    descopeMocks.isSessionTokenExpired.mockReturnValue(false);
    descopeMocks.refresh.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends the session token as Authorization: Bearer <token>', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { data: { id: 'U-1' } }));

    await apiFetch('/me');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/me');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer session-jwt-1');
  });

  it('never puts the token in the URL', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { data: {} }));

    await apiFetch('/me');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).not.toContain('session-jwt-1');
  });

  it('resolves with the success envelope\'s data', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { data: { id: 'U-1', createdAt: '2026-01-01T00:00:00.000Z' } }));

    const result = await apiFetch('/me');

    expect(result).toEqual({ id: 'U-1', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('refreshes once before sending when the SDK reports the token as expired', async () => {
    descopeMocks.isSessionTokenExpired.mockReturnValue(true);
    descopeMocks.getSessionToken
      .mockReturnValueOnce('expired-jwt')
      .mockReturnValue('refreshed-jwt');
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { data: {} }));

    await apiFetch('/me');

    expect(descopeMocks.refresh).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer refreshed-jwt');
  });

  it('refreshes once and retries once on a 401, using the refreshed token', async () => {
    descopeMocks.getSessionToken
      .mockReturnValueOnce('stale-jwt')
      .mockReturnValue('refreshed-jwt');
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'unauthenticated', message: 'Expired.', requestId: 'r1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'U-1' } }));

    const result = await apiFetch('/me');

    expect(result).toEqual({ id: 'U-1' });
    expect(descopeMocks.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = vi.mocked(fetch).mock.calls[1];
    const headers = new Headers((secondInit as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer refreshed-jwt');
  });

  it('does not retry again, and does not sign out, when the retry also 401s', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(401, { error: { code: 'unauthenticated', message: 'Still invalid.', requestId: 'r2' } }),
    );

    const error = await apiFetch('/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2); // one retry, not a loop
    expect(descopeMocks.refresh).toHaveBeenCalledTimes(1); // one refresh, not repeated
  });

  it('does not retry when the refresh itself fails', async () => {
    descopeMocks.refresh.mockResolvedValue({ ok: false });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(401, { error: { code: 'unauthenticated', message: 'Invalid.', requestId: 'r3' } }),
    );

    await expect(apiFetch('/me')).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('converts a non-2xx error envelope into a typed ApiError', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(404, { error: { code: 'not_found', message: 'Not found.', requestId: 'r4' } }),
    );

    const error = (await apiFetch('/me').catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('Not found.');
    expect(error.requestId).toBe('r4');
  });

  it('converts a non-JSON response into a typed ApiError instead of throwing a raw parse error', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>Internal error</html>', { status: 500 }));

    const error = (await apiFetch('/me').catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe('invalid_response');
  });
});

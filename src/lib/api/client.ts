import { getSessionToken, isSessionTokenExpired, refresh } from '@descope/react-sdk';

const API_BASE = '/api';

interface SuccessEnvelope {
  data: unknown;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/** A failed API call, carrying the server's error code/message/requestId when available. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function isSuccessEnvelope(body: unknown): body is SuccessEnvelope {
  return typeof body === 'object' && body !== null && 'data' in body;
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object'
  );
}

/**
 * Refreshes the Descope session once and returns the resulting session
 * token, or null if the refresh itself failed. The Descope SDK persists the
 * refreshed token itself; this never stores it.
 */
async function refreshSessionToken(): Promise<string | null> {
  const result = await refresh();
  return result.ok ? getSessionToken() || null : null;
}

/** The token to send for this request, refreshing first if the SDK reports it as already expired. */
async function currentSessionToken(): Promise<string | null> {
  const token = getSessionToken();
  if (token && isSessionTokenExpired(token)) {
    return refreshSessionToken();
  }
  return token || null;
}

function withAuthorization(init: RequestInit, token: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...init, headers };
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      response.status,
      'invalid_response',
      'The server returned a response that could not be read.',
    );
  }
}

async function toResult<T>(response: Response): Promise<T> {
  const body = await parseJsonBody(response);

  if (response.ok) {
    if (isSuccessEnvelope(body)) {
      return body.data as T;
    }
    throw new ApiError(
      response.status,
      'invalid_response',
      'The server returned a response in an unexpected shape.',
    );
  }

  if (isErrorEnvelope(body)) {
    throw new ApiError(response.status, body.error.code, body.error.message, body.error.requestId);
  }
  throw new ApiError(response.status, 'unknown_error', 'The request failed.');
}

/**
 * Calls Zesto's HTTP API (`/api/*`), authenticated with the caller's Descope
 * session token. On a 401, refreshes the session once and retries the
 * request once; if that retry also fails, the resulting `ApiError` is
 * thrown as-is — this never signs the user out itself.
 *
 * `path` is relative to `/api`, e.g. `apiFetch('/me')`.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await currentSessionToken();
  let response = await fetch(`${API_BASE}${path}`, withAuthorization(init, token));

  if (response.status === 401) {
    const refreshedToken = await refreshSessionToken();
    if (refreshedToken) {
      response = await fetch(`${API_BASE}${path}`, withAuthorization(init, refreshedToken));
    }
  }

  return toResult<T>(response);
}

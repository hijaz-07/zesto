import type { User } from '../../domain/types';
import { apiFetch } from '../../lib/api/client';

/** Fetches the signed-in caller's profile, creating it server-side on first call. */
export function getMe(): Promise<User> {
  return apiFetch<User>('/me');
}

/**
 * Public-site business details.
 *
 * Nothing here is invented: every value comes from a build-time env var that
 * must be set once the real detail is confirmed. Until then the public pages
 * render a clearly marked placeholder (see `ConfigValue`).
 */
function readEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export const POLICY_LAST_UPDATED = '30 September 2026';

export function getSupportEmail(): string | null {
  return readEnv(import.meta.env.VITE_PUBLIC_SUPPORT_EMAIL);
}

export function getOperatorName(): string | null {
  return readEnv(import.meta.env.VITE_PUBLIC_OPERATOR_NAME);
}

export const PUBLIC_LINKS = {
  explore: '/explore',
  signIn: '/login',
  privacy: '/privacy',
  terms: '/terms',
  refundCancellation: '/refund-cancellation',
  contact: '/contact',
} as const;

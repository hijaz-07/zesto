/**
 * The Descope flow configured in the Descope console (SMS OTP sign-up / sign-in,
 * plus the new-user information step). The flow's screens and logic live in
 * Descope — the app only embeds it by ID.
 */
export const SIGN_UP_OR_IN_FLOW_ID = 'sign-up-or-in';

/**
 * Reads the Descope Project ID from Vite env configuration. The Project ID is a
 * public identifier, not a secret — backend Descope credentials (e.g. management
 * keys) must never be placed in `VITE_*` variables.
 */
export function getDescopeProjectId(
  env: Pick<ImportMetaEnv, 'VITE_DESCOPE_PROJECT_ID'> = import.meta.env,
): string {
  const projectId = env.VITE_DESCOPE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error(
      'VITE_DESCOPE_PROJECT_ID is not set. Add your Descope Project ID to .env.local (see .env.example).',
    );
  }
  return projectId;
}

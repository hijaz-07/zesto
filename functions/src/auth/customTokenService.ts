import type { Auth } from "firebase-admin/auth";

/**
 * Server-side boundary for Firebase custom-token issuance. This wraps the
 * Admin SDK behind a small interface (rather than calling `createCustomToken`
 * inline) so it can be unit tested with a mock `Auth`, independent of any
 * deployed function or the emulator.
 *
 * Nothing in this module is exported as a Cloud Function — there is no
 * callable endpoint here yet. The future OTPLESS-verifying callable (see
 * `otpless.ts`) is expected to call `issueCustomToken` only after it has
 * independently verified the caller's identity server-side.
 */
export interface CustomTokenService {
  issueCustomToken(uid: string): Promise<string>;
}

export function createCustomTokenService(auth: Auth): CustomTokenService {
  return {
    async issueCustomToken(uid: string): Promise<string> {
      return auth.createCustomToken(uid);
    },
  };
}

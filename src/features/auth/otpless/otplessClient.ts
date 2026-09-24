import type { CustomTokenExchangeResult, OtplessClient, OtplessVerificationResult } from './types';

/**
 * NOT IMPLEMENTED. Placeholder for the future OTPLESS Web SDK integration.
 *
 * Do not call this yet, and do not treat its method signatures as verified
 * against OTPLESS's real SDK/API — that documentation has not been reviewed.
 * It exists so `RequireAuth`/sign-in UI has a stable import path to build
 * against once OTPLESS is actually wired in.
 */
export const otplessClient: OtplessClient = {
  async verify(): Promise<OtplessVerificationResult> {
    throw new Error('OTPLESS verification is not implemented yet.');
  },

  async exchangeForCustomToken(): Promise<CustomTokenExchangeResult> {
    throw new Error('OTPLESS custom-token exchange is not implemented yet.');
  },
};

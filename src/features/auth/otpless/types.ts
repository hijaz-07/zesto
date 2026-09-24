/**
 * Future contract for OTPLESS sign-in, intentionally speculative:
 *
 *   OTPLESS verification (client) → trusted backend validation
 *   → Firebase custom token (Admin SDK) → client signInWithCustomToken()
 *
 * Nothing here reflects OTPLESS's real SDK/API — it has not been verified
 * against OTPLESS's documentation yet. These shapes exist only to give the
 * rest of the app a stable boundary to import from until that integration
 * work happens.
 */

/** Whatever proof of verification the real OTPLESS Web SDK will hand back. Shape TBD. */
export interface OtplessVerificationResult {
  verificationToken: string;
}

/** What the client gets back once the trusted backend accepts an OTPLESS verification. */
export interface CustomTokenExchangeResult {
  firebaseCustomToken: string;
}

export interface OtplessClient {
  /** Runs the OTPLESS verification flow in the browser. Not implemented yet. */
  verify(): Promise<OtplessVerificationResult>;

  /**
   * Sends an OTPLESS verification result to the trusted backend boundary
   * (see `functions/src/auth/`) for validation and custom-token issuance.
   * Not implemented yet.
   */
  exchangeForCustomToken(result: OtplessVerificationResult): Promise<CustomTokenExchangeResult>;
}

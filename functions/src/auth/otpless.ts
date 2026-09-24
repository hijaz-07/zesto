/**
 * NOT IMPLEMENTED. Placeholder for future server-side OTPLESS verification.
 *
 * Nothing here reflects OTPLESS's real server API/SDK — that has not been
 * reviewed yet, and this module intentionally makes no assumptions about it.
 * It exists only to mark where that work will live and what it is expected
 * to do once it exists:
 *
 *   1. Accept the OTPLESS verification result the client obtained (see
 *      `src/features/auth/otpless/types.ts` on the frontend).
 *   2. Call OTPLESS's server-side verification API, using a trusted secret
 *      that never reaches the client, to confirm the result is genuine and
 *      has not already been consumed.
 *   3. Resolve to a stable identity for the verified user (e.g. a phone
 *      number), for the caller to look up or create a Firebase user and
 *      then mint a custom token via `customTokenService`.
 *
 * This file exports no Cloud Function — there is no deployable
 * authentication endpoint until OTPLESS is actually integrated.
 */

export interface OtplessVerificationRequest {
  verificationToken: string;
}

export interface VerifiedOtplessIdentity {
  /** A stable identifier for the verified user (e.g. phone number). Exact shape TBD. */
  subject: string;
}

export async function verifyOtplessToken(
  request: OtplessVerificationRequest,
): Promise<VerifiedOtplessIdentity> {
  void request;
  throw new Error("OTPLESS server-side verification is not implemented yet.");
}

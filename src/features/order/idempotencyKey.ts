/**
 * Generates an opaque idempotency key for one order-submission attempt (see
 * `useCreateOrder`). The backend treats this as an opaque token — any
 * sufficiently-unique string works — so a standard random UUID is enough;
 * no server coordination is needed to generate one.
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {
  isValidDocumentId,
  type OrganizationMemberRole,
  type OrganizationMembership,
} from "../auth/membership";
import {isFirestoreAborted} from "./orderFulfillment";
import {getOwnedOrder, resolveOrderById, type Order} from "./orders";
import {
  PICKUP_CREDENTIAL_MAX_LENGTH,
  derivePickupCredentials,
  parsePickupCredential,
  pickupCredentialMatches,
  type PickupCredentials,
} from "./pickupCredential";

/**
 * PICKUP — handing a ready order to the customer:
 *
 * ```
 * ready --redeemPickup(credential)--> picked_up
 * ```
 *
 * (`picked_up` -> `completed` is a plain fulfillment step, see
 * `domain/orderFulfillment.ts`.)
 *
 * `redeemPickup` is the ONLY code that writes `picked_up`, and it verifies the
 * credential and moves the state in ONE Firestore transaction. There is no
 * separate "verify" step that issues a token and a "commit" step that trusts
 * it, so nothing can happen between a check and the write it justifies.
 *
 * The credential (`domain/pickupCredential.ts`) is never trusted on its own
 * authority. It is one of the checks; the others are authentication, an
 * active membership with an allowed role, the order belonging to the caller's
 * organization, the order being `ready`, and it being paid. None of the facts
 * those checks are about comes from the request: the actor is the caller's
 * verified membership, the organization is that membership's, and the order's
 * state and payment are read inside the transaction.
 *
 * The customer's side — `getPickupCredentialForCustomer` — is here too, since
 * it is the other half of the same mechanism.
 */

/**
 * Roles that may hand orders over. Every active member, staff included —
 * the counter is operated by staff — and, like `ORDER_FULFILLMENT_ROLES`,
 * deliberately its own export: it happens to be the same three roles, but
 * "may hand food over" and "may start cooking it" are different decisions.
 */
export const ORDER_PICKUP_ROLES: readonly OrganizationMemberRole[] =
  ["owner", "manager", "staff"];

/**
 * How many of an organization's orders awaiting pickup a typed code is checked
 * against. A real counter has a handful; if there are ever more than this the
 * lookup refuses rather than miss one (see `locateOrderIdByCode`).
 */
export const PICKUP_CODE_LOOKUP_LIMIT = 500;

/**
 * What every "this credential does not open any order of yours" outcome says —
 * an order that does not exist, one in another organization, a wrong proof, a
 * typed code that matches nothing. One message and one status for all of them,
 * so none can be told from another.
 */
const NO_MATCH_MESSAGE = "No order awaiting pickup matches this code.";

/**
 * Validates a `POST .../pickups` request body — shape and bounds only; the
 * credential's FORMAT and the outlet's validity are checked by `redeemPickup`.
 * Nothing but `credential` and an optional `outletId` is a field here, so
 * `safeParse` strips anything else (a `status`, `userId`, `organizationId`,
 * `orderId`, ...): it is never read.
 *
 * `outletId` can only NARROW what the caller may do — the outlet this counter
 * serves — never widen it: membership is organization-wide, and the order's
 * organization is checked regardless.
 */
export const redeemPickupBodySchema = z.object({
  credential: z
    .string({error: "credential must be a string."})
    .trim()
    .min(1, "A pickup code is required.")
    .max(PICKUP_CREDENTIAL_MAX_LENGTH, "That pickup code is too long."),
  outletId: z
    .string({error: "outletId must be a string."})
    .optional(),
});

export type RedeemPickupBody = z.infer<typeof redeemPickupBodySchema>;

/**
 * Decides, from an order's CURRENT stored state alone, whether it may be
 * handed over. Pure and exported so the whole matrix is unit-testable without
 * Firestore; `redeemPickup` calls it inside its transaction on the freshly-read
 * order.
 *
 * Unlike a fulfillment step, there is NO "already done, so succeed quietly"
 * case: an order already picked up is a conflict, not a success. A second
 * person presenting a credential for an order that has already left is exactly
 * the situation staff need to be told about, and a success response would read
 * as "hand it over".
 *
 * @param {Order} order The order as currently stored.
 * @throws {HttpsError} `aborted` (409) unless the order is `ready` and paid,
 *   with a message that says which it is.
 */
export function assertOrderCanBePickedUp(order: Order): void {
  switch (order.status) {
  case "ready":
    if (order.paymentStatus !== "paid") {
      // Unreachable unless the stored data broke its own payment invariant.
      logger.warn("Order is ready without being paid; refusing to hand it over.", {orderId: order.id});
      throw new HttpsError("aborted", "This order has not been paid yet.");
    }
    return;
  case "picked_up":
    throw new HttpsError("aborted", "This order has already been picked up.");
  case "completed":
    throw new HttpsError("aborted", "This order has already been picked up and completed.");
  case "confirmed":
  case "preparing":
    throw new HttpsError("aborted", "This order is not ready for pickup yet.");
  case "pending_payment":
    throw new HttpsError("aborted", "This order has not been paid yet.");
  case "cancelled":
    throw new HttpsError("aborted", "This order was cancelled.");
  }
}

/** The result of `redeemPickup`. */
export interface RedeemPickupResult {
  /** The order as it stands after the pickup. */
  order: Order;
  /** How the credential was presented: scanned/typed QR payload, or typed backup code. */
  via: "qr" | "code";
}

export interface RedeemPickupInput {
  /**
   * The caller's membership, as returned by `requireOrganizationRole` — the
   * only way to obtain one. Its `organizationId` is the scope the order must
   * belong to and its `userId` is recorded as the actor; neither is ever a
   * request value.
   */
  membership: OrganizationMembership;
  /** The credential as the client sent it (a QR payload or a backup code); parsed here. */
  credential: unknown;
  /** The outlet this counter serves, if the client said — only ever a narrowing check. */
  outletId?: unknown;
  /**
   * Supplies the HMAC key (see `getPickupCredentialSecret`). A function, called
   * once and only after the membership, outlet ID and credential FORMAT have
   * been checked, so a malformed request is a 400 (and a refused caller a 403)
   * whether or not the server's secret is configured.
   */
  getSecret: () => string;
}

/**
 * Hands a ready order over, on behalf of an authorized member: verifies the
 * credential and moves `ready` -> `picked_up` — the single authoritative
 * implementation (see the module doc comment).
 *
 * A QR payload names its order, so the order is resolved from it directly. A
 * typed backup code does not, so `locateOrderIdByCode` first finds the one
 * candidate among the organization's orders awaiting pickup. That search is
 * only a LOCATOR and is not trusted: the transaction below re-reads the single
 * order it found and re-derives and compares the credential against it, exactly
 * as for a QR, so a search result can never open an order the credential does
 * not.
 *
 * Inside ONE Firestore transaction, in this order, each failing step stopping
 * the call:
 * 1. the order exists and belongs to the caller's organization;
 * 2. the credential is genuine for it — the same `404` for 1 and 2, so a
 *    caller learns nothing about orders they cannot open;
 * 3. if an outlet was named, the order is that outlet's (`409`);
 * 4. the order is `ready` and paid (`assertOrderCanBePickedUp`, `409`);
 * then `picked_up`, `pickedUpAt`/`pickedUpBy` and `updatedAt` are written
 * together. If another request commits against the same order first, the
 * transaction re-runs against the new state — so of two staff presenting the
 * same credential at once exactly one write happens and the other is refused
 * with "already picked up". A transaction that still cannot commit after
 * Firestore's own retries is reported as a conflict (409), not an internal
 * error.
 *
 * The role is re-asserted here from the membership itself, as defense in depth
 * beneath the route's `requireOrganizationRole`.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RedeemPickupInput} input The authorized caller and what they presented.
 * @return {Promise<RedeemPickupResult>} The order after the pickup.
 * @throws {HttpsError} `permission-denied` (403) if the membership is not an
 *   active one with a pickup role; `invalid-argument` (400) for a malformed
 *   credential or outlet ID; `not-found` (404) if the credential opens no order
 *   of the caller's organization; `aborted` (409) if the order is for a
 *   different outlet, is not ready and paid, was already picked up, or the
 *   write lost a race it could not retry past.
 * @throws {Error} If the secret is missing or too short, or the stored order
 *   is malformed — server problems, never reported as a bad credential.
 */
export async function redeemPickup(
  db: Firestore,
  input: RedeemPickupInput,
): Promise<RedeemPickupResult> {
  const {membership} = input;

  if (membership.status !== "active" || !ORDER_PICKUP_ROLES.includes(membership.role)) {
    throw new HttpsError("permission-denied", "You do not have access to this organization.");
  }
  if (input.outletId !== undefined && !isValidDocumentId(input.outletId)) {
    throw new HttpsError("invalid-argument", "Invalid outlet ID.");
  }
  const outletId = input.outletId;
  const credential = parsePickupCredential(input.credential);
  const secret = input.getSecret();

  const orderId = credential.kind === "qr" ?
    credential.orderId :
    await locateOrderIdByCode(db, membership.organizationId, credential.code, secret);

  try {
    return await db.runTransaction(async (tx): Promise<RedeemPickupResult> => {
      const {order, orderRef} = await resolveOrderForPickup(db, tx, orderId);

      // Another organization's order must look exactly like a missing one.
      if (order.organizationId !== membership.organizationId) {
        throw new HttpsError("not-found", NO_MATCH_MESSAGE);
      }
      if (!pickupCredentialMatches(secret, order.id, credential)) {
        throw new HttpsError("not-found", NO_MATCH_MESSAGE);
      }

      // Only reachable with a genuine credential, so naming the outlet leaks
      // nothing to anyone who does not already hold the order's credential.
      if (outletId !== undefined && order.outletId !== outletId) {
        throw new HttpsError("aborted", "This order is for a different outlet.");
      }
      assertOrderCanBePickedUp(order);

      const now = Timestamp.now();
      const updates: Partial<Order> = {
        status: "picked_up",
        updatedAt: now,
        pickedUpAt: now,
        pickedUpBy: membership.userId,
      };
      tx.update(orderRef, updates);

      return {order: {...order, ...updates}, via: credential.kind};
    });
  } catch (error) {
    if (!(error instanceof HttpsError) && isFirestoreAborted(error)) {
      throw new HttpsError(
        "aborted",
        "This order was just changed by someone else. Refresh and try again.",
      );
    }
    throw error;
  }
}

/**
 * `resolveOrderById`, with its "no such order" refusal rewritten to the
 * uniform pickup no-match, so a missing order reads exactly like every other
 * reason a credential opens nothing.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {Transaction} tx The in-progress transaction to read within.
 * @param {string} orderId The order's document ID (already known to be well formed).
 * @return {Promise<{order: Order; orderRef: DocumentReference}>} The order and its reference.
 * @throws {HttpsError} `not-found` (404) with the uniform no-match message.
 */
async function resolveOrderForPickup(
  db: Firestore,
  tx: Transaction,
  orderId: string,
): Promise<{order: Order; orderRef: DocumentReference}> {
  try {
    return await resolveOrderById(db, tx, orderId);
  } catch (error) {
    if (error instanceof HttpsError && error.code === "not-found") {
      throw new HttpsError("not-found", NO_MATCH_MESSAGE);
    }
    throw error;
  }
}

/**
 * Finds the order a typed backup code belongs to, among the caller's own
 * organization's orders awaiting pickup (`ready`) or just handed over
 * (`picked_up`, so a second attempt is told "already picked up" rather than
 * "no match"). A LOCATOR only: `redeemPickup` re-verifies the answer inside its
 * transaction. It runs outside the transaction on purpose, so one counter's
 * lookup does not lock every awaiting order against the others.
 *
 * The query is scoped by the organization of the caller's verified membership,
 * and every returned document's path is checked against it once more. It needs
 * the composite collection-group index in `firestore.indexes.json` (`orders`:
 * `organizationId` ASC, `status` ASC, `createdAt` DESC); the emulator does not
 * enforce it, so it is only proven against real Firestore.
 *
 * A code that matches none or more than one order (two 40-bit codes colliding
 * among a few hundred orders is not realistic, but it must not be guessed
 * about) opens nothing: both are the same "no match".
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization of the caller's verified membership.
 * @param {string} code The normalized backup code (see `parsePickupCredential`).
 * @param {string} secret The HMAC key.
 * @return {Promise<string>} The one matching order's ID.
 * @throws {HttpsError} `not-found` (404) unless exactly one order matches.
 * @throws {Error} If more than `PICKUP_CODE_LOOKUP_LIMIT` orders are awaiting
 *   pickup — refused rather than searched partially.
 */
async function locateOrderIdByCode(
  db: Firestore,
  organizationId: string,
  code: string,
  secret: string,
): Promise<string> {
  const snapshot = await db
    .collectionGroup("orders")
    .where("organizationId", "==", organizationId)
    .where("status", "in", ["ready", "picked_up"])
    .orderBy("createdAt", "desc")
    .limit(PICKUP_CODE_LOOKUP_LIMIT + 1)
    .get();

  if (snapshot.size > PICKUP_CODE_LOOKUP_LIMIT) {
    logger.error("Too many orders awaiting pickup to look one up by code.", {organizationId});
    throw new Error("Too many orders are awaiting pickup to look one up by code.");
  }

  const matches = snapshot.docs.filter((doc) =>
    doc.ref.path.startsWith(`organizations/${organizationId}/`) &&
    pickupCredentialMatches(secret, doc.id, {kind: "code", code}));
  if (matches.length > 1) {
    logger.error("A pickup code matched more than one order; refusing to choose.", {
      organizationId, matches: matches.length,
    });
  }
  if (matches.length !== 1) {
    throw new HttpsError("not-found", NO_MATCH_MESSAGE);
  }
  return matches[0].id;
}

/**
 * The credential a customer shows at the counter, for THEIR OWN ready order.
 *
 * Authorization is the order's customer, nothing else: `getOwnedOrder` reads
 * the authoritative order and compares its stored `userId` with the verified
 * session's user. A caller who merely knows an order ID gets `404`,
 * indistinguishable from an order that does not exist — and that includes the
 * organization's own owner, managers and staff, who never need the credential
 * (they are shown it by the customer) and so get no access to it here.
 *
 * The credential is only available while the order can actually be collected
 * (`ready` and paid). Before that there is nothing to show, and afterwards it
 * is dead, so the customer's screen stops offering it.
 *
 * `userId` MUST be the verified Descope session's own user id — never a
 * client-supplied value.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @param {unknown} orderId The order's document ID, from the request path.
 * @param {() => string} getSecret Supplies the HMAC key. A function, called
 *   only once ownership and state have passed, so a server that is missing its
 *   secret answers a caller who may not have the credential exactly as any
 *   other server would (400/404/409), never with a 500.
 * @return {Promise<PickupCredentials>} The QR payload and backup code — and
 *   nothing else.
 * @throws {HttpsError} `invalid-argument` (400) for a malformed order ID;
 *   `not-found` (404) if the order does not exist or is not the caller's;
 *   `aborted` (409) if it is not `ready` and paid.
 * @throws {Error} If the secret is missing or too short.
 */
export async function getPickupCredentialForCustomer(
  db: Firestore,
  userId: string,
  orderId: unknown,
  getSecret: () => string,
): Promise<PickupCredentials> {
  const order = await getOwnedOrder(db, userId, orderId);
  if (order.status !== "ready" || order.paymentStatus !== "paid") {
    throw new HttpsError("aborted", "This order isn't ready for pickup.");
  }
  return derivePickupCredentials(getSecret(), order.id);
}

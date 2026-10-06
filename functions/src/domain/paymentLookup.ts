import type {Firestore} from "firebase-admin/firestore";
import {parsePayment, type Payment} from "./payments";

/**
 * Finds a Zesto payment by one of the PROVIDER's identifiers with a
 * collection-group query over `payments` (see firestore.indexes.json). The
 * identifier is the provider's own (`providerOrderId`, `providerPaymentId`);
 * nothing customer-supplied takes part in the lookup.
 *
 * Exactly one match is required: none means the event isn't about Zesto (or a
 * payment Zesto never persisted), more than one is a data anomaly that must
 * never be guessed at. The stored document is validated against the path it was
 * found at, and a document that is not an order's payment is treated as absent.
 */

export type LocatedPayment =
  | {kind: "none"}
  | {kind: "ambiguous"}
  | {kind: "found"; payment: Payment};

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {"providerOrderId" | "providerPaymentId"} field Which provider identifier to match.
 * @param {string} value The provider's identifier.
 * @return {Promise<LocatedPayment>} The lookup result.
 * @throws {Error} If the one matching payment document is malformed.
 */
export async function locatePaymentByProviderField(
  db: Firestore,
  field: "providerOrderId" | "providerPaymentId",
  value: string,
): Promise<LocatedPayment> {
  const snapshot = await db
    .collectionGroup("payments")
    .where(field, "==", value)
    .limit(2)
    .get();
  if (snapshot.empty) {
    return {kind: "none"};
  }
  if (snapshot.size > 1) {
    return {kind: "ambiguous"};
  }

  const doc = snapshot.docs[0];
  // organizations/{org}/outlets/{outlet}/menus/{menu}/orders/{order}/payments/{payment}
  const segments = doc.ref.path.split("/");
  const isOrderPayment =
    segments.length === 10 &&
    segments[0] === "organizations" &&
    segments[2] === "outlets" &&
    segments[4] === "menus" &&
    segments[6] === "orders" &&
    segments[8] === "payments";
  if (!isOrderPayment) {
    return {kind: "none"};
  }

  const payment = parsePayment(
    doc.data(), segments[9], segments[7], segments[1], segments[3], segments[5],
  );
  return {kind: "found", payment};
}

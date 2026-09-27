import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import type {VerifiedSession} from "./session";

/** Tenant-scoped role. Never a global claim — it lives on the membership. */
export type OrganizationMemberRole = "owner" | "manager" | "staff";

export type OrganizationMemberStatus = "active" | "invited" | "revoked";

export interface OrganizationMembership {
  userId: string;
  organizationId: string;
  role: OrganizationMemberRole;
  status: OrganizationMemberStatus;
}

const MEMBER_ROLES: readonly OrganizationMemberRole[] = [
  "owner",
  "manager",
  "staff",
];

/**
 * @param {unknown} value A stored role value.
 * @return {boolean} Whether `value` is a known organization role.
 */
function isMemberRole(value: unknown): value is OrganizationMemberRole {
  return (MEMBER_ROLES as readonly unknown[]).includes(value);
}

/**
 * Firestore document IDs cannot contain "/", be "." or "..", or match
 * `__.*__`. Rejecting these keeps a caller-supplied ID (an organization ID,
 * an outlet ID, etc.) from addressing any path other than the exact
 * single-segment document it names. Exported so any domain module taking a
 * caller-supplied document ID can reuse this same guard.
 *
 * @param {unknown} id The candidate document ID.
 * @return {boolean} Whether `id` is a safe single-segment document ID.
 */
export function isValidDocumentId(id: unknown): id is string {
  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= 1500 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id);
}

/**
 * Tenant-scoped authorization for a verified caller: requires an ACTIVE
 * membership at `organizations/{organizationId}/members/{session.userId}`
 * whose role is one of `allowedRoles`.
 *
 * Membership documents are written only by trusted backend code (Firestore
 * rules deny all client access), so this Admin SDK read is authoritative.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {VerifiedSession} session Output of `verifyDescopeSession`.
 * @param {unknown} organizationId Organization the operation targets.
 * @param {readonly OrganizationMemberRole[]} allowedRoles Permitted roles.
 * @return {Promise<OrganizationMembership>} The caller's membership.
 * @throws {HttpsError} `invalid-argument` for a malformed organization ID;
 *   `permission-denied` if the caller is not an active member with an
 *   allowed role.
 */
export async function requireOrganizationRole(
  db: Firestore,
  session: VerifiedSession,
  organizationId: unknown,
  allowedRoles: readonly OrganizationMemberRole[],
): Promise<OrganizationMembership> {
  if (!isValidDocumentId(organizationId)) {
    throw new HttpsError("invalid-argument", "Invalid organization ID.");
  }

  const snapshot = await db
    .collection("organizations")
    .doc(organizationId)
    .collection("members")
    .doc(session.userId)
    .get();

  const data = snapshot.data();
  const role: unknown = data?.role;
  if (
    !snapshot.exists ||
    data?.status !== "active" ||
    !isMemberRole(role) ||
    !allowedRoles.includes(role)
  ) {
    throw new HttpsError(
      "permission-denied",
      "You do not have access to this organization.",
    );
  }

  return {
    userId: session.userId,
    organizationId,
    role,
    status: "active",
  };
}

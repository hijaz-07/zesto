import {
  Timestamp,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import type {
  OrganizationMemberRole,
  OrganizationMemberStatus,
} from "../auth/membership";

/**
 * `organizations/{organizationId}` — see docs/architecture/http-api.md and
 * docs/architecture/domain-model.md. The document ID is a Firestore auto-ID.
 * `slug` is globally unique (enforced via `organizationSlugs/{slug}`, see
 * `createOrganization`) and, for this first implementation, immutable.
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: Timestamp;
  createdBy: string;
}

/** The API response shape for an `Organization`: `createdAt` as ISO 8601. */
export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  createdBy: string;
}

/**
 * `organizations/{organizationId}/members/{userId}` (see
 * `functions/src/auth/membership.ts`, which owns tenant *authorization*).
 * This module owns the *write* side — creating the owner membership when an
 * organization is created — and its own read shape (including `createdAt`,
 * which the authorization-only `OrganizationMembership` in `membership.ts`
 * does not need).
 */
export interface OrganizationMembershipRecord {
  userId: string;
  organizationId: string;
  role: OrganizationMemberRole;
  status: OrganizationMemberStatus;
  createdAt: Timestamp;
}

/** The API response shape for an `OrganizationMembershipRecord`. */
export interface OrganizationMembershipResponse {
  userId: string;
  organizationId: string;
  role: OrganizationMemberRole;
  status: OrganizationMemberStatus;
  createdAt: string;
}

/**
 * One row of `GET /organizations`: an organization plus the caller's role
 * in it.
 */
export interface OrganizationWithRole extends OrganizationResponse {
  role: OrganizationMemberRole;
}

const ORGANIZATION_NAME_MAX_LENGTH = 100;
const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 50;

/**
 * Lowercase letters/digits, hyphen-separated, no leading/trailing/consecutive
 * hyphens. Enforced strictly server-side; the backend never lowercases or
 * otherwise slugifies a caller-supplied slug.
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Validates a `POST /organizations` request body. */
export const createOrganizationBodySchema = z.object({
  name: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX_LENGTH),
  slug: z
    .string()
    .min(SLUG_MIN_LENGTH)
    .max(SLUG_MAX_LENGTH)
    .regex(
      SLUG_PATTERN,
      "Slug must be lowercase letters, numbers, and single hyphens only.",
    ),
});

export type CreateOrganizationInput =
  z.infer<typeof createOrganizationBodySchema>;

const organizationDocSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(SLUG_PATTERN),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
  createdBy: z.string().min(1),
});

const MEMBER_ROLE_VALUES = ["owner", "manager", "staff"] as const;
const MEMBER_STATUS_VALUES = ["active", "invited", "revoked"] as const;

const organizationMembershipDocSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  role: z.enum(MEMBER_ROLE_VALUES),
  status: z.enum(MEMBER_STATUS_VALUES),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
});

/**
 * Parses a stored `organizations/{organizationId}` document, validating it
 * was written in the expected shape and that its `id` field matches the
 * document's own ID. The Admin SDK bypasses Firestore rules, so this is the
 * only validation a stored document gets.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The document ID it was read from.
 * @return {Organization} The parsed organization.
 * @throws {Error} If the stored document does not match the expected shape.
 */
function parseOrganization(data: unknown, expectedId: string): Organization {
  const parsed = organizationDocSchema.safeParse(data);
  if (!parsed.success || parsed.data.id !== expectedId) {
    throw new Error(
      `Malformed organization document at organizations/${expectedId}.`,
    );
  }
  return parsed.data;
}

/**
 * Parses a stored organization membership document.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @return {OrganizationMembershipRecord} The parsed membership.
 * @throws {Error} If the stored document does not match the expected shape.
 */
function parseOrganizationMembership(
  data: unknown,
): OrganizationMembershipRecord {
  const parsed = organizationMembershipDocSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Malformed organization membership document.");
  }
  return parsed.data;
}

/**
 * @param {Organization} organization A stored organization.
 * @return {OrganizationResponse} The API response shape for it.
 */
export function toOrganizationResponse(
  organization: Organization,
): OrganizationResponse {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    createdAt: organization.createdAt.toDate().toISOString(),
    createdBy: organization.createdBy,
  };
}

/**
 * @param {OrganizationMembershipRecord} membership A stored membership.
 * @return {OrganizationMembershipResponse} The API response shape for it.
 */
export function toOrganizationMembershipResponse(
  membership: OrganizationMembershipRecord,
): OrganizationMembershipResponse {
  return {
    userId: membership.userId,
    organizationId: membership.organizationId,
    role: membership.role,
    status: membership.status,
    createdAt: membership.createdAt.toDate().toISOString(),
  };
}

/** The result of `createOrganization`. */
export interface CreatedOrganization {
  organization: Organization;
  membership: OrganizationMembershipRecord;
}

/**
 * Creates a new organization and its owner membership in one Firestore
 * transaction: pre-allocates the organization's auto-ID, reads
 * `organizationSlugs/{slug}` to enforce global slug uniqueness, and — only
 * if the slug is free — creates the organization document, the slug
 * reservation, and the caller's `owner`/`active` membership together. If the
 * slug is already taken, none of the three documents are written.
 *
 * The caller's identity (`userId`) is the ONLY source of `createdBy` and of
 * the membership's `userId`/`role`/`status` — nothing from the request body
 * ever reaches a stored document.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID. Always
 *   becomes the organization's `createdBy` and the sole `owner` member.
 * @param {CreateOrganizationInput} input The validated request body.
 * @return {Promise<CreatedOrganization>} The created organization and the
 *   caller's owner membership.
 * @throws {HttpsError} `already-exists` (409) if `input.slug` is already
 *   taken by another organization.
 */
export async function createOrganization(
  db: Firestore,
  userId: string,
  input: CreateOrganizationInput,
): Promise<CreatedOrganization> {
  const orgRef = db.collection("organizations").doc();
  const slugRef = db.collection("organizationSlugs").doc(input.slug);
  const memberRef = orgRef.collection("members").doc(userId);

  return db.runTransaction(async (tx) => {
    const slugSnapshot = await tx.get(slugRef);
    if (slugSnapshot.exists) {
      throw new HttpsError(
        "already-exists",
        "This organization URL is already taken.",
      );
    }

    const createdAt = Timestamp.now();
    const organization: Organization = {
      id: orgRef.id,
      name: input.name,
      slug: input.slug,
      createdAt,
      createdBy: userId,
    };
    const membership: OrganizationMembershipRecord = {
      userId,
      organizationId: orgRef.id,
      role: "owner",
      status: "active",
      createdAt,
    };

    tx.create(orgRef, organization);
    tx.create(slugRef, {organizationId: orgRef.id, createdAt});
    tx.create(memberRef, membership);

    return {organization, membership};
  });
}

/**
 * Lists the organizations where `userId` has an ACTIVE membership, via a
 * collection-group query over every `organizations/*\/members` subcollection
 * (requires the composite index declared in `firestore.indexes.json`).
 * `invited` and `revoked` memberships, and organizations the caller has no
 * membership in at all, are never returned.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @return {Promise<OrganizationWithRole[]>} The caller's organizations,
 *   each with the caller's role, ordered by membership `createdAt` ascending.
 * @throws {Error} If an active membership points at a missing or malformed
 *   organization document (surfaced by the caller as a generic 500).
 */
export async function listOrganizationsForUser(
  db: Firestore,
  userId: string,
): Promise<OrganizationWithRole[]> {
  const membershipsSnapshot = await db
    .collectionGroup("members")
    .where("userId", "==", userId)
    .where("status", "==", "active")
    .orderBy("createdAt", "asc")
    .get();

  if (membershipsSnapshot.empty) {
    return [];
  }

  const memberships = membershipsSnapshot.docs.map((doc) =>
    parseOrganizationMembership(doc.data()));
  const orgRefs: DocumentReference[] = membershipsSnapshot.docs.map((doc) => {
    const orgRef = doc.ref.parent.parent;
    if (!orgRef) {
      throw new Error(
        `Membership document has no parent organization: ${doc.ref.path}.`,
      );
    }
    return orgRef;
  });

  const orgSnapshots = await db.getAll(...orgRefs);

  return orgSnapshots.map((snapshot, index) => {
    if (!snapshot.exists) {
      throw new Error(
        "Active membership points at a missing organization: " +
        `${orgRefs[index].id}.`,
      );
    }
    const organization = parseOrganization(snapshot.data(), snapshot.id);
    return {
      ...toOrganizationResponse(organization),
      role: memberships[index].role,
    };
  });
}

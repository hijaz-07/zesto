import {
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {isValidDocumentId} from "../auth/membership";

/**
 * `organizations/{organizationId}/outlets/{outletId}` — a physical point of
 * service belonging to an `Organization` (see docs/architecture/domain-model.md
 * and docs/architecture/http-api.md#outlets). The document ID is a Firestore
 * auto-ID. `slug` is unique only within the parent organization (enforced via
 * `organizations/{organizationId}/outletSlugs/{slug}`, see `createOutlet`)
 * and, for this first implementation, immutable.
 */
export type OutletStatus = "active" | "inactive";

export interface OutletAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface OutletLocation {
  latitude: number;
  longitude: number;
}

export interface Outlet {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description?: string;
  status: OutletStatus;
  phone?: string;
  address?: OutletAddress;
  location?: OutletLocation;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
}

/** The API response shape for an `Outlet`: `createdAt`/`updatedAt` as ISO. */
export interface OutletResponse {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description?: string;
  status: OutletStatus;
  phone?: string;
  address?: OutletAddress;
  location?: OutletLocation;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

const OUTLET_NAME_MAX_LENGTH = 100;
const OUTLET_DESCRIPTION_MAX_LENGTH = 500;
const OUTLET_PHONE_MAX_LENGTH = 30;
const ADDRESS_LINE_MAX_LENGTH = 200;
const ADDRESS_CITY_MAX_LENGTH = 100;
const ADDRESS_STATE_MAX_LENGTH = 100;
const ADDRESS_POSTAL_CODE_MAX_LENGTH = 20;
const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 50;

/**
 * Lowercase letters/digits, hyphen-separated, no leading/trailing/consecutive
 * hyphens. Enforced strictly server-side, matching `organizations.ts`'s slug
 * rule; the backend never lowercases or otherwise slugifies a caller-supplied
 * slug.
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const outletAddressSchema = z.object({
  line1: z.string().trim().max(ADDRESS_LINE_MAX_LENGTH).optional(),
  line2: z.string().trim().max(ADDRESS_LINE_MAX_LENGTH).optional(),
  city: z.string().trim().max(ADDRESS_CITY_MAX_LENGTH).optional(),
  state: z.string().trim().max(ADDRESS_STATE_MAX_LENGTH).optional(),
  postalCode: z.string().trim().max(ADDRESS_POSTAL_CODE_MAX_LENGTH).optional(),
});

const outletLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** Validates a `POST /organizations/{organizationId}/outlets` request body. */
export const createOutletBodySchema = z.object({
  name: z.string().trim().min(1).max(OUTLET_NAME_MAX_LENGTH),
  slug: z
    .string()
    .min(SLUG_MIN_LENGTH)
    .max(SLUG_MAX_LENGTH)
    .regex(
      SLUG_PATTERN,
      "Slug must be lowercase letters, numbers, and single hyphens only.",
    ),
  description: z.string().trim().max(OUTLET_DESCRIPTION_MAX_LENGTH).optional(),
  phone: z.string().trim().max(OUTLET_PHONE_MAX_LENGTH).optional(),
  address: outletAddressSchema.optional(),
  location: outletLocationSchema.optional(),
});

export type CreateOutletInput = z.infer<typeof createOutletBodySchema>;

const OUTLET_STATUS_VALUES = ["active", "inactive"] as const;

/**
 * Validates a `PATCH /organizations/{organizationId}/outlets/{outletId}`
 * request body. `slug`, `id`, `organizationId`, `createdBy`, and `createdAt`
 * are deliberately not fields on this schema — an unknown field in the
 * request body is stripped by `safeParse`, not an error, so sending one is
 * silently ignored rather than rejected (matching `organizations.ts`'s
 * convention: the domain layer only ever reads the fields it knows about).
 */
export const updateOutletBodySchema = z.object({
  name: z.string().trim().min(1).max(OUTLET_NAME_MAX_LENGTH).optional(),
  description: z.string().trim().max(OUTLET_DESCRIPTION_MAX_LENGTH).optional(),
  phone: z.string().trim().max(OUTLET_PHONE_MAX_LENGTH).optional(),
  address: outletAddressSchema.optional(),
  location: outletLocationSchema.optional(),
  status: z.enum(OUTLET_STATUS_VALUES).optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided.",
);

export type UpdateOutletInput = z.infer<typeof updateOutletBodySchema>;

const outletDocSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(SLUG_PATTERN),
  description: z.string().optional(),
  status: z.enum(OUTLET_STATUS_VALUES),
  phone: z.string().optional(),
  address: outletAddressSchema.optional(),
  location: outletLocationSchema.optional(),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
  updatedAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "updatedAt must be a Firestore Timestamp",
  ),
  createdBy: z.string().min(1),
});

/**
 * Parses a stored `organizations/{organizationId}/outlets/{outletId}`
 * document, validating it was written in the expected shape and that its
 * `id`/`organizationId` fields match the path it was read from. The Admin
 * SDK bypasses Firestore rules, so this is the only validation a stored
 * document gets.
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The document ID it was read from.
 * @param {string} expectedOrganizationId The parent organization ID it was
 *   read from.
 * @return {Outlet} The parsed outlet.
 * @throws {Error} If the stored document does not match the expected shape.
 */
function parseOutlet(
  data: unknown,
  expectedId: string,
  expectedOrganizationId: string,
): Outlet {
  const parsed = outletDocSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== expectedId ||
    parsed.data.organizationId !== expectedOrganizationId
  ) {
    throw new Error(
      "Malformed outlet document at organizations/" +
      `${expectedOrganizationId}/outlets/${expectedId}.`,
    );
  }
  return parsed.data;
}

/**
 * Reads a single outlet, validating it belongs to `organizationId`. The
 * read-only half of what `updateOutlet` already does — used by other
 * domain modules (e.g. `domain/menus.ts`, via `routes/menus.ts`) that need
 * to confirm an outlet exists and inspect its `status` before proceeding,
 * without needing to mutate it.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the outlet must belong to
 *   (already authorized by the caller).
 * @param {unknown} outletId The outlet's document ID, from the request path.
 * @return {Promise<Outlet>} The outlet.
 * @throws {HttpsError} `invalid-argument` (400) if `outletId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such outlet exists in this
 *   organization.
 */
export async function getOutlet(
  db: Firestore,
  organizationId: string,
  outletId: unknown,
): Promise<Outlet> {
  if (!isValidDocumentId(outletId)) {
    throw new HttpsError("invalid-argument", "Invalid outlet ID.");
  }

  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId)
    .get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Outlet not found.");
  }

  return parseOutlet(snapshot.data(), outletId, organizationId);
}

/**
 * @param {Outlet} outlet A stored outlet.
 * @return {OutletResponse} The API response shape for it.
 */
export function toOutletResponse(outlet: Outlet): OutletResponse {
  return {
    id: outlet.id,
    organizationId: outlet.organizationId,
    name: outlet.name,
    slug: outlet.slug,
    description: outlet.description,
    status: outlet.status,
    phone: outlet.phone,
    address: outlet.address,
    location: outlet.location,
    createdAt: outlet.createdAt.toDate().toISOString(),
    updatedAt: outlet.updatedAt.toDate().toISOString(),
    createdBy: outlet.createdBy,
  };
}

/**
 * Builds an object containing only `fields`' defined entries. The Admin SDK
 * rejects an explicit `undefined` property value (`ignoreUndefinedProperties`
 * is not set), so an optional field that was not supplied must be omitted
 * entirely from a Firestore write rather than written as `undefined`.
 *
 * @param {T} fields Candidate fields, some possibly `undefined`.
 * @return {Partial<T>} `fields` with every `undefined` entry removed.
 */
function definedFields<T extends object>(fields: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * Creates a new outlet under `organizationId` in one Firestore transaction:
 * pre-allocates the outlet's auto-ID, reads
 * `organizations/{organizationId}/outletSlugs/{slug}` to enforce
 * per-organization slug uniqueness, and — only if the slug is free — creates
 * the outlet document and the slug reservation together. If the slug is
 * already taken (within this organization; the same slug is always free to
 * reuse in a different organization), neither document is written.
 *
 * `status` always starts `"active"` and is never taken from `input` — the
 * caller's identity (`userId`) is the only source of `createdBy`, and
 * `createdAt`/`updatedAt`/`id`/`organizationId` all come from the backend,
 * never from the request body.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the outlet belongs to
 *   (already authorized by the caller — see `auth/membership.ts`).
 * @param {string} userId The verified caller's Descope user ID.
 * @param {CreateOutletInput} input The validated request body.
 * @return {Promise<Outlet>} The created outlet.
 * @throws {HttpsError} `already-exists` (409) if `input.slug` is already
 *   taken by another outlet in this same organization.
 */
export async function createOutlet(
  db: Firestore,
  organizationId: string,
  userId: string,
  input: CreateOutletInput,
): Promise<Outlet> {
  const orgRef = db.collection("organizations").doc(organizationId);
  const outletRef = orgRef.collection("outlets").doc();
  const slugRef = orgRef.collection("outletSlugs").doc(input.slug);

  return db.runTransaction(async (tx) => {
    const slugSnapshot = await tx.get(slugRef);
    if (slugSnapshot.exists) {
      throw new HttpsError(
        "already-exists",
        "This outlet URL is already taken.",
      );
    }

    const now = Timestamp.now();
    const outlet: Outlet = {
      id: outletRef.id,
      organizationId,
      name: input.name,
      slug: input.slug,
      status: "active",
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      ...definedFields({
        description: input.description,
        phone: input.phone,
        address: input.address,
        location: input.location,
      }),
    };

    tx.create(outletRef, outlet);
    tx.create(slugRef, {
      organizationId, outletId: outletRef.id, createdAt: now,
    });

    return outlet;
  });
}

/**
 * Lists every outlet belonging to `organizationId`, both active and
 * inactive — this is an organization-management view, not a customer-facing
 * one, so inactive outlets are never hidden. Ordered by `createdAt`
 * ascending for a deterministic result.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization to list outlets for
 *   (already authorized by the caller).
 * @return {Promise<OutletResponse[]>} The organization's outlets, ordered by
 *   `createdAt` ascending; `[]` if it has none.
 * @throws {Error} If a stored outlet document does not match the expected
 *   shape (surfaced by the caller as a generic 500).
 */
export async function listOutletsForOrganization(
  db: Firestore,
  organizationId: string,
): Promise<OutletResponse[]> {
  const snapshot = await db
    .collection("organizations").doc(organizationId)
    .collection("outlets")
    .orderBy("createdAt", "asc")
    .get();

  return snapshot.docs.map((doc) =>
    toOutletResponse(parseOutlet(doc.data(), doc.id, organizationId)));
}

/**
 * Updates an existing outlet's editable fields: `name`, `description`,
 * `phone`, `address`, `location`, `status`. A field omitted from `input`
 * (i.e. `undefined` after validation) is left unchanged. `id`,
 * `organizationId`, `createdBy`, `createdAt`, and `slug` can never be
 * changed through this function — `slug` is immutable for this first
 * implementation (see `createOutlet`). Reads and writes the outlet in one
 * Firestore transaction, so a concurrent update can't be lost between the
 * existence check and the write.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} organizationId The organization the outlet must belong to
 *   (already authorized by the caller).
 * @param {unknown} outletId The outlet's document ID, from the request path.
 * @param {UpdateOutletInput} input The validated request body.
 * @return {Promise<Outlet>} The updated outlet.
 * @throws {HttpsError} `invalid-argument` (400) if `outletId` is not a
 *   well-formed document ID.
 * @throws {HttpsError} `not-found` (404) if no such outlet exists in this
 *   organization.
 */
export async function updateOutlet(
  db: Firestore,
  organizationId: string,
  outletId: unknown,
  input: UpdateOutletInput,
): Promise<Outlet> {
  if (!isValidDocumentId(outletId)) {
    throw new HttpsError("invalid-argument", "Invalid outlet ID.");
  }

  const outletRef = db
    .collection("organizations").doc(organizationId)
    .collection("outlets").doc(outletId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(outletRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Outlet not found.");
    }
    const existing = parseOutlet(snapshot.data(), outletId, organizationId);

    const updates = {
      updatedAt: Timestamp.now(),
      ...definedFields({
        name: input.name,
        description: input.description,
        phone: input.phone,
        address: input.address,
        location: input.location,
        status: input.status,
      }),
    };

    tx.update(outletRef, updates);

    return {...existing, ...updates};
  });
}

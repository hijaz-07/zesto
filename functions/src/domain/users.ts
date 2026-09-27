import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {z} from "zod";

/**
 * The `users/{userId}` profile document — deliberately minimal for now (see
 * docs/architecture/http-api.md): just the Descope user ID and when the
 * profile was first created. `displayName` / `phoneNumber` / `email` stay in
 * Descope and are not copied into Firestore yet.
 */
export interface UserProfile {
  id: string;
  createdAt: Timestamp;
}

/** The `/me` response shape: `createdAt` as an ISO 8601 string. */
export interface UserProfileResponse {
  id: string;
  createdAt: string;
}

const userProfileSchema = z.object({
  id: z.string().min(1),
  createdAt: z.custom<Timestamp>(
    (value) => value instanceof Timestamp,
    "createdAt must be a Firestore Timestamp",
  ),
});

/**
 * Parses a stored `users/{userId}` document, validating it was written in
 * the expected shape and that its `id` field matches the document's own ID
 * (the Admin SDK bypasses Firestore rules, so this schema check is the only
 * validation a stored user document gets).
 *
 * @param {unknown} data The document's raw field data (`snapshot.data()`).
 * @param {string} expectedId The document ID it was read from.
 * @return {UserProfile} The parsed profile.
 * @throws {Error} If the stored document does not match the expected shape.
 */
function parseUserProfile(data: unknown, expectedId: string): UserProfile {
  const parsed = userProfileSchema.safeParse(data);
  if (!parsed.success || parsed.data.id !== expectedId) {
    throw new Error(`Malformed user document at users/${expectedId}.`);
  }
  return parsed.data;
}

/**
 * @param {UserProfile} profile A stored profile.
 * @return {UserProfileResponse} The `/me` response shape for it.
 */
export function toUserProfileResponse(
  profile: UserProfile,
): UserProfileResponse {
  return {id: profile.id, createdAt: profile.createdAt.toDate().toISOString()};
}

/**
 * Reads the caller's `users/{userId}` profile, creating it on first call.
 * Uses a Firestore transaction so concurrent first calls for the same
 * `userId` are serialized by Firestore's optimistic-concurrency retries:
 * exactly one of them creates the document, and the rest read it back.
 * An existing `createdAt` is never overwritten.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {string} userId The verified caller's Descope user ID.
 * @return {Promise<UserProfile>} The caller's (possibly newly created)
 *   profile.
 * @throws {Error} If a stored document exists but does not match the
 *   expected shape.
 */
export async function getOrCreateUserProfile(
  db: Firestore,
  userId: string,
): Promise<UserProfile> {
  const ref = db.collection("users").doc(userId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) {
      return parseUserProfile(snapshot.data(), userId);
    }

    const profile: UserProfile = {id: userId, createdAt: Timestamp.now()};
    tx.create(ref, profile);
    return profile;
  });
}

import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import type { OrganizationId, OrganizationMember, UserId } from '../../../domain/types';

/**
 * Reads the current user's membership record for one organization, straight
 * from `organizations/{organizationId}/members/{userId}`.
 *
 * This is read-only by design: Firestore Security Rules deny all client
 * writes to membership documents, so membership can only be granted or
 * changed by trusted backend code. There is no organization creation or
 * invitation workflow here yet.
 */
export async function getOrganizationMembership(
  organizationId: OrganizationId,
  userId: UserId,
): Promise<OrganizationMember | null> {
  const membershipRef = doc(db, 'organizations', organizationId, 'members', userId);
  const snapshot = await getDoc(membershipRef);

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.data() as OrganizationMember;
}

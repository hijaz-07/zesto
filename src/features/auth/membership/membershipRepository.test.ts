import { describe, expect, it, vi } from 'vitest';
import { getOrganizationMembership } from './membershipRepository';

const { docMock, getDocMock } = vi.hoisted(() => ({
  docMock: vi.fn(),
  getDocMock: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  doc: docMock,
  getDoc: getDocMock,
}));

vi.mock('../../../lib/firebase', () => ({
  db: {},
}));

describe('getOrganizationMembership', () => {
  it('reads the doc at organizations/{organizationId}/members/{userId} and returns null when absent', async () => {
    docMock.mockReturnValue('membership-ref');
    getDocMock.mockResolvedValue({ exists: () => false });

    const result = await getOrganizationMembership('org-1', 'user-1');

    expect(docMock).toHaveBeenCalledWith({}, 'organizations', 'org-1', 'members', 'user-1');
    expect(result).toBeNull();
  });

  it('returns the membership data when the document exists', async () => {
    const membership = {
      userId: 'user-1',
      organizationId: 'org-1',
      role: 'staff',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    docMock.mockReturnValue('membership-ref');
    getDocMock.mockResolvedValue({ exists: () => true, data: () => membership });

    const result = await getOrganizationMembership('org-1', 'user-1');

    expect(result).toEqual(membership);
  });
});

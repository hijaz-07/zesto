// @vitest-environment node
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { Timestamp, doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';

let testEnv: RulesTestEnvironment;

const OWNER_UID = 'user-owner';
const OTHER_UID = 'user-other';
const ORG_A = 'org-a';
const ORG_B = 'org-b';

function validUserDoc(uid: string) {
  return {
    id: uid,
    displayName: 'Test User',
    createdAt: Timestamp.now(),
  };
}

function membershipDoc(uid: string, organizationId: string, status: 'active' | 'invited' | 'revoked' = 'active') {
  return {
    userId: uid,
    organizationId,
    role: 'owner',
    status,
    createdAt: Timestamp.now(),
  };
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-zesto-rules-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe('firestore.rules: users/{userId}', () => {
  it('denies unauthenticated access', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthedDb, 'users', OWNER_UID)));
  });

  it('allows a user to read their own user document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', OWNER_UID), validUserDoc(OWNER_UID));
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(getDoc(doc(ownerDb, 'users', OWNER_UID)));
  });

  it('denies reading another user’s document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', OWNER_UID), validUserDoc(OWNER_UID));
    });

    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, 'users', OWNER_UID)));
  });

  it('denies modifying another user’s document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', OWNER_UID), validUserDoc(OWNER_UID));
    });

    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(otherDb, 'users', OWNER_UID), { ...validUserDoc(OWNER_UID), displayName: 'Hijacked' }),
    );
  });

  it('allows a user to create their own valid user document', async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(setDoc(doc(ownerDb, 'users', OWNER_UID), validUserDoc(OWNER_UID)));
  });

  it('denies creating a user document under someone else’s uid', async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(setDoc(doc(ownerDb, 'users', OTHER_UID), validUserDoc(OTHER_UID)));
  });
});

describe('firestore.rules: organizations/{organizationId}', () => {
  it('allows an active member to read the organization', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizations', ORG_A), { id: ORG_A, name: 'Org A' });
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'active'),
      );
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(getDoc(doc(ownerDb, 'organizations', ORG_A)));
  });

  it('denies an invited (not yet active) member from reading the organization', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizations', ORG_A), { id: ORG_A, name: 'Org A' });
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'invited'),
      );
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(getDoc(doc(ownerDb, 'organizations', ORG_A)));
  });

  it('denies a revoked member from reading the organization', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizations', ORG_A), { id: ORG_A, name: 'Org A' });
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'revoked'),
      );
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(getDoc(doc(ownerDb, 'organizations', ORG_A)));
  });

  it('denies a non-member (no membership document at all) from reading the organization', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizations', ORG_A), { id: ORG_A, name: 'Org A' });
    });

    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, 'organizations', ORG_A)));
  });

  it('denies reading an organization the user is not an active member of (tenant isolation)', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizations', ORG_B), { id: ORG_B, name: 'Org B' });
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'active'),
      );
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(getDoc(doc(ownerDb, 'organizations', ORG_B)));
  });
});

describe('firestore.rules: organizations/{organizationId}/members/{memberId}', () => {
  it('denies a user creating/granting themselves organization membership', async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      setDoc(doc(ownerDb, 'organizations', ORG_A, 'members', OWNER_UID), membershipDoc(OWNER_UID, ORG_A)),
    );
  });

  it('denies a user changing their own organization role', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'active'),
      );
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      setDoc(doc(ownerDb, 'organizations', ORG_A, 'members', OWNER_UID), {
        ...membershipDoc(OWNER_UID, ORG_A, 'active'),
        role: 'manager',
      }),
    );
  });

  it('allows an active member to read their own membership document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'active'),
      );
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(getDoc(doc(ownerDb, 'organizations', ORG_A, 'members', OWNER_UID)));
  });

  it('allows a revoked member to still read their own membership document (so they can see their status)', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'revoked'),
      );
    });

    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(getDoc(doc(ownerDb, 'organizations', ORG_A, 'members', OWNER_UID)));
  });

  it('denies a member from reading another user’s membership document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', OWNER_UID),
        membershipDoc(OWNER_UID, ORG_A, 'active'),
      );
    });

    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, 'organizations', ORG_A, 'members', OWNER_UID)));
  });
});

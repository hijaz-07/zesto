// @vitest-environment node
import { readFileSync } from 'node:fs';
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { Timestamp, deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';

/**
 * Descope is Zesto's identity provider, so no legitimate client carries a
 * Firebase Auth identity. `authenticatedContext(uid)` here simulates a
 * stray Firebase Auth sign-in, which must never be treated as a Zesto user —
 * even when its uid matches a stored user or an active membership.
 */

let testEnv: RulesTestEnvironment;

const USER_ID = 'user-owner';
const ORG_A = 'org-a';

function validUserDoc(uid: string) {
  return {
    id: uid,
    displayName: 'Test User',
    createdAt: Timestamp.now(),
  };
}

function membershipDoc(uid: string, organizationId: string) {
  return {
    userId: uid,
    organizationId,
    role: 'owner',
    status: 'active',
    createdAt: Timestamp.now(),
  };
}

function outletDoc(outletId: string, organizationId: string) {
  return {
    id: outletId,
    organizationId,
    name: 'Main Canteen',
    slug: 'main-canteen',
    status: 'active',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: USER_ID,
  };
}

function clients() {
  return {
    unauthenticated: testEnv.unauthenticatedContext().firestore(),
    firebaseAuthenticated: testEnv.authenticatedContext(USER_ID).firestore(),
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
  it('denies all client reads, even of a user document whose id matches the caller', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', USER_ID), validUserDoc(USER_ID));
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'users', USER_ID)));
    }
  });

  it('denies all client creates, updates, and deletes', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(setDoc(doc(db, 'users', USER_ID), validUserDoc(USER_ID)));
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', USER_ID), validUserDoc(USER_ID));
    });

    for (const db of Object.values(clients())) {
      await assertFails(updateDoc(doc(db, 'users', USER_ID), { displayName: 'Changed' }));
      await assertFails(deleteDoc(doc(db, 'users', USER_ID)));
    }
  });
});

describe('firestore.rules: organizations/{organizationId}', () => {
  it('denies client reads even when the caller id matches an active membership', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizations', ORG_A), { id: ORG_A, name: 'Org A' });
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', USER_ID),
        membershipDoc(USER_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'organizations', ORG_A)));
    }
  });

  it('denies all client writes', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(setDoc(doc(db, 'organizations', ORG_A), { id: ORG_A, name: 'Org A' }));
    }
  });
});

describe('firestore.rules: organizations/{organizationId}/members/{memberId}', () => {
  it('denies a client reading its own membership document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', USER_ID),
        membershipDoc(USER_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'organizations', ORG_A, 'members', USER_ID)));
    }
  });

  it('denies a client granting itself membership or changing its role', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(doc(db, 'organizations', ORG_A, 'members', USER_ID), membershipDoc(USER_ID, ORG_A)),
      );
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', USER_ID),
        membershipDoc(USER_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(updateDoc(doc(db, 'organizations', ORG_A, 'members', USER_ID), { role: 'manager' }));
    }
  });
});

describe('firestore.rules: organizations/{organizationId}/outlets/{outletId}', () => {
  const OUTLET_ID = 'outlet-1';

  it('denies a client reading an outlet even when the caller has an active membership in its organization', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', USER_ID),
        membershipDoc(USER_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID),
        outletDoc(OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID)));
    }
  });

  it('denies all client writes', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID), outletDoc(OUTLET_ID, ORG_A)),
      );
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID),
        outletDoc(OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(updateDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID), { status: 'inactive' }));
      await assertFails(deleteDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID)));
    }
  });
});

describe('firestore.rules: organizations/{organizationId}/outlets/{outletId}/menus/{menuId}', () => {
  const OUTLET_ID = 'outlet-1';
  const MENU_ID = 'menu-1';

  function menuDoc(menuId: string, outletId: string, organizationId: string) {
    return {
      id: menuId,
      organizationId,
      outletId,
      menuDate: '2026-09-28',
      title: 'Tuesday Special Menu',
      status: 'draft',
      orderingOpensAt: Timestamp.now(),
      orderingClosesAt: Timestamp.now(),
      pickupStartsAt: Timestamp.now(),
      pickupEndsAt: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      createdBy: USER_ID,
    };
  }

  it('denies a client reading a menu even when the caller has an active membership and the outlet exists', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', USER_ID),
        membershipDoc(USER_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID),
        outletDoc(OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID),
        menuDoc(MENU_ID, OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID)));
    }
  });

  it('denies all client writes', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(
          doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID),
          menuDoc(MENU_ID, OUTLET_ID, ORG_A),
        ),
      );
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID),
        menuDoc(MENU_ID, OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        updateDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID), { status: 'published' }),
      );
      await assertFails(deleteDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID)));
    }
  });
});

describe('firestore.rules: organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items/{itemId}', () => {
  const OUTLET_ID = 'outlet-1';
  const MENU_ID = 'menu-1';
  const ITEM_ID = 'item-1';

  function menuDoc(menuId: string, outletId: string, organizationId: string) {
    return {
      id: menuId,
      organizationId,
      outletId,
      menuDate: '2026-09-28',
      title: 'Tuesday Special Menu',
      status: 'draft',
      orderingOpensAt: Timestamp.now(),
      orderingClosesAt: Timestamp.now(),
      pickupStartsAt: Timestamp.now(),
      pickupEndsAt: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      createdBy: USER_ID,
    };
  }

  function itemDoc(itemId: string, menuId: string) {
    return {
      id: itemId,
      menuId,
      name: 'Chicken Biriyani',
      priceInPaise: 12000,
      enabled: true,
      displayOrder: 1,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      createdBy: USER_ID,
    };
  }

  it('denies a client reading an item even when the caller has an active membership and the outlet/menu exist', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'members', USER_ID),
        membershipDoc(USER_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID),
        outletDoc(OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID),
        menuDoc(MENU_ID, OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'items', ITEM_ID),
        itemDoc(ITEM_ID, MENU_ID),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        getDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'items', ITEM_ID)),
      );
    }
  });

  it('denies all client writes', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(
          doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'items', ITEM_ID),
          itemDoc(ITEM_ID, MENU_ID),
        ),
      );
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'items', ITEM_ID),
        itemDoc(ITEM_ID, MENU_ID),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        updateDoc(
          doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'items', ITEM_ID),
          { enabled: false },
        ),
      );
      await assertFails(
        deleteDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'items', ITEM_ID)),
      );
    }
  });
});

describe('firestore.rules: organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/orders/{orderId}', () => {
  const OUTLET_ID = 'outlet-1';
  const MENU_ID = 'menu-1';
  const ORDER_ID = 'order-1';

  function menuDoc(menuId: string, outletId: string, organizationId: string) {
    return {
      id: menuId,
      organizationId,
      outletId,
      menuDate: '2026-09-28',
      title: 'Tuesday Special Menu',
      status: 'published',
      orderingOpensAt: Timestamp.now(),
      orderingClosesAt: Timestamp.now(),
      pickupStartsAt: Timestamp.now(),
      pickupEndsAt: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      createdBy: USER_ID,
    };
  }

  function orderDoc(orderId: string, menuId: string, outletId: string, organizationId: string) {
    return {
      id: orderId,
      userId: USER_ID,
      organizationId,
      outletId,
      menuId,
      status: 'pending_payment',
      paymentStatus: 'pending',
      currency: 'INR',
      subtotalInPaise: 12000,
      totalInPaise: 12000,
      items: [
        { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1, lineTotalInPaise: 12000 },
      ],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
  }

  it('denies a client reading its own order even when the caller id matches userId', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID),
        outletDoc(OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID),
        menuDoc(MENU_ID, OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID),
        orderDoc(ORDER_ID, MENU_ID, OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        getDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID)),
      );
    }
  });

  it('denies all client writes', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(
          doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID),
          orderDoc(ORDER_ID, MENU_ID, OUTLET_ID, ORG_A),
        ),
      );
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID),
        orderDoc(ORDER_ID, MENU_ID, OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        updateDoc(
          doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID),
          { status: 'confirmed' },
        ),
      );
      await assertFails(
        deleteDoc(doc(db, 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID)),
      );
    }
  });
});

describe('firestore.rules: organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/orders/{orderId}/payments/{paymentId}', () => {
  const OUTLET_ID = 'outlet-1';
  const MENU_ID = 'menu-1';
  const ORDER_ID = 'order-1';
  const PAYMENT_ID = ORDER_ID;

  function menuDoc(menuId: string, outletId: string, organizationId: string) {
    return {
      id: menuId,
      organizationId,
      outletId,
      menuDate: '2026-09-28',
      title: 'Tuesday Special Menu',
      status: 'published',
      orderingOpensAt: Timestamp.now(),
      orderingClosesAt: Timestamp.now(),
      pickupStartsAt: Timestamp.now(),
      pickupEndsAt: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      createdBy: USER_ID,
    };
  }

  function orderDoc(orderId: string, menuId: string, outletId: string, organizationId: string) {
    return {
      id: orderId,
      userId: USER_ID,
      organizationId,
      outletId,
      menuId,
      status: 'pending_payment',
      paymentStatus: 'pending',
      currency: 'INR',
      subtotalInPaise: 12000,
      totalInPaise: 12000,
      items: [
        { itemId: 'item-1', name: 'Chicken Biriyani', priceInPaise: 12000, quantity: 1, lineTotalInPaise: 12000 },
      ],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
  }

  function paymentDoc(paymentId: string, orderId: string, menuId: string, outletId: string, organizationId: string) {
    return {
      id: paymentId,
      orderId,
      userId: USER_ID,
      organizationId,
      outletId,
      menuId,
      amountInPaise: 12000,
      currency: 'INR',
      status: 'pending',
      provider: 'none',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
  }

  it('denies a client reading its own payment even when the caller id matches userId', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID),
        outletDoc(OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID),
        menuDoc(MENU_ID, OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(context.firestore(), 'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID),
        orderDoc(ORDER_ID, MENU_ID, OUTLET_ID, ORG_A),
      );
      await setDoc(
        doc(
          context.firestore(),
          'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID, 'payments', PAYMENT_ID,
        ),
        paymentDoc(PAYMENT_ID, ORDER_ID, MENU_ID, OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        getDoc(doc(
          db,
          'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID, 'payments', PAYMENT_ID,
        )),
      );
    }
  });

  it('denies all client writes, including a client trying to mark its own payment succeeded', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(
          doc(
            db,
            'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID, 'payments', PAYMENT_ID,
          ),
          paymentDoc(PAYMENT_ID, ORDER_ID, MENU_ID, OUTLET_ID, ORG_A),
        ),
      );
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(
          context.firestore(),
          'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID, 'payments', PAYMENT_ID,
        ),
        paymentDoc(PAYMENT_ID, ORDER_ID, MENU_ID, OUTLET_ID, ORG_A),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        updateDoc(
          doc(
            db,
            'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID, 'payments', PAYMENT_ID,
          ),
          { status: 'succeeded' },
        ),
      );
      await assertFails(
        deleteDoc(doc(
          db,
          'organizations', ORG_A, 'outlets', OUTLET_ID, 'menus', MENU_ID, 'orders', ORDER_ID, 'payments', PAYMENT_ID,
        )),
      );
    }
  });
});

describe('firestore.rules: users/{userId}/orderIdempotencyKeys/{idempotencyKey}', () => {
  const IDEMPOTENCY_KEY = 'idem-key-1';

  function idempotencyRecordDoc() {
    return {
      idempotencyKey: IDEMPOTENCY_KEY,
      userId: USER_ID,
      requestFingerprint: '{"outletId":"outlet-1","menuId":"menu-1","items":[]}',
      organizationId: ORG_A,
      outletId: 'outlet-1',
      menuId: 'menu-1',
      orderId: 'order-1',
      createdAt: Timestamp.now(),
    };
  }

  it('denies a client reading its own idempotency record', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'users', USER_ID, 'orderIdempotencyKeys', IDEMPOTENCY_KEY),
        idempotencyRecordDoc(),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'users', USER_ID, 'orderIdempotencyKeys', IDEMPOTENCY_KEY)));
    }
  });

  it('denies all client writes', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(doc(db, 'users', USER_ID, 'orderIdempotencyKeys', IDEMPOTENCY_KEY), idempotencyRecordDoc()),
      );
    }

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'users', USER_ID, 'orderIdempotencyKeys', IDEMPOTENCY_KEY),
        idempotencyRecordDoc(),
      );
    });

    for (const db of Object.values(clients())) {
      await assertFails(
        updateDoc(doc(db, 'users', USER_ID, 'orderIdempotencyKeys', IDEMPOTENCY_KEY), { orderId: 'order-2' }),
      );
      await assertFails(deleteDoc(doc(db, 'users', USER_ID, 'orderIdempotencyKeys', IDEMPOTENCY_KEY)));
    }
  });
});

describe('firestore.rules: organizations/{organizationId}/outletSlugs/{slug}', () => {
  const SLUG = 'main-canteen';

  it('denies all client reads', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizations', ORG_A, 'outletSlugs', SLUG), {
        organizationId: ORG_A,
        outletId: 'outlet-1',
        createdAt: Timestamp.now(),
      });
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'organizations', ORG_A, 'outletSlugs', SLUG)));
    }
  });

  it('denies a client reserving an outlet slug directly, bypassing outlet creation', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(doc(db, 'organizations', ORG_A, 'outletSlugs', SLUG), {
          organizationId: ORG_A,
          outletId: 'outlet-1',
          createdAt: Timestamp.now(),
        }),
      );
    }
  });
});

describe('firestore.rules: organizationSlugs/{slug}', () => {
  const SLUG = 'test-canteen';

  it('denies all client reads, even of a slug reservation the caller created the organization for', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizationSlugs', SLUG), {
        organizationId: ORG_A,
        createdAt: Timestamp.now(),
      });
    });

    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'organizationSlugs', SLUG)));
    }
  });

  it('denies a client reserving a slug directly, bypassing organization creation', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(
        setDoc(doc(db, 'organizationSlugs', SLUG), {
          organizationId: ORG_A,
          createdAt: Timestamp.now(),
        }),
      );
    }
  });

  it('denies all client updates and deletes', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'organizationSlugs', SLUG), {
        organizationId: ORG_A,
        createdAt: Timestamp.now(),
      });
    });

    for (const db of Object.values(clients())) {
      await assertFails(updateDoc(doc(db, 'organizationSlugs', SLUG), { organizationId: 'org-attacker' }));
      await assertFails(deleteDoc(doc(db, 'organizationSlugs', SLUG)));
    }
  });
});

describe('firestore.rules: default deny', () => {
  it('denies client access to any other collection', async () => {
    for (const db of Object.values(clients())) {
      await assertFails(getDoc(doc(db, 'menus', 'menu-1')));
      await assertFails(setDoc(doc(db, 'menus', 'menu-1'), { title: 'Tomorrow' }));
    }
  });
});

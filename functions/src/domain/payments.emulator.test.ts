// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {beforeAll, describe, expect, it, vi} from "vitest";
import {createMenuItem, type CreateMenuItemInput} from "./menuItems";
import {createMenu, publishMenu, type Menu} from "./menus";
import {createOrder, getOwnedOrder, type Order} from "./orders";
import {createOrganization} from "./organizations";
import {createOutlet} from "./outlets";
import {
  ensureProviderOrder,
  markPaymentFailed,
  markPaymentSucceeded,
  preparePayment,
  type Payment,
} from "./payments";
import {businessDateString} from "../time";
import {PaymentProviderError, type CreateProviderOrderInput, type PaymentProviderGateway} from "../providers/razorpay";

/**
 * These tests exercise `preparePayment`/`ensureProviderOrder`/
 * `markPaymentSucceeded`/`markPaymentFailed` directly against a REAL
 * Firestore emulator — the same reason `orders.emulator.test.ts` exists: to
 * prove real transaction semantics (the create-or-reuse payment record, the
 * guarded provider-order claim, and the atomic payment+order transitions)
 * and real concurrency. There is no HTTP route for
 * `markPaymentSucceeded`/`markPaymentFailed` in this checkpoint (see root
 * CLAUDE.md's core payment rule), so they are only reachable at this domain
 * layer, matching how a future trusted webhook adapter will call them.
 * `preparePayment`/`ensureProviderOrder` ARE reachable via HTTP
 * (`POST /orders/{orderId}/payment`); their route-level behavior (auth,
 * envelope, status codes, response shape) is covered separately in
 * `routes/orders.emulator.test.ts`, so the tests here focus on the domain
 * invariants themselves.
 *
 * `ensureProviderOrder` always gets a FAKE `PaymentProviderGateway` (see
 * `fakeGateway` below) — this suite never calls the real Razorpay API, per
 * this checkpoint's "unit tests should mock the provider abstraction"
 * requirement.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

const PROJECT_ID = "demo-zesto-functions-test";

let db: Firestore;

// Each test here builds a full org/outlet/menu/item/order chain (5+
// sequential transactions) before exercising a payment operation. Comfortably
// inside vitest's 5000ms default in isolation, but running the full
// `npm run test:functions-emulator` suite shares one emulator instance across
// every test file at once, and this file alone has 20+ such tests — enough
// contention to occasionally miss the default, the same reasoning
// `orders.emulator.test.ts`'s own concurrent-transaction tests bump their
// timeout for.
vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this file via " +
      "`npm run test:functions-emulator` (from the repo root), which " +
      "starts the Firestore emulator first.",
    );
  }
  const app = getApps().length > 0 ?
    getApps()[0] :
    initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

function freshOrgInput() {
  const suffix = randomUUID();
  return {name: `Test Canteen ${suffix}`, slug: `test-canteen-${suffix}`};
}

function freshOutletInput() {
  const suffix = randomUUID();
  return {name: `Main Canteen ${suffix}`, slug: `main-canteen-${suffix}`};
}

function freshItemInput(overrides: Partial<CreateMenuItemInput> = {}): CreateMenuItemInput {
  return {
    name: `Test Item ${randomUUID()}`,
    description: "A freshly prepared test item.",
    priceInPaise: 12000,
    displayOrder: 1,
    ...overrides,
  };
}

async function setupOrgWithOwner(): Promise<{organizationId: string; ownerId: string}> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  return {organizationId: organization.id, ownerId};
}

async function setupOutlet(organizationId: string, ownerId: string): Promise<{outletId: string}> {
  const outlet = await createOutlet(db, organizationId, ownerId, freshOutletInput());
  return {outletId: outlet.id};
}

async function createDraftMenu(organizationId: string, outletId: string, ownerId: string): Promise<Menu> {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  return createMenu(db, organizationId, outletId, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 60 * 60 * 1000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 60 * 60 * 1000)),
    pickupStartsAt: Timestamp.fromDate(new Date(tomorrow)),
    pickupEndsAt: Timestamp.fromDate(new Date(tomorrow + 4 * 60 * 60 * 1000)),
  });
}

/** Org + owner + active outlet + a PUBLISHED menu (ordering open) + one
 * enabled item + a real `pending_payment` order for a fresh customer — the
 * common fixture every test here builds on. */
async function setupPendingOrder(
  priceInPaise = 12000,
): Promise<{organizationId: string; ownerId: string; outletId: string; menuId: string; order: Order; customerId: string}> {
  const {organizationId, ownerId} = await setupOrgWithOwner();
  const {outletId} = await setupOutlet(organizationId, ownerId);
  const menu = await createDraftMenu(organizationId, outletId, ownerId);
  const item = await createMenuItem(
    db, organizationId, outletId, menu.id, ownerId, freshItemInput({priceInPaise}),
  );
  await publishMenu(db, organizationId, outletId, menu.id);
  const customerId = freshUserId();
  const {order} = await createOrder(db, customerId, {
    outletId, menuId: menu.id,
    items: [{itemId: item.id, quantity: 1}],
    idempotencyKey: `key-${randomUUID()}`,
  });
  return {organizationId, ownerId, outletId, menuId: menu.id, order, customerId};
}

/** A fake `PaymentProviderGateway` — never the real Razorpay SDK/API (see
 * this file's own doc comment). Each `createOrder` call returns a fresh,
 * distinct provider order ID unless `orderId` is fixed via `overrides`, so
 * concurrency tests can tell which of several concurrent calls "won". */
function fakeGateway(overrides: {
  createOrder?: PaymentProviderGateway["createOrder"];
  fetchOrder?: PaymentProviderGateway["fetchOrder"];
} = {}): {gateway: PaymentProviderGateway; createOrder: ReturnType<typeof vi.fn>} {
  let counter = 0;
  const createOrder = vi.fn(
    overrides.createOrder ??
    (async (input: CreateProviderOrderInput) => ({
      id: `order_fake_${randomUUID()}_${++counter}`,
      amountInPaise: input.amountInPaise,
      currency: input.currency,
      receipt: input.receipt,
      status: "created",
    })),
  );
  const fetchOrder = vi.fn(
    overrides.fetchOrder ??
    (async (providerOrderId: string) => ({
      id: providerOrderId, amountInPaise: 0, currency: "INR", status: "created",
    })),
  );
  return {gateway: {createOrder, fetchOrder}, createOrder};
}

describe("preparePayment", () => {
  it("creates a pending payment whose amount/currency come from the order total", async () => {
    const {order, customerId} = await setupPendingOrder(12000);

    const {payment, created} = await preparePayment(db, customerId, order.id);

    expect(created).toBe(true);
    expect(payment).toMatchObject({
      id: order.id,
      orderId: order.id,
      userId: customerId,
      organizationId: order.organizationId,
      outletId: order.outletId,
      menuId: order.menuId,
      amountInPaise: order.totalInPaise,
      currency: "INR",
      status: "pending",
      provider: "none",
    });
  });

  it("is retry-safe: a second call for the same order reuses the same payment record", async () => {
    const {order, customerId} = await setupPendingOrder();

    const first = await preparePayment(db, customerId, order.id);
    const second = await preparePayment(db, customerId, order.id);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.payment).toEqual(first.payment);

    const stored = await db
      .collectionGroup("payments")
      .where("orderId", "==", order.id)
      .get();
    expect(stored.size).toBe(1);
  });

  it("two concurrent prepare calls for the same order still create exactly one payment", async () => {
    const {order, customerId} = await setupPendingOrder();

    const [a, b] = await Promise.all([
      preparePayment(db, customerId, order.id),
      preparePayment(db, customerId, order.id),
    ]);

    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const stored = await db
      .collectionGroup("payments")
      .where("orderId", "==", order.id)
      .get();
    expect(stored.size).toBe(1);
  });

  it("rejects a different customer preparing payment for someone else's order (not-found)", async () => {
    const {order} = await setupPendingOrder();

    await expect(preparePayment(db, freshUserId(), order.id))
      .rejects.toMatchObject({code: "not-found"});
  });

  it("rejects a nonexistent order (not-found)", async () => {
    await expect(preparePayment(db, freshUserId(), "no-such-order"))
      .rejects.toMatchObject({code: "not-found"});
  });

  it("rejects a malformed order ID (invalid-argument), never touching Firestore", async () => {
    await expect(preparePayment(db, freshUserId(), "a/b"))
      .rejects.toMatchObject({code: "invalid-argument"});
  });

  it("rejects preparing payment for an order that is already confirmed", async () => {
    const {order, customerId} = await setupPendingOrder();
    const {payment} = await preparePayment(db, customerId, order.id);
    await markPaymentSucceeded(db, {
      orderId: order.id,
      paymentId: payment.id,
      amountInPaise: payment.amountInPaise,
      currency: payment.currency,
    });

    await expect(preparePayment(db, customerId, order.id))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("rejects preparing payment for a cancelled order", async () => {
    const {order, customerId} = await setupPendingOrder();
    await db
      .collectionGroup("orders")
      .where("id", "==", order.id)
      .get()
      .then((snapshot) => snapshot.docs[0].ref.update({status: "cancelled"}));

    await expect(preparePayment(db, customerId, order.id))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("ignores a tampered amount/currency: there is no request body to trust in the first place", async () => {
    const {order, customerId} = await setupPendingOrder(5000);
    // preparePayment's signature takes no body at all — this test documents
    // that invariant rather than exercising a code path that could differ.
    const {payment} = await preparePayment(db, customerId, order.id);
    expect(payment.amountInPaise).toBe(order.totalInPaise);
    expect(payment.currency).toBe(order.currency);
  });
});

describe("markPaymentSucceeded", () => {
  async function preparedPayment(): Promise<{order: Order; payment: Payment; customerId: string}> {
    const {order, customerId} = await setupPendingOrder();
    const {payment} = await preparePayment(db, customerId, order.id);
    return {order, payment, customerId};
  }

  it("atomically marks the payment succeeded and the order confirmed/paid", async () => {
    const {order, payment} = await preparedPayment();

    const result = await markPaymentSucceeded(db, {
      orderId: order.id,
      paymentId: payment.id,
      amountInPaise: payment.amountInPaise,
      currency: payment.currency,
    });

    expect(result.payment.status).toBe("succeeded");
    expect(result.order.status).toBe("confirmed");
    expect(result.order.paymentStatus).toBe("paid");

    const reread = await getOwnedOrder(db, order.userId, order.id);
    expect(reread.status).toBe("confirmed");
    expect(reread.paymentStatus).toBe("paid");
  });

  it("is idempotent: a repeated success call does not error and leaves the same result", async () => {
    const {order, payment} = await preparedPayment();
    const input = {
      orderId: order.id, paymentId: payment.id,
      amountInPaise: payment.amountInPaise, currency: payment.currency,
    };

    const first = await markPaymentSucceeded(db, input);
    const second = await markPaymentSucceeded(db, input);

    expect(second.payment.status).toBe("succeeded");
    expect(second.order.status).toBe("confirmed");
    expect(second.payment.updatedAt.toMillis()).toBe(first.payment.updatedAt.toMillis());
  });

  it("rejects a mismatched amount, never marking the payment succeeded", async () => {
    const {order, payment} = await preparedPayment();

    await expect(markPaymentSucceeded(db, {
      orderId: order.id, paymentId: payment.id,
      amountInPaise: payment.amountInPaise + 1, currency: payment.currency,
    })).rejects.toMatchObject({code: "failed-precondition"});

    const reread = await getOwnedOrder(db, order.userId, order.id);
    expect(reread.status).toBe("pending_payment");
  });

  it("rejects a mismatched currency, never marking the payment succeeded", async () => {
    const {order, payment} = await preparedPayment();

    await expect(markPaymentSucceeded(db, {
      orderId: order.id, paymentId: payment.id,
      amountInPaise: payment.amountInPaise, currency: "USD",
    })).rejects.toMatchObject({code: "failed-precondition"});
  });

  it("allows a failed payment to later succeed (failed -> succeeded)", async () => {
    const {order, payment} = await preparedPayment();
    await markPaymentFailed(db, {orderId: order.id, paymentId: payment.id});

    const result = await markPaymentSucceeded(db, {
      orderId: order.id, paymentId: payment.id,
      amountInPaise: payment.amountInPaise, currency: payment.currency,
    });

    expect(result.payment.status).toBe("succeeded");
    expect(result.order.status).toBe("confirmed");
  });

  it("never confirms an already-cancelled order", async () => {
    const {order, payment} = await preparedPayment();
    await db
      .collectionGroup("orders")
      .where("id", "==", order.id)
      .get()
      .then((snapshot) => snapshot.docs[0].ref.update({status: "cancelled"}));

    await expect(markPaymentSucceeded(db, {
      orderId: order.id, paymentId: payment.id,
      amountInPaise: payment.amountInPaise, currency: payment.currency,
    })).rejects.toMatchObject({code: "failed-precondition"});

    const reread = await getOwnedOrder(db, order.userId, order.id);
    expect(reread.status).toBe("cancelled");
  });

  it("two concurrent success calls for the same payment produce exactly one confirmed order", async () => {
    const {order, payment} = await preparedPayment();
    const input = {
      orderId: order.id, paymentId: payment.id,
      amountInPaise: payment.amountInPaise, currency: payment.currency,
    };

    const [a, b] = await Promise.all([
      markPaymentSucceeded(db, input),
      markPaymentSucceeded(db, input),
    ]);

    expect(a.order.status).toBe("confirmed");
    expect(b.order.status).toBe("confirmed");
    const reread = await getOwnedOrder(db, order.userId, order.id);
    expect(reread.status).toBe("confirmed");
    expect(reread.paymentStatus).toBe("paid");
  });

  it("rejects a nonexistent payment (not-found)", async () => {
    const {order} = await setupPendingOrder();
    await expect(markPaymentSucceeded(db, {
      orderId: order.id, paymentId: "no-such-payment", amountInPaise: 1, currency: "INR",
    })).rejects.toMatchObject({code: "not-found"});
  });
});

describe("markPaymentFailed", () => {
  it("marks the payment failed while leaving the order pending_payment", async () => {
    const {order, customerId} = await setupPendingOrder();
    const {payment} = await preparePayment(db, customerId, order.id);

    const result = await markPaymentFailed(db, {orderId: order.id, paymentId: payment.id});

    expect(result.status).toBe("failed");
    const reread = await getOwnedOrder(db, order.userId, order.id);
    expect(reread.status).toBe("pending_payment");
    expect(reread.paymentStatus).toBe("pending");
  });

  it("is idempotent: a repeated failure call does not error", async () => {
    const {order, customerId} = await setupPendingOrder();
    const {payment} = await preparePayment(db, customerId, order.id);

    const first = await markPaymentFailed(db, {orderId: order.id, paymentId: payment.id});
    const second = await markPaymentFailed(db, {orderId: order.id, paymentId: payment.id});

    expect(second.status).toBe("failed");
    expect(second.updatedAt.toMillis()).toBe(first.updatedAt.toMillis());
  });

  it("never moves an already-succeeded payment backward", async () => {
    const {order, customerId} = await setupPendingOrder();
    const {payment} = await preparePayment(db, customerId, order.id);
    await markPaymentSucceeded(db, {
      orderId: order.id, paymentId: payment.id,
      amountInPaise: payment.amountInPaise, currency: payment.currency,
    });

    const result = await markPaymentFailed(db, {orderId: order.id, paymentId: payment.id});

    expect(result.status).toBe("succeeded");
    const reread = await getOwnedOrder(db, order.userId, order.id);
    expect(reread.status).toBe("confirmed");
  });

  it("rejects a nonexistent payment (not-found)", async () => {
    const {order} = await setupPendingOrder();
    await expect(markPaymentFailed(db, {orderId: order.id, paymentId: "no-such-payment"}))
      .rejects.toMatchObject({code: "not-found"});
  });
});

describe("ensureProviderOrder", () => {
  async function preparedPayment(priceInPaise = 12000): Promise<{order: Order; payment: Payment}> {
    const {order, customerId} = await setupPendingOrder(priceInPaise);
    const {payment} = await preparePayment(db, customerId, order.id);
    return {order, payment};
  }

  it("creates exactly one provider order, with amount/currency/receipt from the payment", async () => {
    const {order, payment} = await preparedPayment(7500);
    const {gateway, createOrder} = fakeGateway();

    const result = await ensureProviderOrder(db, order.id, payment.id, gateway);

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledWith({
      amountInPaise: payment.amountInPaise, currency: payment.currency, receipt: payment.id,
    });
    expect(result.created).toBe(true);
    expect(result.payment.provider).toBe("razorpay");
    expect(result.payment.providerOrderId).toBe(result.providerOrderId);
  });

  it("never marks anything paid/confirmed: payment stays pending, order stays pending_payment", async () => {
    const {order, payment} = await preparedPayment();
    const {gateway} = fakeGateway();

    const result = await ensureProviderOrder(db, order.id, payment.id, gateway);

    expect(result.payment.status).toBe("pending");
    const reread = await getOwnedOrder(db, order.userId, order.id);
    expect(reread.status).toBe("pending_payment");
    expect(reread.paymentStatus).toBe("pending");
  });

  it("is idempotent: a repeated call reuses the same providerOrderId without calling the gateway again", async () => {
    const {order, payment} = await preparedPayment();
    const {gateway, createOrder} = fakeGateway();

    const first = await ensureProviderOrder(db, order.id, payment.id, gateway);
    const second = await ensureProviderOrder(db, order.id, payment.id, gateway);

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(second.created).toBe(false);
    expect(second.providerOrderId).toBe(first.providerOrderId);
  });

  it("two concurrent calls settle on exactly one authoritative providerOrderId", async () => {
    const {order, payment} = await preparedPayment();
    const {gateway} = fakeGateway();

    const [a, b] = await Promise.all([
      ensureProviderOrder(db, order.id, payment.id, gateway),
      ensureProviderOrder(db, order.id, payment.id, gateway),
    ]);

    expect(a.providerOrderId).toBe(b.providerOrderId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const stored = await db.collectionGroup("payments").where("orderId", "==", order.id).get();
    expect(stored.size).toBe(1);
    expect(stored.docs[0].data().providerOrderId).toBe(a.providerOrderId);
  });

  it("a provider failure produces a safe unavailable error and leaves the payment retry-able", async () => {
    const {order, payment} = await preparedPayment();
    const {gateway: failingGateway} = fakeGateway({
      createOrder: async () => { throw new PaymentProviderError("Razorpay order creation failed.", {statusCode: 500}); },
    });

    await expect(ensureProviderOrder(db, order.id, payment.id, failingGateway))
      .rejects.toMatchObject({code: "unavailable"});

    const stored = await db.collectionGroup("payments").where("orderId", "==", order.id).get();
    expect(stored.docs[0].data()).toMatchObject({status: "pending", provider: "none"});
    expect(stored.docs[0].data()).not.toHaveProperty("providerOrderId");

    const {gateway: workingGateway} = fakeGateway();
    const retried = await ensureProviderOrder(db, order.id, payment.id, workingGateway);
    expect(retried.created).toBe(true);
  });

  it("rejects a nonexistent payment (not-found)", async () => {
    const {order} = await setupPendingOrder();
    const {gateway} = fakeGateway();
    await expect(ensureProviderOrder(db, order.id, "no-such-payment", gateway))
      .rejects.toMatchObject({code: "not-found"});
  });

  it("rejects a malformed order/payment ID (invalid-argument), never calling the gateway", async () => {
    const {gateway, createOrder} = fakeGateway();
    await expect(ensureProviderOrder(db, "..", "payment-1", gateway))
      .rejects.toMatchObject({code: "invalid-argument"});
    expect(createOrder).not.toHaveBeenCalled();
  });
});

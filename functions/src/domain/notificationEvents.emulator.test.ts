// @vitest-environment node
import {createHmac, randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole, OrganizationMembership} from "../auth/membership";
import type {CreateProviderOrderInput, PaymentProviderGateway} from "../providers/razorpay";
import {businessDateString} from "../time";
import {createMenu} from "./menus";
import {NOTIFICATION_EVENT_TYPES, notificationEventId, type NotificationEventType} from "./notificationEvents";
import {inAppChannel, type NotificationChannel} from "./notificationChannels";
import {processNotificationEvent} from "./notificationProcessor";
import {transitionOrderStatus, type FulfillmentTarget} from "./orderFulfillment";
import {redeemPickup} from "./orderPickup";
import type {OrderStatus} from "./orders";
import {createOrganization} from "./organizations";
import {createOutlet} from "./outlets";
import {
  ensureProviderOrder,
  markPaymentFailed,
  markPaymentSucceeded,
  preparePayment,
  verifyCheckoutPayment,
} from "./payments";
import {derivePickupCredentials} from "./pickupCredential";
import {receiveRazorpayWebhook} from "./razorpayWebhooks";

/**
 * The notification OUTBOX against a REAL Firestore emulator: every order
 * transition writes exactly one `notificationEvents/{orderId}_{type}` event in
 * its own transaction; a repeated, refused or rolled-back transition writes
 * none; and a notification delivery failure leaves the order exactly where the
 * transition put it.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own, like the other order-transition
// emulator suites (see `orderFulfillment.emulator.test.ts`): order lookups here
// are collection-group queries and some tests contend on one order, so they
// must not share the other suites' emulator project.
const PROJECT_ID = "demo-zesto-notification-events";
const KEY_SECRET = "test_key_secret_for_verify";
const PICKUP_SECRET = "test-pickup-secret-0123456789-abcdefghij";

let db: Firestore;

vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this file via " +
      "`npm run test:functions-emulator` (from the repo root), which " +
      "starts the Firestore emulator first.",
    );
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

beforeEach(() => {
  vi.stubEnv("RAZORPAY_KEY_SECRET", KEY_SECRET);
});

// Everything a test creates that a collection-group scan or a later test could
// trip over: orders, their payments, their events, the inboxes they filled.
const orderRefs: DocumentReference[] = [];
const inboxRefs: DocumentReference[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  const refs: DocumentReference[] = [...inboxRefs.splice(0)];
  for (const ref of orderRefs.splice(0)) {
    refs.push(ref, ref.collection("payments").doc(ref.id));
    for (const type of NOTIFICATION_EVENT_TYPES) {
      refs.push(db.collection("notificationEvents").doc(notificationEventId(ref.id, type)));
    }
  }
  const batch = db.batch();
  for (const ref of refs) {
    batch.delete(ref);
  }
  await batch.commit();
});

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

interface OrgFixture {
  organizationId: string;
  outletId: string;
  menuId: string;
}

async function buildOrg(): Promise<OrgFixture> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, {
    name: `Test Org ${randomUUID()}`, slug: `test-org-${randomUUID()}`,
  });
  const outlet = await createOutlet(db, organization.id, ownerId, {
    name: "Main Canteen", slug: `outlet-${randomUUID()}`,
  });
  const now = Date.now();
  const menu = await createMenu(db, organization.id, outlet.id, ownerId, {
    menuDate: businessDateString(new Date(now)),
    title: `Test Menu ${randomUUID()}`,
    orderingOpensAt: Timestamp.fromDate(new Date(now - 2 * 60 * 60 * 1000)),
    orderingClosesAt: Timestamp.fromDate(new Date(now + 60 * 60 * 1000)),
    pickupStartsAt: Timestamp.fromDate(new Date(now + 24 * 60 * 60 * 1000)),
    pickupEndsAt: Timestamp.fromDate(new Date(now + 28 * 60 * 60 * 1000)),
  });
  return {organizationId: organization.id, outletId: outlet.id, menuId: menu.id};
}

function staff(org: OrgFixture, role: OrganizationMemberRole = "staff"): OrganizationMembership {
  return {userId: freshUserId(), organizationId: org.organizationId, role, status: "active"};
}

interface SeededOrder {
  id: string;
  ref: DocumentReference;
  customerId: string;
  org: OrgFixture;
}

const CREATED_AT = Timestamp.fromDate(new Date("2026-09-01T06:00:00Z"));

async function seedOrder(org: OrgFixture, status: OrderStatus): Promise<SeededOrder> {
  const ref = db
    .collection("organizations").doc(org.organizationId)
    .collection("outlets").doc(org.outletId)
    .collection("menus").doc(org.menuId)
    .collection("orders").doc();
  orderRefs.push(ref);
  const customerId = freshUserId();
  await ref.create({
    id: ref.id,
    userId: customerId,
    organizationId: org.organizationId,
    outletId: org.outletId,
    menuId: org.menuId,
    status,
    paymentStatus: status === "pending_payment" ? "pending" : "paid",
    currency: "INR",
    subtotalInPaise: 10000,
    totalInPaise: 10000,
    items: [{itemId: "seed-item", name: "Seed Dish", priceInPaise: 5000, quantity: 2, lineTotalInPaise: 10000}],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  inboxRefs.push(
    ...NOTIFICATION_EVENT_TYPES.flatMap((type) => (["customer", "org"] as const).map((audience) =>
      db.collection("users").doc(customerId).collection("notifications")
        .doc(`${ref.id}_${type}.${audience}`))),
  );
  return {id: ref.id, ref, customerId, org};
}

async function orderData(order: SeededOrder): Promise<Record<string, unknown>> {
  return (await order.ref.get()).data() ?? {};
}

async function paymentData(order: SeededOrder): Promise<Record<string, unknown> | undefined> {
  return (await order.ref.collection("payments").doc(order.id).get()).data();
}

async function eventFor(order: SeededOrder, type: NotificationEventType): Promise<Record<string, unknown> | undefined> {
  return (await db.collection("notificationEvents").doc(notificationEventId(order.id, type)).get()).data();
}

/** The types of every event recorded for the order, in no particular order. */
async function eventTypesFor(order: SeededOrder): Promise<string[]> {
  const found: string[] = [];
  for (const type of NOTIFICATION_EVENT_TYPES) {
    if ((await db.collection("notificationEvents").doc(notificationEventId(order.id, type)).get()).exists) {
      found.push(type);
    }
  }
  return found;
}

/** A pending-payment order with a prepared payment that already has a (fake-gateway) provider order. */
async function seedPayableOrder(org: OrgFixture): Promise<SeededOrder & {providerOrderId: string}> {
  const order = await seedOrder(org, "pending_payment");
  await preparePayment(db, order.customerId, order.id);
  const providerOrderId = `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const gateway: PaymentProviderGateway = {
    createOrder: async (input: CreateProviderOrderInput) => ({
      id: providerOrderId, amountInPaise: input.amountInPaise, currency: input.currency, receipt: input.receipt,
      status: "created",
    }),
    fetchOrder: async (id: string) => ({id, amountInPaise: 0, currency: "INR", status: "created"}),
  };
  await ensureProviderOrder(db, order.id, order.id, gateway);
  return {...order, providerOrderId};
}

function confirm(order: SeededOrder, paymentId = "pay_Test1") {
  return markPaymentSucceeded(db, {
    orderId: order.id, paymentId: order.id, amountInPaise: 10000, currency: "INR", providerPaymentId: paymentId,
  });
}

function transition(order: SeededOrder, to: FulfillmentTarget, who: OrganizationMembership = staff(order.org)) {
  return transitionOrderStatus(db, {membership: who, orderId: order.id, to});
}

function pickUp(order: SeededOrder, who: OrganizationMembership = staff(order.org)) {
  return redeemPickup(db, {
    membership: who,
    credential: derivePickupCredentials(PICKUP_SECRET, order.id).qrPayload,
    getSecret: () => PICKUP_SECRET,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}

/**
 * A Firestore whose transactions run the REAL transition body — including its
 * order write and its outbox write — and then fail before committing, as when
 * Firestore gives up on a contended transaction.
 */
function dbThatRollsBackEveryTransaction(): Firestore {
  return new Proxy(db, {
    get(target, property) {
      if (property === "runTransaction") {
        return async (body: (tx: unknown) => Promise<unknown>) =>
          target.runTransaction(async (tx) => {
            await body(tx);
            throw new Error("forced rollback after the transition body ran");
          });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("order_confirmed (markPaymentSucceeded)", () => {
  it("1. a confirmed order produces exactly one event, with only the order's coordinates", async () => {
    const order = await seedPayableOrder(await buildOrg());

    const result = await confirm(order);

    expect(result.order.status).toBe("confirmed");
    expect(await eventTypesFor(order)).toEqual(["order_confirmed"]);
    const event = await eventFor(order, "order_confirmed");
    expect(event).toEqual({
      id: `${order.id}_order_confirmed`,
      type: "order_confirmed",
      orderId: order.id,
      organizationId: order.org.organizationId,
      outletId: order.org.outletId,
      menuId: order.org.menuId,
      customerUserId: order.customerId,
      occurredAt: result.order.updatedAt,
      status: "pending",
      attempts: 0,
    });
  });

  it("2. a replay of the same payment confirmation produces no second event", async () => {
    const order = await seedPayableOrder(await buildOrg());
    await confirm(order);
    const first = await eventFor(order, "order_confirmed");

    await confirm(order);
    await confirm(order, "pay_ReplayedDifferentReference");

    expect(await eventTypesFor(order)).toEqual(["order_confirmed"]);
    expect(await eventFor(order, "order_confirmed")).toEqual(first);
  });

  it("2. a repeated Checkout verification produces no second event", async () => {
    const order = await seedPayableOrder(await buildOrg());
    const paymentId = "pay_Verify1";
    const verification = {
      razorpayOrderId: order.providerOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: createHmac("sha256", KEY_SECRET).update(`${order.providerOrderId}|${paymentId}`).digest("hex"),
    };

    await verifyCheckoutPayment(db, order.customerId, order.id, verification);
    const first = await eventFor(order, "order_confirmed");
    await verifyCheckoutPayment(db, order.customerId, order.id, verification);
    await verifyCheckoutPayment(db, order.customerId, order.id, verification);

    expect(await eventTypesFor(order)).toEqual(["order_confirmed"]);
    expect(await eventFor(order, "order_confirmed")).toEqual(first);
  });

  it("2. webhook replays — the same delivery and a different delivery for the same payment — produce one event", async () => {
    const order = await seedPayableOrder(await buildOrg());
    const body = Buffer.from(JSON.stringify({
      event: "payment.captured",
      payload: {payment: {entity: {
        id: "pay_Hook1", order_id: order.providerOrderId, amount: 10000, currency: "INR", status: "captured",
      }}},
    }), "utf8");
    const eventHeader = randomUUID().replace(/-/g, "").slice(0, 16);

    await receiveRazorpayWebhook(db, {rawBody: body, eventIdHeader: eventHeader});
    const first = await eventFor(order, "order_confirmed");
    const duplicate = await receiveRazorpayWebhook(db, {rawBody: body, eventIdHeader: eventHeader});
    const redelivered = await receiveRazorpayWebhook(db, {rawBody: body, eventIdHeader: `${eventHeader}-second`});

    expect(duplicate.kind).toBe("duplicate");
    expect(redelivered).toMatchObject({kind: "processed", outcome: "success_noop_already_succeeded"});
    expect(first).toBeDefined();
    expect(await eventTypesFor(order)).toEqual(["order_confirmed"]);
    expect(await eventFor(order, "order_confirmed")).toEqual(first);

    await db.collection("razorpayWebhookEvents").doc(`evt_${eventHeader}`).delete();
    await db.collection("razorpayWebhookEvents").doc(`evt_${eventHeader}-second`).delete();
  });

  it("a refused confirmation (amount mismatch) or a failed payment produces no event", async () => {
    const order = await seedPayableOrder(await buildOrg());

    const mismatch = await rejectionOf(markPaymentSucceeded(db, {
      orderId: order.id, paymentId: order.id, amountInPaise: 1, currency: "INR",
    }));
    await markPaymentFailed(db, {orderId: order.id, paymentId: order.id});

    expect(mismatch.code).toBe("failed-precondition");
    expect(await eventTypesFor(order)).toEqual([]);
    expect((await orderData(order)).status).toBe("pending_payment");
  });

  it("a failed payment that later succeeds produces the one event then", async () => {
    const order = await seedPayableOrder(await buildOrg());
    await markPaymentFailed(db, {orderId: order.id, paymentId: order.id});

    await confirm(order);

    expect(await eventTypesFor(order)).toEqual(["order_confirmed"]);
  });
});

describe("order_preparing / order_ready / order_completed (transitionOrderStatus)", () => {
  it.each([
    ["3/4. preparing", "confirmed", "preparing", "order_preparing"],
    ["5/6. ready", "preparing", "ready", "order_ready"],
    ["9/10. completed", "picked_up", "completed", "order_completed"],
  ] as const)("%s: one event on the transition, none on a repeat", async (_label, from, to, type) => {
    const order = await seedOrder(await buildOrg(), from);

    const first = await transition(order, to);
    const recorded = await eventFor(order, type);
    const repeat = await transition(order, to, staff(order.org, "manager"));
    const repeatAgain = await transition(order, to);

    expect(first.changed).toBe(true);
    expect(repeat.changed).toBe(false);
    expect(repeatAgain.changed).toBe(false);
    expect(await eventTypesFor(order)).toEqual([type]);
    expect(await eventFor(order, type)).toEqual(recorded);
    expect(recorded).toMatchObject({
      id: `${order.id}_${type}`,
      type,
      orderId: order.id,
      organizationId: order.org.organizationId,
      outletId: order.org.outletId,
      menuId: order.org.menuId,
      customerUserId: order.customerId,
      status: "pending",
      attempts: 0,
      occurredAt: first.order.updatedAt,
    });
  });

  it("a refused transition (wrong state, unpaid, another organization's order) records nothing", async () => {
    const org = await buildOrg();
    const confirmed = await seedOrder(org, "confirmed");
    const pending = await seedOrder(org, "pending_payment");
    const other = await buildOrg();

    const skipAhead = await rejectionOf(transition(confirmed, "ready"));
    const unpaid = await rejectionOf(transition(pending, "preparing"));
    const foreign = await rejectionOf(transitionOrderStatus(db, {
      membership: staff(other), orderId: confirmed.id, to: "preparing",
    }));
    const notAMember = await rejectionOf(transitionOrderStatus(db, {
      membership: {...staff(org), status: "revoked"}, orderId: confirmed.id, to: "preparing",
    }));

    expect(skipAhead.code).toBe("aborted");
    expect(unpaid.code).toBe("aborted");
    expect(foreign.code).toBe("not-found");
    expect(notAMember.code).toBe("permission-denied");
    expect(await eventTypesFor(confirmed)).toEqual([]);
    expect(await eventTypesFor(pending)).toEqual([]);
  });

  it("two staff pressing the same button at once record exactly one event", async () => {
    const order = await seedOrder(await buildOrg(), "confirmed");

    const results = await Promise.all([transition(order, "preparing"), transition(order, "preparing")]);

    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(await eventTypesFor(order)).toEqual(["order_preparing"]);
  }, 30000);
});

describe("order_picked_up (redeemPickup)", () => {
  it("7. a pickup produces exactly one event", async () => {
    const order = await seedOrder(await buildOrg(), "ready");

    const result = await pickUp(order);

    expect(await eventTypesFor(order)).toEqual(["order_picked_up"]);
    expect(await eventFor(order, "order_picked_up")).toMatchObject({
      id: `${order.id}_order_picked_up`,
      type: "order_picked_up",
      customerUserId: order.customerId,
      organizationId: order.org.organizationId,
      occurredAt: result.order.updatedAt,
      status: "pending",
      attempts: 0,
    });
  });

  it("8. a repeated pickup is refused and produces no second event", async () => {
    const order = await seedOrder(await buildOrg(), "ready");
    await pickUp(order);
    const first = await eventFor(order, "order_picked_up");

    const again = await rejectionOf(pickUp(order, staff(order.org, "manager")));

    expect(again).toMatchObject({code: "aborted", message: "This order has already been picked up."});
    expect(await eventTypesFor(order)).toEqual(["order_picked_up"]);
    expect(await eventFor(order, "order_picked_up")).toEqual(first);
  });

  it("a refused pickup (not ready, wrong proof, other organization) records nothing", async () => {
    const org = await buildOrg();
    const preparing = await seedOrder(org, "preparing");
    const ready = await seedOrder(org, "ready");

    const early = await rejectionOf(pickUp(preparing));
    const forged = await rejectionOf(redeemPickup(db, {
      membership: staff(org), credential: `ZP1.${ready.id}.${"A".repeat(22)}`, getSecret: () => PICKUP_SECRET,
    }));
    const foreign = await rejectionOf(pickUp(ready, staff(await buildOrg())));

    expect(early.code).toBe("aborted");
    expect(forged.code).toBe("not-found");
    expect(foreign.code).toBe("not-found");
    expect(await eventTypesFor(preparing)).toEqual([]);
    expect(await eventTypesFor(ready)).toEqual([]);
  });
});

describe("the whole lifecycle", () => {
  it("records one event per transition, five in all, ending with the quiet order_completed", async () => {
    const order = await seedPayableOrder(await buildOrg());

    await confirm(order);
    await transition(order, "preparing");
    await transition(order, "ready");
    await pickUp(order);
    await transition(order, "completed");

    expect((await eventTypesFor(order)).sort()).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
    expect((await orderData(order)).status).toBe("completed");
  });
});

describe("11. a rolled-back transition leaves no event", () => {
  it("payment confirmation", async () => {
    const order = await seedPayableOrder(await buildOrg());

    await expect(markPaymentSucceeded(dbThatRollsBackEveryTransaction(), {
      orderId: order.id, paymentId: order.id, amountInPaise: 10000, currency: "INR",
    })).rejects.toThrow("forced rollback");

    expect(await eventTypesFor(order)).toEqual([]);
    expect(await orderData(order)).toMatchObject({status: "pending_payment", paymentStatus: "pending"});
    expect(await paymentData(order)).toMatchObject({status: "pending"});
  });

  it.each(["preparing", "ready", "completed"] as const)("fulfillment into %s", async (to) => {
    const from = {preparing: "confirmed", ready: "preparing", completed: "picked_up"}[to] as OrderStatus;
    const order = await seedOrder(await buildOrg(), from);

    await expect(transitionOrderStatus(dbThatRollsBackEveryTransaction(), {
      membership: staff(order.org), orderId: order.id, to,
    })).rejects.toThrow("forced rollback");

    expect(await eventTypesFor(order)).toEqual([]);
    expect((await orderData(order)).status).toBe(from);
  });

  it("pickup", async () => {
    const order = await seedOrder(await buildOrg(), "ready");

    await expect(redeemPickup(dbThatRollsBackEveryTransaction(), {
      membership: staff(order.org),
      credential: derivePickupCredentials(PICKUP_SECRET, order.id).qrPayload,
      getSecret: () => PICKUP_SECRET,
    })).rejects.toThrow("forced rollback");

    expect(await eventTypesFor(order)).toEqual([]);
    expect((await orderData(order)).status).toBe("ready");
  });

  it("and the order can still make the same transition afterwards, recording its event then", async () => {
    const order = await seedOrder(await buildOrg(), "confirmed");
    await expect(transitionOrderStatus(dbThatRollsBackEveryTransaction(), {
      membership: staff(order.org), orderId: order.id, to: "preparing",
    })).rejects.toThrow("forced rollback");

    await transition(order, "preparing");

    expect(await eventTypesFor(order)).toEqual(["order_preparing"]);
  });
});

describe("12. a notification delivery failure leaves the order exactly where the transition put it", () => {
  const failingChannel: NotificationChannel = {
    name: "in_app",
    async deliver() {
      throw new Error("14 UNAVAILABLE: the inbox is down");
    },
  };

  const lifecycle: Array<{
    label: string;
    type: NotificationEventType;
    expectStatus: OrderStatus;
    run: (org: OrgFixture) => Promise<SeededOrder>;
  }> = [
    {
      label: "payment succeeds -> confirmed",
      type: "order_confirmed",
      expectStatus: "confirmed",
      run: async (org) => {
        const order = await seedPayableOrder(org);
        await confirm(order);
        return order;
      },
    },
    {
      label: "confirmed -> preparing",
      type: "order_preparing",
      expectStatus: "preparing",
      run: async (org) => {
        const order = await seedOrder(org, "confirmed");
        await transition(order, "preparing");
        return order;
      },
    },
    {
      label: "preparing -> ready",
      type: "order_ready",
      expectStatus: "ready",
      run: async (org) => {
        const order = await seedOrder(org, "preparing");
        await transition(order, "ready");
        return order;
      },
    },
    {
      label: "ready -> picked_up",
      type: "order_picked_up",
      expectStatus: "picked_up",
      run: async (org) => {
        const order = await seedOrder(org, "ready");
        await pickUp(order);
        return order;
      },
    },
    {
      label: "picked_up -> completed",
      type: "order_completed",
      expectStatus: "completed",
      run: async (org) => {
        const order = await seedOrder(org, "picked_up");
        await transition(order, "completed");
        return order;
      },
    },
  ];

  it.each(lifecycle)("$label", async ({type, expectStatus, run}) => {
    const order = await run(await buildOrg());
    const eventId = notificationEventId(order.id, type);

    // Processing is a separate step after the commit. Where the policy shows
    // nothing (order_completed) it never reaches a channel at all.
    const outcome = await processNotificationEvent(db, eventId, {channels: [failingChannel]})
      .catch((error: unknown) => error);

    if (type === "order_completed") {
      expect(outcome).toMatchObject({kind: "processed", delivered: 0});
    } else {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("the inbox is down");
      expect(await eventFor(order, type)).toMatchObject({status: "pending", attempts: 1});
    }
    expect((await orderData(order)).status).toBe(expectStatus);
    expect((await orderData(order)).paymentStatus).toBe("paid");
    if (type === "order_confirmed") {
      expect(await paymentData(order)).toMatchObject({status: "succeeded"});
    }
  });

  it("the order can still make its next transition while the earlier event is stuck failing", async () => {
    const org = await buildOrg();
    const order = await seedOrder(org, "confirmed");
    await transition(order, "preparing");
    await processNotificationEvent(db, notificationEventId(order.id, "order_preparing"), {channels: [failingChannel]})
      .catch(() => undefined);

    const next = await transition(order, "ready");

    expect(next.changed).toBe(true);
    expect((await orderData(order)).status).toBe("ready");
    expect((await eventTypesFor(order)).sort()).toEqual(["order_preparing", "order_ready"]);
  });

  it("and the real channel delivers it later, once it works again", async () => {
    const order = await seedOrder(await buildOrg(), "confirmed");
    await transition(order, "preparing");
    const eventId = notificationEventId(order.id, "order_preparing");
    await processNotificationEvent(db, eventId, {channels: [failingChannel]}).catch(() => undefined);

    const retry = await processNotificationEvent(db, eventId, {channels: [inAppChannel]});

    expect(retry).toEqual({kind: "processed", delivered: 1});
    expect(await eventFor(order, "order_preparing")).toMatchObject({status: "processed", attempts: 2});
  });
});

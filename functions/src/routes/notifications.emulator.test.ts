// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, getFirestore, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {OrganizationMemberRole} from "../auth/membership";
import type {SessionValidator} from "../auth/session";
import {
  customerScope,
  notificationExpiry,
  notificationId,
  notificationsCollection,
  organizationScope,
  type Notification,
} from "../domain/notifications";
import type {NotificationType} from "../domain/notificationPolicy";
import {createOrganization} from "../domain/organizations";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult} from "../http/types";
import {createNotificationRoutes} from "./notifications";

/**
 * The notification inbox API against a REAL Firestore emulator: real inbox and
 * membership documents, real ordering/pagination/unread queries, and the
 * isolation boundaries — one user from another, one scope from another, one
 * organization from another, and a member from their own lost membership.
 * Descope stays faked: a session token IS its user id.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

// A Firestore project of this file's own (see `orderFulfillment.emulator.test.ts`).
const PROJECT_ID = "demo-zesto-notification-routes";

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
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

const created: DocumentReference[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  const refs = created.splice(0);
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
});

/** A session token is simply the user id it stands for. */
const validator: SessionValidator = {
  validateSession: async (token: string) => ({jwt: token, token: {sub: token, aud: ["P-test"]}}),
} as unknown as SessionValidator;

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

async function call(
  userId: string,
  method: "GET" | "POST",
  path: string,
  query: Record<string, unknown> = {},
): Promise<ApiResult> {
  return handleRequest(
    createNotificationRoutes({db, validator}),
    {method, path, headers: {authorization: `Bearer ${userId}`}, query, body: undefined},
    () => {},
  );
}

function dataOf(result: ApiResult): Record<string, unknown> {
  if (result.kind !== "success") {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.data as Record<string, unknown>;
}

interface Page {
  notifications: Array<{id: string; readAt: string | null; type: string}>;
  nextCursor: string | null;
}

async function listPage(userId: string, path: string, query: Record<string, unknown> = {}): Promise<Page> {
  return dataOf(await call(userId, "GET", path, query)) as unknown as Page;
}

async function unreadCount(userId: string, path: string): Promise<number> {
  return dataOf(await call(userId, "GET", `${path}/unread-count`)).unreadCount as number;
}

let counter = 0;

interface SeedOptions {
  scope?: string;
  createdAt?: Timestamp;
  readAt?: Timestamp | null;
  type?: NotificationType;
  id?: string;
}

/** Writes one notification into `userId`'s inbox, as the processor would have. */
async function seed(userId: string, options: SeedOptions = {}): Promise<Notification> {
  const scope = options.scope ?? customerScope();
  const audience = scope === "customer" ? "customer" : "org";
  const eventId = options.id ?? `order${++counter}_${randomUUID().slice(0, 8)}_order_ready`;
  const createdAt = options.createdAt ?? Timestamp.fromMillis(Date.UTC(2026, 9, 5, 10, 0, 0) + counter * 1000);
  const notification: Notification = {
    id: notificationId(eventId, audience),
    type: options.type ?? (audience === "customer" ? "order_ready" : "new_order"),
    scope,
    title: audience === "customer" ? "Ready for pickup" : "New order",
    body: audience === "customer" ? "Your order from Main Canteen is ready for pickup." : "New order received from Main Canteen.",
    orderId: "order-1",
    organizationId: "org-1",
    outletId: "outlet-1",
    eventId,
    createdAt,
    readAt: options.readAt ?? null,
    expiresAt: notificationExpiry(createdAt),
  };
  const ref = notificationsCollection(db, userId).doc(notification.id);
  created.push(ref);
  await ref.set(notification);
  return notification;
}

async function seedMany(userId: string, count: number, options: SeedOptions = {}): Promise<Notification[]> {
  const out: Notification[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await seed(userId, options));
  }
  return out;
}

async function stored(userId: string, id: string): Promise<Record<string, unknown>> {
  return (await notificationsCollection(db, userId).doc(id).get()).data() ?? {};
}

async function buildOrg(): Promise<{organizationId: string; ownerId: string}> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, {
    name: `Test Org ${randomUUID()}`, slug: `test-org-${randomUUID()}`,
  });
  created.push(db.collection("organizations").doc(organization.id).collection("members").doc(ownerId));
  return {organizationId: organization.id, ownerId};
}

async function addMember(
  organizationId: string,
  role: OrganizationMemberRole,
  status: "active" | "invited" | "revoked" = "active",
  userId = freshUserId(),
): Promise<string> {
  const ref = db.collection("organizations").doc(organizationId).collection("members").doc(userId);
  created.push(ref);
  await ref.set({userId, organizationId, role, status, createdAt: Timestamp.now()});
  return userId;
}

const CUSTOMER = "/notifications";
const orgPath = (organizationId: string) => `/organizations/${organizationId}/notifications`;

describe("GET /notifications — pagination", () => {
  it("18. lists newest first, 20 to a page by default, and the cursor chain covers every notification once", async () => {
    const user = freshUserId();
    const seeded = await seedMany(user, 25);
    const newestFirst = [...seeded].reverse().map((notification) => notification.id);

    const first = await listPage(user, CUSTOMER);
    const second = await listPage(user, CUSTOMER, {cursor: first.nextCursor});

    expect(first.notifications).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    expect(second.notifications).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect([...first.notifications, ...second.notifications].map((n) => n.id)).toEqual(newestFirst);
  });

  it("honours a smaller limit and walks the whole list with no gaps or repeats", async () => {
    const user = freshUserId();
    const seeded = await seedMany(user, 7);

    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await listPage(user, CUSTOMER, {limit: "3", ...(cursor ? {cursor} : {})});
      ids.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(ids).toEqual([...seeded].reverse().map((notification) => notification.id));
  });

  it("never returns more than 50 whatever limit is asked for", async () => {
    const user = freshUserId();
    await seedMany(user, 55);

    const page = await listPage(user, CUSTOMER, {limit: "1000"});

    expect(page.notifications).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
  }, 30000);

  it("pages correctly through notifications created at the very same instant", async () => {
    const user = freshUserId();
    const at = Timestamp.fromMillis(Date.UTC(2026, 9, 5, 12, 0, 0));
    const seeded = await seedMany(user, 6, {createdAt: at});

    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await listPage(user, CUSTOMER, {limit: "2", ...(cursor ? {cursor} : {})});
      ids.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(ids).size).toBe(6);
    expect([...ids].sort()).toEqual(seeded.map((notification) => notification.id).sort());
  });

  it("an empty inbox is an empty page, not an error", async () => {
    expect(await listPage(freshUserId(), CUSTOMER)).toEqual({notifications: [], nextCursor: null});
  });

  it("refuses a malformed cursor (400)", async () => {
    const result = await call(freshUserId(), "GET", CUSTOMER, {cursor: "garbage!"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("returns only the client-facing fields", async () => {
    const user = freshUserId();
    const [only] = await seedMany(user, 1);

    const page = await listPage(user, CUSTOMER);

    expect(page.notifications[0]).toEqual({
      id: only.id,
      type: "order_ready",
      title: "Ready for pickup",
      body: "Your order from Main Canteen is ready for pickup.",
      orderId: "order-1",
      createdAt: only.createdAt.toDate().toISOString(),
      readAt: null,
    });
  });
});

describe("unread filtering and counting", () => {
  it("19. unread=true lists only unread notifications, newest first; unread=false lists everything", async () => {
    const user = freshUserId();
    const a = await seed(user);
    const b = await seed(user, {readAt: Timestamp.now()});
    const c = await seed(user);
    const d = await seed(user, {readAt: Timestamp.now()});

    const unread = await listPage(user, CUSTOMER, {unread: "true"});
    const all = await listPage(user, CUSTOMER, {unread: "false"});

    expect(unread.notifications.map((n) => n.id)).toEqual([c.id, a.id]);
    expect(unread.notifications.every((n) => n.readAt === null)).toBe(true);
    expect(all.notifications.map((n) => n.id)).toEqual([d.id, c.id, b.id, a.id]);
  });

  it("the unread filter paginates by cursor too", async () => {
    const user = freshUserId();
    const unreadOnes: string[] = [];
    for (let i = 0; i < 5; i++) {
      unreadOnes.push((await seed(user)).id);
      await seed(user, {readAt: Timestamp.now()});
    }

    const first = await listPage(user, CUSTOMER, {unread: "true", limit: "3"});
    const second = await listPage(user, CUSTOMER, {unread: "true", limit: "3", cursor: first.nextCursor});

    expect([...first.notifications, ...second.notifications].map((n) => n.id)).toEqual([...unreadOnes].reverse());
    expect(second.nextCursor).toBeNull();
  });

  it("the unread count counts only this user's unread notifications in this scope", async () => {
    const user = freshUserId();
    const org = await buildOrg();
    await seedMany(user, 3);
    await seed(user, {readAt: Timestamp.now()});
    await seedMany(user, 2, {scope: organizationScope(org.organizationId)});
    await seedMany(freshUserId(), 4);

    expect(await unreadCount(user, CUSTOMER)).toBe(3);
    const staffMember = await addMember(org.organizationId, "staff");
    await seedMany(staffMember, 2, {scope: organizationScope(org.organizationId)});
    expect(await unreadCount(staffMember, orgPath(org.organizationId))).toBe(2);
    expect(await unreadCount(staffMember, CUSTOMER)).toBe(0);
  });

  it("the unread count stops at 100", async () => {
    const user = freshUserId();
    const batch = db.batch();
    for (let i = 0; i < 105; i++) {
      const eventId = `cap${i}_${randomUUID().slice(0, 8)}_order_ready`;
      const createdAt = Timestamp.fromMillis(Date.UTC(2026, 9, 5, 10, 0, 0) + i * 1000);
      const ref = notificationsCollection(db, user).doc(notificationId(eventId, "customer"));
      created.push(ref);
      batch.set(ref, {
        id: ref.id, type: "order_ready", scope: "customer", title: "t", body: "b", orderId: "o",
        organizationId: "org-1", outletId: "outlet-1", eventId, createdAt, readAt: null,
        expiresAt: notificationExpiry(createdAt),
      });
    }
    await batch.commit();

    expect(await unreadCount(user, CUSTOMER)).toBe(100);
  }, 30000);
});

describe("POST /notifications/:id/read", () => {
  it("20. marks one notification read, leaving every other untouched", async () => {
    const user = freshUserId();
    const target = await seed(user);
    const bystander = await seed(user);

    const result = await call(user, "POST", `${CUSTOMER}/${target.id}/read`);

    const {notification} = dataOf(result) as {notification: {id: string; readAt: string | null}};
    expect(result).toMatchObject({kind: "success", status: 200});
    expect(notification.id).toBe(target.id);
    expect(notification.readAt).toEqual(expect.any(String));
    expect((await stored(user, target.id)).readAt).toBeInstanceOf(Timestamp);
    expect((await stored(user, bystander.id)).readAt).toBeNull();
    expect(await unreadCount(user, CUSTOMER)).toBe(1);
  });

  it("is idempotent: reading it again is a 200 that keeps the ORIGINAL readAt", async () => {
    const user = freshUserId();
    const target = await seed(user);
    await call(user, "POST", `${CUSTOMER}/${target.id}/read`);
    const firstReadAt = (await stored(user, target.id)).readAt as Timestamp;
    await new Promise((resolve) => setTimeout(resolve, 15));

    const again = await call(user, "POST", `${CUSTOMER}/${target.id}/read`);

    expect(again).toMatchObject({kind: "success", status: 200});
    expect((await stored(user, target.id)).readAt).toEqual(firstReadAt);
  });

  it("a notification that was already read keeps its readAt", async () => {
    const user = freshUserId();
    const readAt = Timestamp.fromMillis(Date.UTC(2026, 9, 1));
    const target = await seed(user, {readAt});

    const result = await call(user, "POST", `${CUSTOMER}/${target.id}/read`);

    expect((dataOf(result).notification as {readAt: string}).readAt).toBe(readAt.toDate().toISOString());
    expect((await stored(user, target.id)).readAt).toEqual(readAt);
  });

  it("a notification that does not exist is a 404", async () => {
    const result = await call(freshUserId(), "POST", `${CUSTOMER}/no-such_order_ready.customer/read`);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("a malformed notification id is a 400", async () => {
    const result = await call(freshUserId(), "POST", `${CUSTOMER}/__x__/read`);

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });
});

describe("POST /notifications/read-all", () => {
  it("21. marks every unread notification in the caller's scope read, and only those", async () => {
    const user = freshUserId();
    const org = await buildOrg();
    const alreadyRead = await seed(user, {readAt: Timestamp.fromMillis(Date.UTC(2026, 9, 1))});
    const unread = await seedMany(user, 4);
    const otherScope = await seed(user, {scope: organizationScope(org.organizationId)});
    const otherUser = await seed(freshUserId());

    const result = await call(user, "POST", `${CUSTOMER}/read-all`);

    expect(dataOf(result)).toEqual({updated: 4, hasMore: false});
    for (const notification of unread) {
      expect((await stored(user, notification.id)).readAt).toBeInstanceOf(Timestamp);
    }
    expect((await stored(user, alreadyRead.id)).readAt).toEqual(Timestamp.fromMillis(Date.UTC(2026, 9, 1)));
    expect((await stored(user, otherScope.id)).readAt).toBeNull();
    expect(await unreadCount(user, CUSTOMER)).toBe(0);
    expect(otherUser.readAt).toBeNull();
  });

  it("is a harmless no-op on an empty or fully read inbox", async () => {
    const user = freshUserId();

    expect(dataOf(await call(user, "POST", `${CUSTOMER}/read-all`))).toEqual({updated: 0, hasMore: false});
    await seed(user, {readAt: Timestamp.now()});
    expect(dataOf(await call(user, "POST", `${CUSTOMER}/read-all`))).toEqual({updated: 0, hasMore: false});
  });

  it("handles more than one batch (450 unread)", async () => {
    const user = freshUserId();
    for (let i = 0; i < 450; i += 150) {
      const batch = db.batch();
      for (let j = i; j < i + 150; j++) {
        const eventId = `bulk${j}_${randomUUID().slice(0, 8)}_order_ready`;
        const createdAt = Timestamp.fromMillis(Date.UTC(2026, 9, 5, 10, 0, 0) + j * 1000);
        const ref = notificationsCollection(db, user).doc(notificationId(eventId, "customer"));
        created.push(ref);
        batch.set(ref, {
          id: ref.id, type: "order_ready", scope: "customer", title: "t", body: "b", orderId: "o",
          organizationId: "org-1", outletId: "outlet-1", eventId, createdAt, readAt: null,
          expiresAt: notificationExpiry(createdAt),
        });
      }
      await batch.commit();
    }

    const result = await call(user, "POST", `${CUSTOMER}/read-all`);

    expect(dataOf(result)).toEqual({updated: 450, hasMore: false});
    expect(await unreadCount(user, CUSTOMER)).toBe(0);
  }, 60000);
});

describe("isolation between users", () => {
  it("22. another user cannot mark my notification read — it is a 404, and mine stays unread", async () => {
    const me = freshUserId();
    const intruder = freshUserId();
    const mine = await seed(me);

    const result = await call(intruder, "POST", `${CUSTOMER}/${mine.id}/read`);

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
    expect((await stored(me, mine.id)).readAt).toBeNull();
  });

  it("the 404 for someone else's notification is identical to the 404 for one that does not exist", async () => {
    const me = freshUserId();
    const intruder = freshUserId();
    const mine = await seed(me);

    const theirs = await call(intruder, "POST", `${CUSTOMER}/${mine.id}/read`);
    const missing = await call(intruder, "POST", `${CUSTOMER}/${notificationId("nothing_order_ready", "customer")}/read`);

    expect(theirs).toEqual(missing);
  });

  it("22. listing, counting and read-all see only the caller's own inbox, whatever the request says", async () => {
    const me = freshUserId();
    const other = freshUserId();
    await seedMany(me, 2);
    const theirs = await seedMany(other, 3);

    const page = await listPage(me, CUSTOMER, {userId: other, scope: "customer", organizationId: "x"});
    const count = dataOf(await call(me, "GET", `${CUSTOMER}/unread-count`, {userId: other}));
    await call(me, "POST", `${CUSTOMER}/read-all`, {userId: other});

    expect(page.notifications).toHaveLength(2);
    expect(page.notifications.map((n) => n.id)).not.toContain(theirs[0].id);
    expect(count.unreadCount).toBe(2);
    for (const notification of theirs) {
      expect((await stored(other, notification.id)).readAt).toBeNull();
    }
  });
});

describe("isolation between scopes", () => {
  it("the customer routes never show, count or mark organization notifications — and vice versa", async () => {
    const org = await buildOrg();
    const user = await addMember(org.organizationId, "staff");
    const mineAsCustomer = await seed(user);
    const mineAsStaff = await seed(user, {scope: organizationScope(org.organizationId)});

    const customerPage = await listPage(user, CUSTOMER);
    const orgPage = await listPage(user, orgPath(org.organizationId));
    const wrongWayCustomer = await call(user, "POST", `${CUSTOMER}/${mineAsStaff.id}/read`);
    const wrongWayOrg = await call(user, "POST", `${orgPath(org.organizationId)}/${mineAsCustomer.id}/read`);

    expect(customerPage.notifications.map((n) => n.id)).toEqual([mineAsCustomer.id]);
    expect(orgPage.notifications.map((n) => n.id)).toEqual([mineAsStaff.id]);
    expect(wrongWayCustomer).toMatchObject({kind: "error", status: 404});
    expect(wrongWayOrg).toMatchObject({kind: "error", status: 404});
    expect((await stored(user, mineAsStaff.id)).readAt).toBeNull();
    expect((await stored(user, mineAsCustomer.id)).readAt).toBeNull();
  });

  it("read-all on one scope leaves the other scope's notifications unread", async () => {
    const org = await buildOrg();
    const user = await addMember(org.organizationId, "manager");
    await seedMany(user, 2);
    await seedMany(user, 3, {scope: organizationScope(org.organizationId)});

    await call(user, "POST", `${orgPath(org.organizationId)}/read-all`);

    expect(await unreadCount(user, orgPath(org.organizationId))).toBe(0);
    expect(await unreadCount(user, CUSTOMER)).toBe(2);
  });
});

describe("organization routes — authorization", () => {
  it.each(["owner", "manager", "staff"] as const)("an active %s may read their organization inbox", async (role) => {
    const org = await buildOrg();
    const user = await addMember(org.organizationId, role);
    const mine = await seed(user, {scope: organizationScope(org.organizationId)});

    const page = await listPage(user, orgPath(org.organizationId));

    expect(page.notifications.map((n) => n.id)).toEqual([mine.id]);
  });

  it.each([
    ["a user who is not a member", undefined],
    ["an invited member", "invited"],
    ["a revoked member", "revoked"],
  ] as const)("23. %s is refused (403) on every organization route — even holding notifications", async (_label, status) => {
    const org = await buildOrg();
    const user = freshUserId();
    if (status) {
      await addMember(org.organizationId, "staff", status, user);
    }
    const notification = await seed(user, {scope: organizationScope(org.organizationId)});
    const base = orgPath(org.organizationId);

    const results = await Promise.all([
      call(user, "GET", base),
      call(user, "GET", `${base}/unread-count`),
      call(user, "POST", `${base}/read-all`),
      call(user, "POST", `${base}/${notification.id}/read`),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
    expect((await stored(user, notification.id)).readAt).toBeNull();
  });

  it("23. a member of organization A cannot reach organization B's routes — even with notifications scoped to B", async () => {
    const orgA = await buildOrg();
    const orgB = await buildOrg();
    const user = await addMember(orgA.organizationId, "owner");
    const inB = await seed(user, {scope: organizationScope(orgB.organizationId)});

    const list = await call(user, "GET", orgPath(orgB.organizationId));
    const read = await call(user, "POST", `${orgPath(orgB.organizationId)}/${inB.id}/read`);
    const readAll = await call(user, "POST", `${orgPath(orgB.organizationId)}/read-all`);

    for (const result of [list, read, readAll]) {
      expect(result).toMatchObject({kind: "error", status: 403});
    }
    expect((await stored(user, inB.id)).readAt).toBeNull();
  });

  it("a member of both organizations sees each organization's notifications only on that organization's route", async () => {
    const orgA = await buildOrg();
    const orgB = await buildOrg();
    const user = freshUserId();
    await addMember(orgA.organizationId, "staff", "active", user);
    await addMember(orgB.organizationId, "staff", "active", user);
    const inA = await seed(user, {scope: organizationScope(orgA.organizationId)});
    const inB = await seed(user, {scope: organizationScope(orgB.organizationId)});

    const pageA = await listPage(user, orgPath(orgA.organizationId));
    const pageB = await listPage(user, orgPath(orgB.organizationId));
    const crossRead = await call(user, "POST", `${orgPath(orgA.organizationId)}/${inB.id}/read`);

    expect(pageA.notifications.map((n) => n.id)).toEqual([inA.id]);
    expect(pageB.notifications.map((n) => n.id)).toEqual([inB.id]);
    expect(crossRead).toMatchObject({kind: "error", status: 404});
  });

  it("membership loss takes effect immediately: the same request that worked is refused after revocation", async () => {
    const org = await buildOrg();
    const user = await addMember(org.organizationId, "staff");
    const mine = await seed(user, {scope: organizationScope(org.organizationId)});
    const customerNotification = await seed(user);
    expect(await call(user, "GET", orgPath(org.organizationId))).toMatchObject({kind: "success"});

    await db.collection("organizations").doc(org.organizationId).collection("members").doc(user)
      .update({status: "revoked"});

    expect(await call(user, "GET", orgPath(org.organizationId))).toMatchObject({kind: "error", status: 403});
    expect(await call(user, "POST", `${orgPath(org.organizationId)}/${mine.id}/read`))
      .toMatchObject({kind: "error", status: 403});
    // Their own customer inbox is theirs regardless of any organization.
    expect((await listPage(user, CUSTOMER)).notifications.map((n) => n.id)).toEqual([customerNotification.id]);
  });

  it("the organization in the path, not anything in the query, decides the scope", async () => {
    const orgA = await buildOrg();
    const orgB = await buildOrg();
    const user = await addMember(orgA.organizationId, "staff");
    await seed(user, {scope: organizationScope(orgB.organizationId)});

    const page = await listPage(user, orgPath(orgA.organizationId), {
      organizationId: orgB.organizationId, scope: organizationScope(orgB.organizationId),
    });

    expect(page.notifications).toEqual([]);
  });
});

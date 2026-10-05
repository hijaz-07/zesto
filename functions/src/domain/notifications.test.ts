// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {describe, expect, it} from "vitest";
import {
  NOTIFICATION_MAX_PAGE_SIZE,
  customerScope,
  decodeNotificationCursor,
  encodeNotificationCursor,
  listNotificationsQuerySchema,
  listNotifications,
  markNotificationRead,
  notificationExpiry,
  notificationId,
  organizationScope,
  parseNotification,
  toNotificationResponse,
  type Notification,
} from "./notifications";

const AT = Timestamp.fromDate(new Date("2026-10-05T10:00:00Z"));

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "order-1_order_ready.customer",
    type: "order_ready",
    scope: "customer",
    title: "Ready for pickup",
    body: "Your order from Main Canteen is ready for pickup.",
    orderId: "order-1",
    organizationId: "org-1",
    outletId: "outlet-1",
    eventId: "order-1_order_ready",
    createdAt: AT,
    readAt: null,
    expiresAt: notificationExpiry(AT),
    ...overrides,
  };
}

/** A Firestore stand-in that throws on any property access. */
function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe("deterministic notification identity", () => {
  it("is `${eventId}.${audience}`", () => {
    expect(notificationId("order-1_order_confirmed", "customer")).toBe("order-1_order_confirmed.customer");
    expect(notificationId("order-1_order_confirmed", "org")).toBe("order-1_order_confirmed.org");
  });

  it("gives a customer and an organization notification for one event different IDs", () => {
    expect(notificationId("e", "customer")).not.toBe(notificationId("e", "org"));
  });

  it("scopes are `customer` and `org:<organizationId>`", () => {
    expect(customerScope()).toBe("customer");
    expect(organizationScope("org-1")).toBe("org:org-1");
    expect(organizationScope("org-1")).not.toBe(organizationScope("org-2"));
  });

  it("expires 90 days after creation", () => {
    expect(notificationExpiry(AT).toMillis() - AT.toMillis()).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe("notification cursor", () => {
  it("round-trips a position, to the nanosecond", () => {
    const createdAt = new Timestamp(1_790_000_000, 123_456_789);

    const decoded = decodeNotificationCursor(encodeNotificationCursor(createdAt, "order-1_order_ready.customer"));

    expect(decoded.createdAt.seconds).toBe(createdAt.seconds);
    expect(decoded.createdAt.nanoseconds).toBe(123_456_789);
    expect(decoded.id).toBe("order-1_order_ready.customer");
  });

  it("is opaque URL-safe text", () => {
    expect(encodeNotificationCursor(AT, "x.customer")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  it.each([
    ["not base64url", "not a cursor!"],
    ["not JSON", Buffer.from("nope").toString("base64url")],
    ["a JSON array", encode([])],
    ["a missing id", encode({s: 1, n: 1})],
    ["a negative second", encode({s: -1, n: 0, i: "a"})],
    ["fractional nanoseconds", encode({s: 1, n: 0.5, i: "a"})],
    ["nanoseconds out of range", encode({s: 1, n: 1_000_000_000, i: "a"})],
    ["an id with a slash (a path, not an id)", encode({s: 1, n: 0, i: "users/other/notifications/x"})],
    ["a reserved id", encode({s: 1, n: 0, i: "__name__"})],
  ])("rejects %s with a 400", (_label, raw) => {
    let thrown: unknown;
    try {
      decodeNotificationCursor(raw);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).httpErrorCode.status).toBe(400);
  });

  it("is refused before Firestore is touched", async () => {
    const error = await errorOf(listNotifications(untouchedDb(), "U-1", "customer", {cursor: "!!"}));

    expect((error as HttpsError).httpErrorCode.status).toBe(400);
  });
});

describe("listNotificationsQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(listNotificationsQuerySchema.safeParse({}).success).toBe(true);
  });

  it("parses limit and unread", () => {
    expect(listNotificationsQuerySchema.parse({limit: "30", unread: "true"})).toEqual({limit: 30, unread: true});
    expect(listNotificationsQuerySchema.parse({unread: "false"})).toEqual({unread: false});
  });

  it.each([
    {limit: "0"}, {limit: "-1"}, {limit: "1.5"}, {limit: "abc"}, {limit: ""}, {limit: ["1", "2"]},
    {unread: "yes"}, {unread: "1"}, {unread: ["true"]}, {cursor: ""}, {cursor: ["a"]},
  ])("rejects %j", (query) => {
    expect(listNotificationsQuerySchema.safeParse(query).success).toBe(false);
  });

  it("strips anything that could be taken for authority: userId, scope, organizationId", () => {
    const parsed = listNotificationsQuerySchema.parse({userId: "U-other", scope: "org:x", organizationId: "x"});

    expect(parsed).toEqual({});
  });

  it("leaves enforcing the page-size ceiling to the domain function", () => {
    expect(listNotificationsQuerySchema.parse({limit: "100000"}).limit).toBe(100000);
    expect(NOTIFICATION_MAX_PAGE_SIZE).toBe(50);
  });
});

describe("invalid notification IDs", () => {
  it.each(["", "a/b", "..", ".", "__x__", 5, undefined, null])("markNotificationRead refuses %j (400)", async (id) => {
    const error = await errorOf(markNotificationRead(untouchedDb(), "U-1", "customer", id));

    expect(error).toBeInstanceOf(HttpsError);
    expect((error as HttpsError).httpErrorCode.status).toBe(400);
  });
});

describe("parseNotification", () => {
  it("parses a stored notification", () => {
    expect(parseNotification(notification(), "order-1_order_ready.customer")).toEqual(notification());
  });

  it("requires readAt to be present as an explicit null or a timestamp", () => {
    const withoutReadAt: Record<string, unknown> = {...notification()};
    delete withoutReadAt.readAt;

    expect(() => parseNotification(withoutReadAt, "order-1_order_ready.customer")).toThrow(/Malformed/);
    expect(parseNotification(notification({readAt: AT}), "order-1_order_ready.customer").readAt).toEqual(AT);
  });

  it.each([
    ["a different document id", notification({id: "other"})],
    ["an unknown type", {...notification(), type: "order_completed"}],
    ["an empty body", notification({body: ""})],
    ["a missing scope", {...notification(), scope: undefined}],
  ])("rejects %s", (_label, data) => {
    expect(() => parseNotification(data, "order-1_order_ready.customer")).toThrow(/Malformed/);
  });
});

describe("toNotificationResponse", () => {
  it("exposes only what the inbox and a deep link need", () => {
    expect(toNotificationResponse(notification())).toEqual({
      id: "order-1_order_ready.customer",
      type: "order_ready",
      title: "Ready for pickup",
      body: "Your order from Main Canteen is ready for pickup.",
      orderId: "order-1",
      createdAt: "2026-10-05T10:00:00.000Z",
      readAt: null,
    });
  });

  it("never includes scope, eventId, organizationId, outletId or expiresAt", () => {
    const keys = Object.keys(toNotificationResponse(notification({readAt: AT})));

    for (const internal of ["scope", "eventId", "organizationId", "outletId", "expiresAt", "userId"]) {
      expect(keys).not.toContain(internal);
    }
  });

  it("renders readAt as an ISO string once read", () => {
    expect(toNotificationResponse(notification({readAt: AT})).readAt).toBe("2026-10-05T10:00:00.000Z");
  });
});

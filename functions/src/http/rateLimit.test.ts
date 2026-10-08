// @vitest-environment node
import {describe, expect, it, vi} from "vitest";
import {createNotificationRoutes} from "../routes/notifications";
import {createOrderRoutes} from "../routes/orders";
import {createOrganizationOrderRoutes} from "../routes/organizationOrders";
import {createOrganizationRoutes} from "../routes/organizations";
import {FixedWindowLimiter, RATE_LIMIT_POLICIES, withRateLimits} from "./rateLimit";
import type {ApiResult, RouteContext, RouteDefinition} from "./types";

const ok: ApiResult = {kind: "success", status: 200, data: {ok: true}};

function ctx(): RouteContext {
  return {request: {method: "POST", path: "/x", headers: {}, query: {}, body: undefined}};
}

describe("FixedWindowLimiter", () => {
  it("allows up to the limit, then refuses until the window resets", () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(() => now);
    expect(limiter.hit("k", 2, 60_000).allowed).toBe(true);
    expect(limiter.hit("k", 2, 60_000).allowed).toBe(true);
    const refused = limiter.hit("k", 2, 60_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);

    now += 59_000;
    expect(limiter.hit("k", 2, 60_000)).toEqual({allowed: false, retryAfterSeconds: 1});

    now += 1_000;
    expect(limiter.hit("k", 2, 60_000).allowed).toBe(true);
  });

  it("counts each key separately", () => {
    const limiter = new FixedWindowLimiter(() => 0);
    expect(limiter.hit("a", 1, 1000).allowed).toBe(true);
    expect(limiter.hit("a", 1, 1000).allowed).toBe(false);
    expect(limiter.hit("b", 1, 1000).allowed).toBe(true);
  });

  it("never tracks more than maxKeys buckets, dropping expired ones first", () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(() => now, 3);
    limiter.hit("old1", 5, 1000);
    limiter.hit("old2", 5, 1000);
    now = 500;
    limiter.hit("live", 5, 10_000);
    expect(limiter.size).toBe(3);

    now = 2000; // old1/old2 expired
    limiter.hit("new", 5, 10_000);
    expect(limiter.size).toBe(2);

    for (let i = 0; i < 20; i++) {
      limiter.hit(`flood${i}`, 5, 10_000);
    }
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});

describe("withRateLimits", () => {
  const policies = [{method: "POST", path: "/limited", limit: 2, windowMs: 60_000}];

  function setup(userId: string | null | "throw") {
    const limitedHandler = vi.fn(async () => ok);
    const freeHandler = vi.fn(async () => ok);
    const routes: RouteDefinition[] = [
      {method: "POST", path: "/limited", handler: limitedHandler},
      {method: "GET", path: "/limited", handler: freeHandler},
      {method: "POST", path: "/free", handler: freeHandler},
    ];
    const resolveUserId = vi.fn(async () => {
      if (userId === "throw") {
        throw new Error("descope down");
      }
      return userId;
    });
    const wrapped = withRateLimits(routes, {resolveUserId, limiter: new FixedWindowLimiter(() => 0)}, policies);
    return {wrapped, limitedHandler, freeHandler, resolveUserId};
  }

  it("lets requests through up to the limit, then answers 429 with Retry-After without running the handler", async () => {
    const {wrapped, limitedHandler} = setup("U-1");
    const route = wrapped[0];
    expect((await route.handler(ctx())).kind).toBe("success");
    expect((await route.handler(ctx())).kind).toBe("success");
    const third = await route.handler(ctx());
    expect(third).toMatchObject({
      kind: "error", status: 429, code: "rate_limited", userId: "U-1", headers: {"Retry-After": "60"},
    });
    expect(limitedHandler).toHaveBeenCalledTimes(2);
  });

  it("limits each user separately", async () => {
    const limitedHandler = vi.fn(async () => ok);
    const users = ["U-1", "U-1", "U-1", "U-2"];
    let i = 0;
    const wrapped = withRateLimits(
      [{method: "POST", path: "/limited", handler: limitedHandler}],
      {resolveUserId: async () => users[i++], limiter: new FixedWindowLimiter(() => 0)},
      policies,
    );
    const statuses = [];
    for (let n = 0; n < 4; n++) {
      statuses.push((await wrapped[0].handler(ctx())).kind === "success" ? 200 : 429);
    }
    expect(statuses).toEqual([200, 200, 429, 200]);
  });

  it("leaves routes without a policy (including the same path with another method) untouched", () => {
    const {wrapped, freeHandler} = setup("U-1");
    expect(wrapped[1].handler).toBe(freeHandler);
    expect(wrapped[2].handler).toBe(freeHandler);
  });

  it("never limits a caller it could not verify: the route's own handler answers them", async () => {
    for (const who of [null, "throw"] as const) {
      const {wrapped, limitedHandler} = setup(who);
      for (let n = 0; n < 10; n++) {
        await wrapped[0].handler(ctx());
      }
      expect(limitedHandler).toHaveBeenCalledTimes(10);
    }
  });
});

describe("RATE_LIMIT_POLICIES", () => {
  it("names only routes that are actually registered, and no policy twice", () => {
    const db = {} as never;
    const registered = new Set(
      [
        ...createOrderRoutes({db}),
        ...createOrganizationOrderRoutes({db}),
        ...createOrganizationRoutes({db}),
        ...createNotificationRoutes({db}),
      ].map((r) => `${r.method} ${r.path}`),
    );
    const keys = RATE_LIMIT_POLICIES.map((p) => `${p.method} ${p.path}`);
    for (const key of keys) {
      expect(registered.has(key), key).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the abuse-review endpoints and keeps limits high enough for real use", () => {
    const byKey = new Map(RATE_LIMIT_POLICIES.map((p) => [`${p.method} ${p.path}`, p]));
    for (const key of [
      "POST /orders",
      "POST /orders/:orderId/payment",
      "POST /orders/:orderId/cancel",
      "POST /organizations/:organizationId/orders/:orderId/retry-refund",
      "POST /organizations/:organizationId/pickups",
      "GET /notifications/unread-count",
    ]) {
      expect(byKey.has(key), key).toBe(true);
    }
    for (const policy of RATE_LIMIT_POLICIES) {
      expect(policy.limit, `${policy.method} ${policy.path}`).toBeGreaterThanOrEqual(10);
    }
  });
});

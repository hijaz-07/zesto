import type {ApiResult, RouteContext, RouteDefinition} from "./types";

/**
 * Best-effort, per-user abuse protection for the highest-risk `api` routes.
 *
 * What it is: a fixed-window counter held in each function instance's memory,
 * keyed by the VERIFIED caller (`{route}:{userId}`) — never an IP address (a
 * campus Wi-Fi puts hundreds of legitimate students behind one) and never an
 * unverified token claim (anyone could then spend another user's budget by
 * forging their ID).
 *
 * What it is not: a global limit. Each instance counts for itself, so the
 * effective ceiling for one user is the policy limit times the number of warm
 * instances (at most `maxInstances`, 10 today). Counters reset when an
 * instance restarts. That is enough for its job — stopping a runaway client
 * loop or a single abusive account from hammering Firestore and, above all,
 * the shared Razorpay API budget — and the limits are set far above anything a
 * legitimate user does, so it never turns a real customer away. A hard global
 * limit needs shared state (Firestore/Redis) or an edge control (Cloud Armor /
 * API Gateway) and is documented in docs/operations as a future step.
 *
 * Unauthenticated callers are never limited here: the limited route's own
 * handler still answers them (401/503) exactly as before.
 */

export interface RateLimitPolicy {
  /** The route's registered method. */
  method: string;
  /** The route's registered path pattern, e.g. `/orders/:orderId/cancel`. */
  path: string;
  /** Requests allowed per user per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until the window resets (always at least 1). */
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Upper bound on tracked buckets, so a flood of distinct users cannot grow memory without limit. */
export const RATE_LIMIT_MAX_KEYS = 10_000;

/** A fixed-window counter with a bounded number of keys. */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * @param {() => number} now Injected clock (milliseconds), for tests.
   * @param {number} maxKeys Most buckets kept before expired, then oldest, are dropped.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = RATE_LIMIT_MAX_KEYS,
  ) {}

  /**
   * Counts one request against `key`.
   *
   * @param {string} key The bucket (route plus verified user).
   * @param {number} limit Requests allowed per window.
   * @param {number} windowMs The window length.
   * @return {RateLimitDecision} Whether this request is allowed.
   */
  hit(key: string, limit: number, windowMs: number): RateLimitDecision {
    const time = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= time) {
      this.makeRoom(time);
      bucket = {count: 0, resetAt: time + windowMs};
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - time) / 1000)),
    };
  }

  /** @return {number} How many buckets are currently tracked (for tests). */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * @param {number} time The current time.
   */
  private makeRoom(time: number): void {
    if (this.buckets.size < this.maxKeys) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= time) {
        this.buckets.delete(key);
      }
    }
    // Still full of live buckets: drop the oldest-inserted until there is room.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) {
        break;
      }
      this.buckets.delete(key);
    }
  }
}

/** Resolves the verified caller's user ID, or null if the request is not (validly) authenticated. */
export type ResolveVerifiedUserId = (ctx: RouteContext) => Promise<string | null>;

export interface RateLimitDeps {
  resolveUserId: ResolveVerifiedUserId;
  limiter?: FixedWindowLimiter;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The limited routes. Limits are deliberately generous (a customer places one
 * or two orders a day; a counter redeems about one pickup a second at the very
 * busiest) — they exist to stop abuse, never to shape normal use.
 */
export const RATE_LIMIT_POLICIES: readonly RateLimitPolicy[] = [
  // Customer money path: every order and payment preparation can reach Razorpay.
  {method: "POST", path: "/orders", limit: 20, windowMs: MINUTE},
  {method: "POST", path: "/orders/:orderId/payment", limit: 20, windowMs: MINUTE},
  {method: "POST", path: "/orders/:orderId/payment/verify", limit: 20, windowMs: MINUTE},
  {method: "POST", path: "/orders/:orderId/cancel", limit: 10, windowMs: MINUTE},
  {method: "GET", path: "/orders/:orderId/pickup-credential", limit: 60, windowMs: MINUTE},
  // Organization side.
  {method: "POST", path: "/organizations", limit: 10, windowMs: HOUR},
  {method: "POST", path: "/organizations/:organizationId/orders/:orderId/cancel", limit: 60, windowMs: MINUTE},
  {method: "POST", path: "/organizations/:organizationId/orders/:orderId/retry-refund", limit: 20, windowMs: MINUTE},
  {method: "POST", path: "/organizations/:organizationId/pickups", limit: 120, windowMs: MINUTE},
  // Notification reads: polled, so the ceiling is well above the 30 s poll.
  {method: "GET", path: "/notifications", limit: 120, windowMs: MINUTE},
  {method: "GET", path: "/notifications/unread-count", limit: 120, windowMs: MINUTE},
  {method: "GET", path: "/organizations/:organizationId/notifications", limit: 120, windowMs: MINUTE},
  {method: "GET", path: "/organizations/:organizationId/notifications/unread-count", limit: 120, windowMs: MINUTE},
];

/**
 * @param {number} retryAfterSeconds Seconds until the window resets.
 * @return {ApiResult} The `429` result.
 */
function tooManyRequests(retryAfterSeconds: number): ApiResult {
  return {
    kind: "error",
    status: 429,
    code: "rate_limited",
    message: "Too many requests. Please wait a moment and try again.",
    headers: {"Retry-After": String(retryAfterSeconds)},
    logContext: {outcome: "rate_limited"},
  };
}

/**
 * Wraps the routes that have a policy so each request is counted against its
 * verified caller before the route's own handler runs. Routes without a policy
 * are returned untouched.
 *
 * @param {readonly RouteDefinition[]} routes The registered routes.
 * @param {RateLimitDeps} deps How to resolve the verified caller, and the limiter.
 * @param {readonly RateLimitPolicy[]} policies The policies (defaults to `RATE_LIMIT_POLICIES`).
 * @return {RouteDefinition[]} The routes, with limited ones wrapped.
 */
export function withRateLimits(
  routes: readonly RouteDefinition[],
  deps: RateLimitDeps,
  policies: readonly RateLimitPolicy[] = RATE_LIMIT_POLICIES,
): RouteDefinition[] {
  const limiter = deps.limiter ?? new FixedWindowLimiter();
  return routes.map((route) => {
    const policy = policies.find((p) => p.method === route.method && p.path === route.path);
    if (policy === undefined) {
      return route;
    }
    return {
      ...route,
      handler: async (ctx) => {
        const userId = await deps.resolveUserId(ctx).catch(() => null);
        if (userId !== null) {
          const decision = limiter.hit(`${policy.method} ${policy.path}:${userId}`, policy.limit, policy.windowMs);
          if (!decision.allowed) {
            return {...tooManyRequests(decision.retryAfterSeconds), userId};
          }
        }
        return route.handler(ctx);
      },
    };
  });
}

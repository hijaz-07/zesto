// @vitest-environment node
import {createHmac} from "node:crypto";
import type {Firestore} from "firebase-admin/firestore";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {handleRequest} from "../http/handleRequest";
import {normalizePath} from "../http/router";
import type {ApiResult, NormalizedRequest} from "../http/types";
import {createWebhookRoutes} from "./webhooks";

/**
 * Route-level behavior that needs NO Firestore: authentication by signature,
 * rejection paths, unknown-event acknowledgement, and secret hygiene. The
 * paths that reach Firestore (processing, deduplication, state transitions)
 * are covered against a real emulator in `webhooks.emulator.test.ts`. Every
 * test here uses a `db` that throws on ANY access, so a passing test also
 * proves the code path never touched Firestore.
 */

const WEBHOOK_SECRET = "test_webhook_secret_value";
const KEY_SECRET = "test_key_secret_value";

beforeEach(() => {
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("RAZORPAY_KEY_SECRET", KEY_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`Firestore was accessed (${String(property)}) on a path that must not touch it.`);
    },
  }) as unknown as Firestore;
}

function sign(rawBody: Buffer | string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

interface PostOptions {
  headers?: Record<string, string>;
  /** Overrides the parsed `body` (the route must ignore it entirely). */
  parsedBody?: unknown;
  signWith?: Buffer | string;
}

function post(rawBody: Buffer | string | undefined, options: PostOptions = {}): Promise<ApiResult> {
  const raw = rawBody === undefined ? undefined : Buffer.from(rawBody);
  const signed = options.signWith ?? rawBody;
  const request: NormalizedRequest = {
    method: "POST",
    path: normalizePath("/api/webhooks/razorpay"),
    headers: {
      ...(signed !== undefined ? {"x-razorpay-signature": sign(signed)} : {}),
      ...options.headers,
    },
    query: {},
    body: options.parsedBody,
    rawBody: raw,
  };
  return handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});
}

/** A well-formed event Zesto does not subscribe to — acknowledged without
 * touching Firestore. */
const unknownEventBody = JSON.stringify({entity: "event", event: "order.paid", payload: {order: {entity: {id: "order_X"}}}});

function payload(event: string, entity: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entity: "event", event,
    payload: {payment: {entity: {id: "pay_X", order_id: "order_X", amount: 100, currency: "INR", status: "captured", ...entity}}},
  });
}

describe("POST /webhooks/razorpay — authentication", () => {
  it("is registered at /webhooks/razorpay (reached as /api/webhooks/razorpay through Hosting)", () => {
    const routes = createWebhookRoutes({db: untouchedDb()});

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual(["POST /webhooks/razorpay"]);
  });

  it("requires NO Descope session: a correctly signed request with no Authorization header succeeds", async () => {
    const result = await post(unknownEventBody);

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("ignores a bogus Authorization header when the signature is valid — it is never validated as a session", async () => {
    // If the route tried to validate this as a Descope token it would fail
    // (there is no validator here at all); it must simply not matter.
    const result = await post(unknownEventBody, {headers: {authorization: "Bearer not-a-real-token"}});

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("rejects a request with no signature header (401), without touching Firestore", async () => {
    const request: NormalizedRequest = {
      method: "POST", path: "/webhooks/razorpay", headers: {}, query: {}, body: {},
      rawBody: Buffer.from(unknownEventBody),
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});

    expect(result).toMatchObject({kind: "error", status: 401, code: "invalid_signature"});
  });

  it("rejects a Descope-style Authorization header presented INSTEAD of a signature (401)", async () => {
    const request: NormalizedRequest = {
      method: "POST", path: "/webhooks/razorpay", headers: {authorization: "Bearer valid-looking-session"},
      query: {}, body: {}, rawBody: Buffer.from(unknownEventBody),
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});

    expect(result).toMatchObject({kind: "error", status: 401, code: "invalid_signature"});
  });

  it.each([
    ["a signature over a different body", {signWith: "{\"event\":\"payment.captured\"}"}],
    ["a garbage signature", {headers: {"x-razorpay-signature": "deadbeef"}}],
    ["an empty signature", {headers: {"x-razorpay-signature": ""}}],
  ] as Array<[string, PostOptions]>)("rejects %s (401), without touching Firestore", async (_label, options) => {
    const result = await post(payload("payment.captured"), options);

    expect(result).toMatchObject({kind: "error", status: 401, code: "invalid_signature"});
  });

  it("rejects a body modified after signing (401)", async () => {
    const original = payload("payment.captured");

    const result = await post(original.replace("\"amount\":100", "\"amount\":1"), {signWith: original});

    expect(result).toMatchObject({kind: "error", status: 401});
  });

  it("rejects a signature made with the API key secret instead of the webhook secret (401)", async () => {
    const body = payload("payment.captured");
    const request: NormalizedRequest = {
      method: "POST", path: "/webhooks/razorpay",
      headers: {"x-razorpay-signature": sign(body, KEY_SECRET)}, query: {}, body: {}, rawBody: Buffer.from(body),
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});

    expect(result).toMatchObject({kind: "error", status: 401, code: "invalid_signature"});
  });

  it("verifies the raw bytes, never the parsed body: a mismatching parsed `body` is ignored", async () => {
    // The route must not look at `body` at all. Give it one that would
    // produce a completely different signature if it were used.
    const result = await post(unknownEventBody, {parsedBody: {event: "payment.captured", tampered: true}});

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("uses the first value if the signature header arrives as an array", async () => {
    const request: NormalizedRequest = {
      method: "POST", path: "/webhooks/razorpay",
      headers: {"x-razorpay-signature": [sign(unknownEventBody), "ignored"]}, query: {}, body: {},
      rawBody: Buffer.from(unknownEventBody),
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});

    expect(result).toMatchObject({kind: "success", status: 200});
  });
});

describe("POST /webhooks/razorpay — payload handling (after a valid signature)", () => {
  it("rejects a missing body (400)", async () => {
    const request: NormalizedRequest = {
      method: "POST", path: "/webhooks/razorpay", headers: {"x-razorpay-signature": "x"}, query: {}, body: undefined,
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("rejects an empty body (400), even with a signature that is technically valid for empty input", async () => {
    const result = await post("");

    expect(result).toMatchObject({kind: "error", status: 400});
  });

  it.each([
    ["not JSON", "this is not json"],
    ["JSON that isn't an object", "[1,2,3]"],
    ["JSON with no event", "{\"foo\":\"bar\"}"],
    ["an event with a non-string type", "{\"event\":42}"],
    ["a supported event with no payment entity", "{\"event\":\"payment.captured\",\"payload\":{}}"],
    ["a supported event with a non-integer amount", payload("payment.captured", {amount: "100"})],
    ["a supported event with a fractional amount", payload("payment.captured", {amount: 100.5})],
    ["a supported event with no payment id", payload("payment.captured", {id: undefined})],
  ])("rejects a signed but malformed payload: %s (400)", async (_label, body) => {
    const result = await post(body);

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each(["order.paid", "refund.speed_changed", "payment.authorized", "payment.dispute.created", "x"])(
    "acknowledges a valid but unsupported event (%s) with 200, never mutating anything",
    async (eventType) => {
      const result = await post(JSON.stringify({entity: "event", event: eventType, payload: {}}));

      expect(result).toMatchObject({
        kind: "success", status: 200, data: {received: true, outcome: "ignored_unknown_event"},
      });
    },
  );

  it("does NOT treat order.paid as a payment event (v1 subscribes only to payment.captured/payment.failed)", async () => {
    // order.paid carries a payment entity too — it must still be ignored.
    const result = await post(JSON.stringify({
      entity: "event", event: "order.paid",
      payload: {payment: {entity: {id: "pay_X", order_id: "order_X", amount: 100, currency: "INR", status: "captured"}}},
    }));

    expect(result).toMatchObject({kind: "success", data: {outcome: "ignored_unknown_event"}});
  });

  it("caps the event type length before it reaches the log context", async () => {
    const result = await post(JSON.stringify({entity: "event", event: "e".repeat(500)}));

    expect(result.kind).toBe("success");
    const logged = result.logContext?.eventType;
    expect(typeof logged === "string" && logged.length).toBeLessThanOrEqual(64);
  });
});

describe("POST /webhooks/razorpay — refund events", () => {
  const refundBody = JSON.stringify({
    entity: "event", event: "refund.processed",
    payload: {refund: {entity: {id: "rfnd_1", payment_id: "pay_1", amount: 100, currency: "INR", status: "processed"}}},
  });

  it("rejects a refund event with an invalid signature before parsing or touching Firestore", async () => {
    const result = await post(refundBody, {signWith: "a different body"});

    expect(result).toMatchObject({kind: "error", status: 401, code: "invalid_signature"});
  });

  it("rejects a refund event with no signature header", async () => {
    const request: NormalizedRequest = {
      method: "POST", path: normalizePath("/api/webhooks/razorpay"), headers: {}, query: {}, body: undefined,
      rawBody: Buffer.from(refundBody),
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});

    expect(result).toMatchObject({kind: "error", status: 401});
  });

  it("answers a signed but malformed refund event with 400, without touching Firestore", async () => {
    const result = await post(JSON.stringify({
      entity: "event", event: "refund.processed", payload: {refund: {entity: {id: "rfnd_1"}}},
    }));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("verifies the signature over the raw bytes: a re-serialised body does not pass", async () => {
    const result = await post(refundBody, {signWith: JSON.stringify(JSON.parse(refundBody), null, 2)});

    expect(result).toMatchObject({kind: "error", status: 401});
  });
});

describe("POST /webhooks/razorpay — method and secrets", () => {
  it("only accepts POST (405 with Allow: POST for GET)", async () => {
    const request: NormalizedRequest = {
      method: "GET", path: "/webhooks/razorpay", headers: {}, query: {}, body: undefined,
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, () => {});

    expect(result).toMatchObject({kind: "error", status: 405, headers: {Allow: "POST"}});
  });

  it("reports a missing webhook secret as a generic 500 — never as 'invalid signature' and never leaking anything", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
    const onUnhandled = vi.fn();
    const request: NormalizedRequest = {
      method: "POST", path: "/webhooks/razorpay", headers: {"x-razorpay-signature": "anything"}, query: {}, body: {},
      rawBody: Buffer.from(unknownEventBody),
    };

    const result = await handleRequest(createWebhookRoutes({db: untouchedDb()}), request, onUnhandled);

    expect(result).toMatchObject({kind: "error", status: 500, code: "internal", message: "An unexpected error occurred."});
    expect(onUnhandled).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(result)).not.toContain(WEBHOOK_SECRET);
  });

  it("never includes either secret, the signature, or any request content in any response or log context", async () => {
    const body = unknownEventBody;
    const signature = sign(body);
    const results = await Promise.all([
      post(body),
      post(body, {signWith: "other"}),
      post("not json"),
      post(""),
    ]);

    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(WEBHOOK_SECRET);
      expect(serialized).not.toContain(KEY_SECRET);
      expect(serialized).not.toContain(signature);
      expect(serialized).not.toContain("order_X");
    }
  });

  it("only ever puts curated operational fields in the log context", async () => {
    const allowed = new Set(["eventKey", "eventType", "outcome", "providerOrderId", "providerPaymentId", "originalOutcome"]);
    const results = await Promise.all([post(unknownEventBody), post("not json"), post(unknownEventBody, {signWith: "x"})]);

    for (const result of results) {
      for (const key of Object.keys(result.logContext ?? {})) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});

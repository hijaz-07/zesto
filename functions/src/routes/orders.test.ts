// @vitest-environment node
import type {Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import type {NormalizedRequest, RouteContext, RouteHandler} from "../http/types";
import type {PaymentProviderGateway} from "../providers/razorpay";
import {createOrderRoutes} from "./orders";

// verifyDescopeSession reads the expected audience from DESCOPE_PROJECT_ID
// even when a fake SessionValidator is injected, so every test needs it set.
// RAZORPAY_KEY_ID is read directly by handlePostOrderPayment (to build the
// response), so any test reaching past authentication on that route needs
// it set too, whether or not the test cares about payments at all.
beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_public_key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A Firestore stand-in that throws on any property access. Used to prove a
 * handler returned before ever touching Firestore (e.g. an unauthenticated
 * caller, or an invalid request body) — the same invariant
 * `menuItems.emulator.test.ts`'s "rejects an invalid body without touching
 * Firestore" proves against the real emulator, checked here at unit-test
 * speed instead.
 */
function untouchedDb(): Firestore {
  return new Proxy({}, {
    get(): never {
      throw new Error("Firestore should not have been touched.");
    },
  }) as unknown as Firestore;
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({
      jwt: "irrelevant",
      token: {sub: userId, aud: ["P-test"]},
    })),
  };
}

function rejectingValidator(): SessionValidator {
  return {
    validateSession: vi.fn(async () => {
      throw new HttpsError("unauthenticated", "The session is invalid or has expired.");
    }),
  };
}

function unavailableValidator(): SessionValidator {
  return {
    validateSession: vi.fn(async () => {
      throw new HttpsError("unavailable", "The session could not be validated right now. Please try again.");
    }),
  };
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "POST",
    path: "/orders",
    headers: {authorization: "Bearer token"},
    query: {},
    body: undefined,
    ...overrides,
  };
}

/** A fake `PaymentProviderGateway` that never hits the real Razorpay
 * API — the default for every route test here (see this checkpoint's "unit
 * tests should mock the provider abstraction" requirement). Tests that care
 * about provider behavior pass their own instead. */
function fakePaymentProvider(overrides: Partial<PaymentProviderGateway> = {}): PaymentProviderGateway {
  return {
    createOrder: vi.fn(async (input) => ({
      id: "order_fake_test", amountInPaise: input.amountInPaise, currency: input.currency,
      receipt: input.receipt, status: "created",
    })),
    fetchOrder: vi.fn(async (providerOrderId) => (
      {id: providerOrderId, amountInPaise: 0, currency: "INR", status: "created"}
    )),
    ...overrides,
  };
}

function routeFor(
  method: string,
  path: string,
  db: Firestore,
  validator: SessionValidator,
  paymentProvider: PaymentProviderGateway = fakePaymentProvider(),
): RouteHandler {
  const routes = createOrderRoutes({db, validator, paymentProvider});
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} route not registered`);
  return route.handler;
}

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {request: request(), params: {}, ...overrides};
}

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: "outlet-1",
    menuId: "menu-1",
    items: [{itemId: "item-1", quantity: 2}],
    idempotencyKey: "idem-key-1",
    ...overrides,
  };
}

describe("createOrderRoutes", () => {
  it("registers exactly the 4 documented routes", () => {
    const routes = createOrderRoutes({db: {} as Firestore});
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /orders/:orderId",
      "POST /orders",
      "POST /orders/:orderId/payment",
      "POST /orders/:orderId/payment/verify",
    ]);
  });
});

describe("POST /orders", () => {
  it("maps a rejected session to 401 with WWW-Authenticate: Bearer, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure to 503, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders", untouchedDb(), unavailableValidator());

    const result = await handler(ctx({request: request({body: validCreateBody()})}));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("authenticates before ever parsing the body: an invalid body under a rejected session is still 401", async () => {
    const handler = routeFor("POST", "/orders", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({request: request({body: {not: "valid"}})}));

    expect(result).toMatchObject({kind: "error", status: 401});
  });

  it.each([
    ["missing outletId", validCreateBody({outletId: undefined})],
    ["missing menuId", validCreateBody({menuId: undefined})],
    ["missing idempotencyKey", validCreateBody({idempotencyKey: undefined})],
    ["empty items", validCreateBody({items: []})],
    ["zero quantity", validCreateBody({items: [{itemId: "item-1", quantity: 0}]})],
    ["negative quantity", validCreateBody({items: [{itemId: "item-1", quantity: -1}]})],
    ["non-integer quantity", validCreateBody({items: [{itemId: "item-1", quantity: 1.5}]})],
    ["duplicate item IDs", validCreateBody({
      items: [{itemId: "item-1", quantity: 1}, {itemId: "item-1", quantity: 1}],
    })],
  ])("rejects an invalid body (%s) as 400, without touching Firestore", async (_label, body) => {
    const handler = routeFor("POST", "/orders", untouchedDb(), acceptingValidator("U-1"));

    const result = await handler(ctx({request: request({body})}));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("takes the caller's identity only from the verified session, never from a request-body userId", async () => {
    const handler = routeFor("POST", "/orders", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({
      request: request({body: validCreateBody({userId: "U-attacker"})}),
    }));

    // Still 401 — a forged body userId cannot substitute for a real session,
    // and (via untouchedDb) never even reaches the domain layer.
    expect(result).toMatchObject({kind: "error", status: 401});
  });
});

describe("GET /orders/:orderId", () => {
  it("maps a rejected session to 401 with WWW-Authenticate: Bearer, without touching Firestore", async () => {
    const handler = routeFor("GET", "/orders/:orderId", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({
      request: request({method: "GET", path: "/orders/order-1", body: undefined}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure to 503, without touching Firestore", async () => {
    const handler = routeFor("GET", "/orders/:orderId", untouchedDb(), unavailableValidator());

    const result = await handler(ctx({
      request: request({method: "GET", path: "/orders/order-1", body: undefined}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("rejects a malformed order ID as 400, without touching Firestore", async () => {
    const handler = routeFor("GET", "/orders/:orderId", untouchedDb(), acceptingValidator("U-1"));

    const result = await handler(ctx({
      request: request({method: "GET", path: "/orders/..", body: undefined}),
      params: {orderId: ".."},
    }));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });
});

describe("POST /orders/:orderId/payment", () => {
  it("maps a rejected session to 401 with WWW-Authenticate: Bearer, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/order-1/payment", body: undefined}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure to 503, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment", untouchedDb(), unavailableValidator());

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/order-1/payment", body: undefined}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("rejects a malformed order ID as 400, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment", untouchedDb(), acceptingValidator("U-1"));

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/../payment", body: undefined}),
      params: {orderId: ".."},
    }));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("ignores any request body — there is nothing for a client to override", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({
      request: request({
        method: "POST",
        path: "/orders/order-1/payment",
        body: {amountInPaise: 1, currency: "USD", status: "succeeded"},
      }),
      params: {orderId: "order-1"},
    }));

    // Still 401 — the body is never even read before authentication.
    expect(result).toMatchObject({kind: "error", status: 401});
  });
});

function validVerifyBody(overrides: Record<string, unknown> = {}) {
  return {
    razorpayOrderId: "order_test1",
    razorpayPaymentId: "pay_test1",
    razorpaySignature: "deadbeef",
    ...overrides,
  };
}

describe("POST /orders/:orderId/payment/verify", () => {
  it("maps a rejected session to 401 with WWW-Authenticate: Bearer, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment/verify", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/order-1/payment/verify", body: validVerifyBody()}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      code: "unauthenticated",
      headers: {"WWW-Authenticate": "Bearer"},
    });
  });

  it("maps an infrastructure failure to 503, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment/verify", untouchedDb(), unavailableValidator());

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/order-1/payment/verify", body: validVerifyBody()}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({kind: "error", status: 503, code: "unavailable"});
  });

  it("authenticates before ever parsing the body: an invalid body under a rejected session is still 401", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment/verify", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/order-1/payment/verify", body: {not: "valid"}}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({kind: "error", status: 401});
  });

  it("rejects a malformed order ID as 400, without touching Firestore", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment/verify", untouchedDb(), acceptingValidator("U-1"));

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/../payment/verify", body: validVerifyBody()}),
      params: {orderId: ".."},
    }));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it.each([
    ["missing razorpayOrderId", validVerifyBody({razorpayOrderId: undefined})],
    ["missing razorpayPaymentId", validVerifyBody({razorpayPaymentId: undefined})],
    ["missing razorpaySignature", validVerifyBody({razorpaySignature: undefined})],
    ["empty razorpayOrderId", validVerifyBody({razorpayOrderId: ""})],
    ["empty razorpaySignature", validVerifyBody({razorpaySignature: ""})],
  ])("rejects an invalid body (%s) as 400, without touching Firestore", async (_label, body) => {
    const handler = routeFor("POST", "/orders/:orderId/payment/verify", untouchedDb(), acceptingValidator("U-1"));

    const result = await handler(ctx({
      request: request({method: "POST", path: "/orders/order-1/payment/verify", body}),
      params: {orderId: "order-1"},
    }));

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("ignores client-supplied amount/currency/status/providerOrderId — the body is never even read before authentication", async () => {
    const handler = routeFor("POST", "/orders/:orderId/payment/verify", untouchedDb(), rejectingValidator());

    const result = await handler(ctx({
      request: request({
        method: "POST",
        path: "/orders/order-1/payment/verify",
        body: validVerifyBody({
          amountInPaise: 1, currency: "USD", status: "succeeded", providerOrderId: "attacker-order",
        }),
      }),
      params: {orderId: "order-1"},
    }));

    // Still 401 — auth runs before the body is ever read, exactly like every other route.
    expect(result).toMatchObject({kind: "error", status: 401});
  });
});

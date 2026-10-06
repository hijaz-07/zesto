// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const logged = vi.hoisted(() => ({calls: [] as unknown[][]}));
vi.mock("firebase-functions/logger", () => {
  const record = (...args: unknown[]) => {
    logged.calls.push(args);
  };
  return {warn: record, error: record, info: record, debug: record, log: record};
});

import {
  DEFAULT_REFUND_REQUEST_TIMEOUT_MS,
  createRazorpayRefundGateway,
  getRazorpayRefundGateway,
  type RazorpayRefundGatewayOptions,
} from "./razorpayRefunds";
import {createFakeRazorpayHttp, type FakeRazorpayHttp} from "./razorpayHttp.fake";
import {findMatchingProviderRefund} from "./refundLookup";
import {
  ProviderConfigurationError,
  ProviderOutcomeUnknownError,
  ProviderRefundRejectedError,
  ProviderRetryableError,
  isRefundProviderError,
  type CreateProviderRefundInput,
  type ProviderFailureCategory,
  type RefundProviderGateway,
} from "./refundGateway";

// Obviously fake values: no real credential appears in this repository.
const KEY_ID = "rzp_test_FAKEKEYID000";
const KEY_SECRET = "FAKE_SECRET_never_a_real_credential";
const PAYMENT = "pay_TestPayment001";

interface Harness {
  http: FakeRazorpayHttp;
  gateway: RefundProviderGateway;
}

function harness(options: Partial<RazorpayRefundGatewayOptions> = {}): Harness {
  const http = createFakeRazorpayHttp(KEY_ID, KEY_SECRET);
  http.addPayment({id: PAYMENT, orderId: "order_TestOrder001", amount: 24000});
  const gateway = createRazorpayRefundGateway({
    getCredentials: () => ({keyId: KEY_ID, keySecret: KEY_SECRET}),
    fetchFn: http.fetchFn,
    timeoutMs: 1000,
    ...options,
  });
  return {http, gateway};
}

function request(overrides: Partial<CreateProviderRefundInput> = {}): CreateProviderRefundInput {
  return {
    providerPaymentId: PAYMENT,
    amountInPaise: 24000,
    speed: "normal",
    idempotencyKey: "order-01-r1",
    receipt: "order-01-r1",
    notes: {zestoRefundId: "order-01-r1", zestoOrderId: "order-01"},
    ...overrides,
  };
}

/** The error a call rejects with, failing the test if it resolved or threw something untyped. */
async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isRefundProviderError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

function refundBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rfnd_Direct001", entity: "refund", amount: 24000, currency: "INR", payment_id: PAYMENT,
    notes: {zestoRefundId: "order-01-r1", zestoOrderId: "order-01"}, receipt: "order-01-r1",
    acquirer_data: {arn: null}, created_at: 1_700_000_000, batch_id: null, status: "pending",
    speed_processed: "normal", speed_requested: "normal", ...overrides,
  };
}

beforeEach(() => {
  logged.calls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createRefund", () => {
  it("returns a normalized pending refund — only provider-neutral fields, no raw provider object", async () => {
    const {gateway} = harness();
    const refund = await gateway.createRefund(request());
    expect(refund).toEqual({
      id: "rfnd_Fake1",
      providerPaymentId: PAYMENT,
      amountInPaise: 24000,
      currency: "INR",
      status: "pending",
      receipt: "order-01-r1",
      notes: {zestoRefundId: "order-01-r1", zestoOrderId: "order-01"},
      speedRequested: "normal",
      speedProcessed: "normal",
      createdAtEpochSeconds: 1_700_000_001,
    });
    expect(Object.keys(refund)).not.toEqual(expect.arrayContaining(["entity", "acquirer_data", "batch_id", "payment_id"]));
  });

  it("returns a normalized processed refund when the provider already completed it", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 200, body: refundBody({status: "processed", speed_processed: "instant"})}});
    expect(await gateway.createRefund(request())).toMatchObject({
      id: "rfnd_Direct001", status: "processed", speedProcessed: "instant",
    });
  });

  it("normalizes the provider's empty-array notes to an empty object, and drops unknown speed values", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 200, body: refundBody({notes: [], receipt: null, speed_requested: "warp"})}});
    const refund = await gateway.createRefund(request());
    expect(refund.notes).toEqual({});
    expect(refund.receipt).toBeUndefined();
    expect(refund.speedRequested).toBeUndefined();
  });

  it("sends a POST to the payment's refund endpoint with Basic auth, the idempotency header and a fixed-order JSON body", async () => {
    const {http, gateway} = harness();
    await gateway.createRefund(request());
    const [sent] = http.requests;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`https://api.razorpay.com/v1/payments/${PAYMENT}/refund`);
    expect(sent.headers["Authorization"]).toBe(`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`);
    expect(sent.headers["X-Refund-Idempotency"]).toBe("order-01-r1");
    expect(sent.headers["Content-Type"]).toBe("application/json");
    expect(sent.body).toBe(
      "{\"amount\":24000,\"speed\":\"normal\",\"receipt\":\"order-01-r1\"," +
      "\"notes\":{\"zestoRefundId\":\"order-01-r1\",\"zestoOrderId\":\"order-01\"}}",
    );
  });

  it("never asks for an instant (optimum) refund", async () => {
    const {http, gateway} = harness();
    await gateway.createRefund(request());
    expect(JSON.parse(http.requests[0].body ?? "{}").speed).toBe("normal");
  });

  it("does not follow redirects, so credentials can never be replayed to another host", async () => {
    const seen: unknown[] = [];
    const {gateway} = harness({
      fetchFn: async (_url, init) => {
        seen.push(init.redirect);
        return {status: 200, text: async () => JSON.stringify(refundBody())};
      },
    });
    await gateway.createRefund(request());
    expect(seen).toEqual(["manual"]);
  });

  it("rejects an answer for a different payment or amount as unreadable (ambiguous), not as a refund", async () => {
    for (const wrong of [{amount: 100}, {payment_id: "pay_Other0000001"}]) {
      const {http, gateway} = harness();
      http.script({respond: {status: 200, body: refundBody(wrong)}});
      const error = await failureOf(gateway.createRefund(request()));
      expect(error).toMatchObject({category: "AMBIGUOUS", code: "malformed_response", mayHaveBeenApplied: true});
    }
  });
});

describe("idempotency", () => {
  it("sends the EXACT same key and a byte-identical body on a retry, and the provider returns the same refund", async () => {
    const {http, gateway} = harness();
    const first = await gateway.createRefund(request());
    const retried = await gateway.createRefund(request());
    expect(retried).toEqual(first);
    expect(http.rawRefunds(PAYMENT)).toHaveLength(1);
    expect(http.requests[1].headers["X-Refund-Idempotency"]).toBe(http.requests[0].headers["X-Refund-Idempotency"]);
    expect(http.requests[1].body).toBe(http.requests[0].body);
  });

  it("the same key with a different body is a DEFINITIVE conflict, and creates nothing", async () => {
    const {http, gateway} = harness();
    await gateway.createRefund(request({amountInPaise: 100}));
    const error = await failureOf(gateway.createRefund(request({amountInPaise: 200})));
    expect(error).toMatchObject({category: "DEFINITIVE_FAILURE", code: "idempotency_key_conflict", httpStatus: 409});
    expect(http.rawRefunds(PAYMENT)).toHaveLength(1);
  });

  it.each(["short", "has space 1234", "bad/char/12345", "", "x".repeat(256)])(
    "refuses an invalid key (%j) locally — nothing is sent", async (idempotencyKey) => {
      const {http, gateway} = harness();
      const error = await failureOf(gateway.createRefund(request({idempotencyKey})));
      expect(error).toMatchObject({category: "DEFINITIVE_FAILURE", code: "invalid_input"});
      expect(http.requests).toEqual([]);
    });

  it("a request that arrives while the first is still running (409) is AMBIGUOUS, not a failure", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 409, body: {error: {
      code: "BAD_REQUEST_ERROR", description: "Another request with the same idempotency key is still in progress.",
    }}}});
    expect(await failureOf(gateway.createRefund(request()))).toMatchObject({
      category: "AMBIGUOUS", code: "request_in_progress", mayHaveBeenApplied: true,
    });
  });

  it("a 'duplicate receipt' answer is AMBIGUOUS (the refund likely exists), never a definitive failure", async () => {
    const {http, gateway} = harness();
    await gateway.createRefund(request());
    // Same receipt under a different key: what the provider documents as a duplicate receipt.
    const error = await failureOf(gateway.createRefund(request({idempotencyKey: "order-01-other-key"})));
    expect(error).toMatchObject({category: "AMBIGUOUS", code: "duplicate_receipt", httpStatus: 400});
    expect(http.rawRefunds(PAYMENT)).toHaveLength(1);
  });
});

describe("lost-response recovery", () => {
  it("finds a refund the provider created but whose answer was lost, by Zesto's refund ID, then retries safely", async () => {
    const {http, gateway} = harness();
    http.script({applyThenDrop: true});

    const lost = await failureOf(gateway.createRefund(request()));
    expect(lost).toBeInstanceOf(ProviderOutcomeUnknownError);
    expect(lost).toMatchObject({category: "AMBIGUOUS", code: "network_error", mayHaveBeenApplied: true});

    const listed = await gateway.listPaymentRefunds(PAYMENT);
    const found = findMatchingProviderRefund(listed, {
      providerPaymentId: PAYMENT, zestoRefundId: "order-01-r1", amountInPaise: 24000,
    });
    expect(found).toMatchObject({kind: "matched", matchedBy: "zesto_refund_id", refund: {id: "rfnd_Fake1"}});

    // Had the saga retried instead, the same key would still not create a second refund.
    expect((await gateway.createRefund(request())).id).toBe("rfnd_Fake1");
    expect(http.rawRefunds(PAYMENT)).toHaveLength(1);
  });

  it("finds no refund when the request never reached the provider", async () => {
    const {http, gateway} = harness();
    http.script({drop: true});
    await failureOf(gateway.createRefund(request()));
    const found = findMatchingProviderRefund(await gateway.listPaymentRefunds(PAYMENT), {
      providerPaymentId: PAYMENT, zestoRefundId: "order-01-r1", amountInPaise: 24000,
    });
    expect(found).toEqual({kind: "none", unattributedSameAmount: []});
  });

  it("an unreadable 2xx answer to a create is AMBIGUOUS and the refund is still findable", async () => {
    const {http, gateway} = harness();
    http.script({applyThenRespond: {status: 200, body: "<html>not json</html>"}});
    expect(await failureOf(gateway.createRefund(request()))).toMatchObject({
      category: "AMBIGUOUS", code: "malformed_response", mayHaveBeenApplied: true,
    });
    expect(await gateway.listPaymentRefunds(PAYMENT)).toHaveLength(1);
  });

  it("a failed lookup is itself a typed, retryable failure — never 'no refund found'", async () => {
    const {http, gateway} = harness();
    http.script({drop: true});
    expect(await failureOf(gateway.listPaymentRefunds(PAYMENT))).toMatchObject({
      category: "RETRYABLE_FAILURE", code: "network_error", mayHaveBeenApplied: false,
    });
  });
});

describe("timeout", () => {
  it("a create that never answers times out as AMBIGUOUS (not failed) and aborts the request", async () => {
    const {http, gateway} = harness({timeoutMs: 20});
    http.script({hang: true});
    const error = await failureOf(gateway.createRefund(request()));
    expect(error).toMatchObject({category: "AMBIGUOUS", code: "timeout", mayHaveBeenApplied: true});
  });

  it("a read that never answers times out as RETRYABLE with nothing applied", async () => {
    for (const call of [
      (gateway: RefundProviderGateway) => gateway.fetchPayment(PAYMENT),
      (gateway: RefundProviderGateway) => gateway.fetchRefund("rfnd_Fake1"),
      (gateway: RefundProviderGateway) => gateway.listPaymentRefunds(PAYMENT),
    ]) {
      const {http, gateway} = harness({timeoutMs: 20});
      http.script({hang: true});
      expect(await failureOf(call(gateway))).toMatchObject({
        category: "RETRYABLE_FAILURE", code: "timeout", mayHaveBeenApplied: false,
      });
    }
  });

  it("applies the default timeout when none is configured: still waiting just before it, timed out at it", async () => {
    vi.useFakeTimers();
    const {http, gateway} = harness({timeoutMs: undefined});
    http.script({hang: true});
    const settled = failureOf(gateway.createRefund(request()));
    await vi.advanceTimersByTimeAsync(DEFAULT_REFUND_REQUEST_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({code: "timeout"});
  });

  it("clears its timer once the answer arrives, so nothing is left running", async () => {
    vi.useFakeTimers();
    const {gateway} = harness();
    await gateway.createRefund(request());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a body that stalls after the headers also times out", async () => {
    const {gateway} = harness({
      timeoutMs: 20,
      fetchFn: async (_url, init) => ({
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      }),
    });
    expect(await failureOf(gateway.createRefund(request()))).toMatchObject({category: "AMBIGUOUS", code: "timeout"});
  });

  it.each([0, -1, 1.5, 30_001, NaN])("refuses an out-of-range timeout (%j) when the gateway is built", (timeoutMs) => {
    expect(() => createRazorpayRefundGateway({
      getCredentials: () => ({keyId: KEY_ID, keySecret: KEY_SECRET}), timeoutMs,
    })).toThrow("timeoutMs");
  });
});

describe("error classification", () => {
  const error = (description: string, code = "BAD_REQUEST_ERROR") => ({error: {code, description}});

  const writeCases: Array<[string, number, unknown, ProviderFailureCategory, string, boolean]> = [
    ["invalid request", 400, error("The refund amount provided is greater than amount captured"), "DEFINITIVE_FAILURE", "BAD_REQUEST_ERROR", false],
    ["payment not captured", 400, error("The payment has not been captured yet"), "DEFINITIVE_FAILURE", "BAD_REQUEST_ERROR", false],
    ["not found", 404, error("The requested URL was not found on the server."), "DEFINITIVE_FAILURE", "BAD_REQUEST_ERROR", false],
    ["duplicate receipt", 400, error("Duplicate receipt found"), "AMBIGUOUS", "duplicate_receipt", true],
    ["concurrent operation", 400, error("Concurrent operation in progress, please wait and retry"), "RETRYABLE_FAILURE", "concurrent_operation", true],
    ["unauthorized", 401, error("Authentication failed"), "AUTH_CONFIGURATION", "provider_auth_rejected", false],
    ["forbidden", 403, error("Forbidden"), "AUTH_CONFIGURATION", "provider_auth_rejected", false],
    ["conflicting key", 409, error("Different request with the same idempotency key has already been processed."), "DEFINITIVE_FAILURE", "idempotency_key_conflict", false],
    ["in progress", 409, error("Another request with the same idempotency key is still in progress."), "AMBIGUOUS", "request_in_progress", true],
    ["request timeout", 408, "", "AMBIGUOUS", "request_timeout", true],
    ["rate limited", 429, error("Too many requests"), "RETRYABLE_FAILURE", "rate_limited", false],
    ["server error", 500, error("Something went wrong", "SERVER_ERROR"), "RETRYABLE_FAILURE", "provider_server_error", true],
    ["bad gateway", 502, "<html>Bad Gateway</html>", "RETRYABLE_FAILURE", "provider_server_error", true],
    ["unavailable", 503, "", "RETRYABLE_FAILURE", "provider_server_error", true],
    ["gateway timeout", 504, "", "RETRYABLE_FAILURE", "provider_server_error", true],
    ["redirect", 302, "", "AMBIGUOUS", "unexpected_status", true],
  ];

  it.each(writeCases)("createRefund: %s (HTTP %i)", async (_name, status, body, category, code, mayHaveBeenApplied) => {
    const {http, gateway} = harness();
    http.script({respond: {status, body}});
    const failure = await failureOf(gateway.createRefund(request()));
    expect(failure).toMatchObject({category, code, mayHaveBeenApplied, httpStatus: status});
  });

  it("maps each category onto its own error type, so the saga can tell them apart", async () => {
    const types = new Map<number, unknown>([
      [400, ProviderRefundRejectedError], [429, ProviderRetryableError],
      [408, ProviderOutcomeUnknownError], [401, ProviderConfigurationError],
    ]);
    for (const [status, type] of types) {
      const {http, gateway} = harness();
      http.script({respond: {status, body: error("x")}});
      expect(await failureOf(gateway.createRefund(request()))).toBeInstanceOf(type);
    }
  });

  it.each([
    ["answer that is not JSON", "<html>oops</html>"],
    ["answer with no refund ID", refundBody({id: undefined})],
    ["answer with an unknown status", refundBody({status: "cancelled"})],
    ["answer with a fractional amount", refundBody({amount: 24000.5})],
    ["answer that is an array", []],
    ["empty answer", ""],
  ])("createRefund: a 2xx %s is AMBIGUOUS, never definitive", async (_name, body) => {
    const {http, gateway} = harness();
    http.script({respond: {status: 200, body}});
    expect(await failureOf(gateway.createRefund(request()))).toMatchObject({
      category: "AMBIGUOUS", code: "malformed_response", mayHaveBeenApplied: true,
    });
  });

  it("never retries by itself: one call is one request, even after a 429", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 429, body: error("Too many requests")}});
    await failureOf(gateway.createRefund(request()));
    expect(http.requests).toHaveLength(1);
  });

  it("reads: 429 / 5xx / network / unreadable are RETRYABLE with nothing applied; 4xx is definitive; 401 is configuration", async () => {
    const cases: Array<[number | "drop" | "garbage", ProviderFailureCategory, string]> = [
      [429, "RETRYABLE_FAILURE", "rate_limited"],
      [503, "RETRYABLE_FAILURE", "provider_server_error"],
      [409, "RETRYABLE_FAILURE", "conflict"],
      [302, "RETRYABLE_FAILURE", "unexpected_status"],
      ["drop", "RETRYABLE_FAILURE", "network_error"],
      ["garbage", "RETRYABLE_FAILURE", "malformed_response"],
      [400, "DEFINITIVE_FAILURE", "BAD_REQUEST_ERROR"],
      [401, "AUTH_CONFIGURATION", "provider_auth_rejected"],
    ];
    for (const [behaviour, category, code] of cases) {
      const {http, gateway} = harness();
      http.script(behaviour === "drop" ? {drop: true} :
        behaviour === "garbage" ? {respond: {status: 200, body: "{"}} :
          {respond: {status: behaviour, body: error("x")}});
      const failure = await failureOf(gateway.fetchPayment(PAYMENT));
      expect(failure).toMatchObject({category, code});
      expect(failure.mayHaveBeenApplied).toBe(false);
    }
  });
});

describe("configuration", () => {
  it("missing credentials are an AUTH_CONFIGURATION failure raised before any request", async () => {
    const {http, gateway} = harness({
      getCredentials: () => {
        throw new Error(`RAZORPAY_KEY_SECRET is not configured. (${KEY_SECRET})`);
      },
    });
    const error = await failureOf(gateway.createRefund(request()));
    expect(error).toMatchObject({category: "AUTH_CONFIGURATION", code: "credentials_missing"});
    expect(error.message).not.toContain(KEY_SECRET);
    expect(http.requests).toEqual([]);
  });

  it("blank credentials are refused the same way", async () => {
    const {http, gateway} = harness({getCredentials: () => ({keyId: KEY_ID, keySecret: ""})});
    expect(await failureOf(gateway.fetchPayment(PAYMENT))).toMatchObject({category: "AUTH_CONFIGURATION"});
    expect(http.requests).toEqual([]);
  });

  it("credentials the provider rejects (401) are AUTH_CONFIGURATION, never a refund failure", async () => {
    const {gateway} = harness({getCredentials: () => ({keyId: KEY_ID, keySecret: "wrong_secret_value"})});
    expect(await failureOf(gateway.createRefund(request()))).toMatchObject({
      category: "AUTH_CONFIGURATION", code: "provider_auth_rejected", mayHaveBeenApplied: false,
    });
  });

  it("the shared gateway reads the server-side key params at call time and uses the global fetch against the real host", async () => {
    vi.stubEnv("RAZORPAY_KEY_ID", KEY_ID);
    vi.stubEnv("RAZORPAY_KEY_SECRET", KEY_SECRET);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      id: PAYMENT, amount: 24000, currency: "INR", status: "captured", captured: true,
      order_id: "order_TestOrder001", amount_refunded: 0,
    }), {status: 200}));
    vi.stubGlobal("fetch", fetchSpy);

    const gateway = getRazorpayRefundGateway();
    expect(getRazorpayRefundGateway()).toBe(gateway);
    expect(await gateway.fetchPayment(PAYMENT)).toMatchObject({id: PAYMENT, captured: true});
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, {headers: Record<string, string>}];
    expect(url).toBe(`https://api.razorpay.com/v1/payments/${PAYMENT}`);
    expect(init.headers["Authorization"]).toBe(`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`);

    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    expect(await failureOf(gateway.fetchPayment(PAYMENT))).toMatchObject({category: "AUTH_CONFIGURATION"});
  });
});

describe("secret and data safety", () => {
  it("no error message, code or log line ever contains the secret, the key ID or the Authorization header", async () => {
    const authHeader = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
    const bodies = [
      {status: 400, body: {error: {code: "BAD_REQUEST_ERROR", description: `bad ${KEY_SECRET} and ${KEY_ID}`}}},
      {status: 500, body: `echo ${KEY_SECRET}`},
      {status: 200, body: `{"echo":"${KEY_SECRET}"`},
    ];
    for (const response of bodies) {
      const {http, gateway} = harness();
      http.script({respond: response});
      const failure = await failureOf(gateway.createRefund(request()));
      const everything = JSON.stringify([failure.message, failure.code, failure.name, logged.calls]);
      expect(everything).not.toContain(KEY_SECRET);
      expect(everything).not.toContain(KEY_ID);
      expect(everything).not.toContain(authHeader);
      expect(everything).not.toContain("Basic ");
    }
    // The echoed secret is replaced, not merely dropped.
    const {http, gateway} = harness();
    http.script({respond: {status: 400, body: {error: {code: "BAD_REQUEST_ERROR", description: `bad ${KEY_SECRET}`}}}});
    expect((await failureOf(gateway.createRefund(request()))).message).toContain("[redacted]");
  });

  it("bounds a provider description and strips control characters and a hostile error code", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 400, body: {error: {
      code: "<script>alert(1)</script>", description: `line1\nline2\u0000${"x".repeat(5000)}`,
    }}}});
    const failure = await failureOf(gateway.createRefund(request()));
    expect(failure.code).toBe("provider_error");
    expect(failure.message.length).toBeLessThan(300);
    expect(failure.message.includes("\n")).toBe(false);
    expect(failure.message.includes("\u0000")).toBe(false);
  });

  it("logs only the operation, category, code and status — never a request or response body", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 400, body: {error: {code: "BAD_REQUEST_ERROR", description: "private-detail"}}}});
    await failureOf(gateway.createRefund(request()));
    expect(logged.calls).toHaveLength(1);
    const fields = logged.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["category", "code", "httpStatus", "operation"]);
  });

  it("puts nothing about the customer in the request: only Zesto's own IDs", async () => {
    const {http, gateway} = harness();
    await gateway.createRefund(request());
    const body = JSON.parse(http.requests[0].body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["amount", "notes", "receipt", "speed"]);
    expect(Object.keys(body.notes as object).sort()).toEqual(["zestoOrderId", "zestoRefundId"]);
  });

  it("never lets a caller-supplied ID reshape the URL", async () => {
    const {http, gateway} = harness();
    for (const bad of ["../orders", "pay_1/refund", "pay_1?x=1", "", "pay 1", "pay_1#"]) {
      expect(await failureOf(gateway.fetchPayment(bad))).toMatchObject({code: "invalid_input"});
      expect(await failureOf(gateway.fetchRefund(bad))).toMatchObject({code: "invalid_input"});
      expect(await failureOf(gateway.listPaymentRefunds(bad))).toMatchObject({code: "invalid_input"});
      expect(await failureOf(gateway.createRefund(request({providerPaymentId: bad})))).toMatchObject({code: "invalid_input"});
    }
    expect(http.requests).toEqual([]);
  });

  it.each([0, -5, 1.5, NaN, Infinity])("refuses a refund amount of %j locally — nothing is sent", async (amountInPaise) => {
    const {http, gateway} = harness();
    expect(await failureOf(gateway.createRefund(request({amountInPaise})))).toMatchObject({code: "invalid_input"});
    expect(http.requests).toEqual([]);
  });

  it("refuses a refund with no receipt locally", async () => {
    const {http, gateway} = harness();
    expect(await failureOf(gateway.createRefund(request({receipt: ""})))).toMatchObject({code: "invalid_input"});
    expect(http.requests).toEqual([]);
  });
});

describe("fetchPayment", () => {
  it("returns a normalized payment with only the fields reconciliation needs — no customer data", async () => {
    const {http, gateway} = harness();
    const payment = await gateway.fetchPayment(PAYMENT);
    expect(payment).toEqual({
      id: PAYMENT, providerOrderId: "order_TestOrder001", amountInPaise: 24000, currency: "INR",
      status: "captured", captured: true, amountRefundedInPaise: 0,
    });
    expect(http.requests[0].method).toBe("GET");
    expect(http.requests[0].headers["Content-Type"]).toBeUndefined();
    expect(http.requests[0].body).toBeUndefined();
  });

  it("reflects refunds, and reports an authorized (uncaptured) payment as such", async () => {
    const {http, gateway} = harness();
    http.addPayment({id: "pay_Authorized001", amount: 500, status: "authorized", captured: false});
    expect(await gateway.fetchPayment("pay_Authorized001")).toMatchObject({status: "authorized", captured: false});
    await gateway.createRefund(request({amountInPaise: 24000}));
    expect(await gateway.fetchPayment(PAYMENT)).toMatchObject({
      status: "refunded", captured: true, amountRefundedInPaise: 24000,
    });
  });

  it("a payment with a missing or malformed amount_refunded is unreadable, not assumed unrefunded", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 200, body: {
      id: PAYMENT, amount: 24000, currency: "INR", status: "captured", captured: true, order_id: null,
    }}});
    expect(await failureOf(gateway.fetchPayment(PAYMENT))).toMatchObject({code: "malformed_response"});
  });

  it("an unknown payment is a definitive failure", async () => {
    expect(await failureOf(harness().gateway.fetchPayment("pay_Unknown0001"))).toMatchObject({
      category: "DEFINITIVE_FAILURE", httpStatus: 400,
    });
  });
});

describe("fetchRefund", () => {
  it("returns the normalized refund by provider ID", async () => {
    const {http, gateway} = harness();
    const created = await gateway.createRefund(request());
    expect(await gateway.fetchRefund(created.id)).toEqual(created);
    expect(http.requests[1].url).toBe(`https://api.razorpay.com/v1/refunds/${created.id}`);
  });

  it("an unknown refund is a definitive failure", async () => {
    expect(await failureOf(harness().gateway.fetchRefund("rfnd_Unknown001"))).toMatchObject({
      category: "DEFINITIVE_FAILURE",
    });
  });
});

describe("listPaymentRefunds", () => {
  async function seed(gateway: RefundProviderGateway, http: FakeRazorpayHttp, count: number): Promise<void> {
    http.addPayment({id: "pay_Many0000001", amount: 100 * 300});
    for (let i = 1; i <= count; i += 1) {
      await gateway.createRefund(request({
        providerPaymentId: "pay_Many0000001", amountInPaise: 100,
        idempotencyKey: `many-order-r${i}`, receipt: `many-order-r${i}`,
        notes: {zestoRefundId: `many-order-r${i}`, zestoOrderId: "many-order"},
      }));
    }
  }

  it("returns every refund of the payment, paging 100 at a time", async () => {
    const {http, gateway} = harness();
    await seed(gateway, http, 250);
    const before = http.requests.length;
    const refunds = await gateway.listPaymentRefunds("pay_Many0000001");
    expect(refunds).toHaveLength(250);
    expect(new Set(refunds.map((refund) => refund.id)).size).toBe(250);
    const pages = http.requests.slice(before);
    expect(pages.map((page) => [page.query.count, page.query.skip])).toEqual([["100", "0"], ["100", "100"], ["100", "200"]]);
  });

  it("asks once more after an exactly-full page, and stops when that comes back empty", async () => {
    const {http, gateway} = harness();
    await seed(gateway, http, 100);
    const before = http.requests.length;
    expect(await gateway.listPaymentRefunds("pay_Many0000001")).toHaveLength(100);
    expect(http.requests.length - before).toBe(2);
  });

  it("returns an empty list for a payment with no refunds", async () => {
    expect(await harness().gateway.listPaymentRefunds(PAYMENT)).toEqual([]);
  });

  it("one unreadable item fails the whole listing: skipping it could skip Zesto's own refund", async () => {
    const {http, gateway} = harness();
    http.script({respond: {status: 200, body: {
      entity: "collection", count: 2, items: [refundBody(), refundBody({id: "rfnd_Bad", status: "cancelled"})],
    }}});
    expect(await failureOf(gateway.listPaymentRefunds(PAYMENT))).toMatchObject({
      category: "RETRYABLE_FAILURE", code: "malformed_response",
    });
  });

  it("gives up with a retryable failure rather than looping if the provider never ends the list", async () => {
    const {http, gateway} = harness();
    const fullPage = {entity: "collection", count: 100, items: Array.from({length: 100}, (_unused, i) => refundBody({id: `rfnd_${i}`}))};
    http.script(...Array.from({length: 20}, () => ({respond: {status: 200, body: fullPage}})));
    expect(await failureOf(gateway.listPaymentRefunds(PAYMENT))).toMatchObject({
      category: "RETRYABLE_FAILURE", code: "pagination_limit_exceeded",
    });
    expect(http.requests).toHaveLength(20);
  });

  it("every listed refund is normalized: receipt and notes survive for matching, raw fields do not", async () => {
    const {gateway} = harness();
    await gateway.createRefund(request());
    const [refund] = await gateway.listPaymentRefunds(PAYMENT);
    expect(refund.receipt).toBe("order-01-r1");
    expect(refund.notes.zestoRefundId).toBe("order-01-r1");
    expect(refund).not.toHaveProperty("acquirer_data");
    expect(refund).not.toHaveProperty("entity");
  });

  it("keeps two refunds of the same amount on one payment apart by their Zesto IDs", async () => {
    const {http, gateway} = harness();
    http.addPayment({id: "pay_Two00000001", amount: 400});
    for (const n of [1, 2]) {
      await gateway.createRefund(request({
        providerPaymentId: "pay_Two00000001", amountInPaise: 200,
        idempotencyKey: `two-order-r${n}`, receipt: `two-order-r${n}`,
        notes: {zestoRefundId: `two-order-r${n}`, zestoOrderId: "two-order"},
      }));
    }
    const refunds = await gateway.listPaymentRefunds("pay_Two00000001");
    const second = findMatchingProviderRefund(refunds, {
      providerPaymentId: "pay_Two00000001", zestoRefundId: "two-order-r2", amountInPaise: 200,
    });
    expect(second).toMatchObject({kind: "matched", refund: {receipt: "two-order-r2"}});
  });
});

// @vitest-environment node
import {beforeEach, describe, expect, it, vi} from "vitest";

const logged = vi.hoisted(() => ({calls: [] as unknown[][]}));
vi.mock("firebase-functions/logger", () => {
  const record = (...args: unknown[]) => {
    logged.calls.push(args);
  };
  return {warn: record, error: record, info: record, debug: record, log: record};
});

import {createRazorpayPaymentLookupGateway} from "./razorpayPayments";
import type {FetchLike} from "./razorpayRefunds";
import {isRefundProviderError, type ProviderFailureCategory} from "./refundGateway";

// Obviously fake values: no real credential appears in this repository.
const KEY_ID = "rzp_test_FAKEKEYID000";
const KEY_SECRET = "FAKE_SECRET_never_a_real_credential";
const ORDER = "order_TestOrder001";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function gatewayAnswering(status: number, body: unknown, seen: Seen[] = []) {
  const fetchFn: FetchLike = async (url, init) => {
    seen.push({method: init.method, url, headers: init.headers});
    return {status, text: async () => (typeof body === "string" ? body : JSON.stringify(body))};
  };
  return createRazorpayPaymentLookupGateway({
    getCredentials: () => ({keyId: KEY_ID, keySecret: KEY_SECRET}), fetchFn, timeoutMs: 1000,
  });
}

function rawPayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pay_One", entity: "payment", order_id: ORDER, amount: 24000, currency: "INR", status: "captured",
    captured: true, amount_refunded: 0, created_at: 1_700_000_000, method: "upi", card: {last4: "1111"},
    email: "customer@example.com", contact: "+910000000000", notes: [], ...overrides,
  };
}

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

beforeEach(() => {
  logged.calls.length = 0;
});

describe("listOrderPayments", () => {
  it("asks for the order's payments with a read-only GET, sending no query, body or customer data", async () => {
    const seen: Seen[] = [];
    await gatewayAnswering(200, {entity: "collection", count: 0, items: []}, seen).listOrderPayments(ORDER);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`https://api.razorpay.com/v1/orders/${ORDER}/payments`);
    expect(seen[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`);
  });

  it("returns only provider-neutral fields: no card, email, contact or other raw detail leaks through", async () => {
    const payments = await gatewayAnswering(200, {entity: "collection", count: 1, items: [rawPayment()]}).listOrderPayments(ORDER);

    expect(payments).toEqual([{
      id: "pay_One", providerOrderId: ORDER, amountInPaise: 24000, currency: "INR", status: "captured",
      captured: true, amountRefundedInPaise: 0, createdAtEpochSeconds: 1_700_000_000,
    }]);
  });

  it("returns an empty list for an order nobody tried to pay", async () => {
    expect(await gatewayAnswering(200, {entity: "collection", count: 0, items: []}).listOrderPayments(ORDER)).toEqual([]);
  });

  it("reports every attempt, whatever its status, with a missing order_id as null", async () => {
    const payments = await gatewayAnswering(200, {
      items: [
        rawPayment({id: "pay_A", status: "failed", captured: false}),
        rawPayment({id: "pay_B", status: "authorized", captured: false}),
        rawPayment({id: "pay_C", order_id: null, status: "created", captured: false, amount_refunded: null, created_at: null}),
      ],
    }).listOrderPayments(ORDER);

    expect(payments.map((p) => [p.id, p.status, p.providerOrderId])).toEqual([
      ["pay_A", "failed", ORDER], ["pay_B", "authorized", ORDER], ["pay_C", "created", null],
    ]);
    expect(payments[2]).toMatchObject({amountRefundedInPaise: 0});
    expect(payments[2].createdAtEpochSeconds).toBeUndefined();
  });

  it.each([
    ["an unreadable item", {items: [rawPayment(), {id: "pay_bad"}]}],
    ["an unknown status", {items: [rawPayment({status: "teleported"})]}],
    ["no items array", {entity: "collection"}],
    ["a fractional amount", {items: [rawPayment({amount: 10.5})]}],
    ["non-JSON", "<html>gateway</html>"],
  ])("%s fails the WHOLE listing as a retryable read (skipping an item could skip the payment)", async (_name, body) => {
    const error = await failureOf(gatewayAnswering(200, body).listOrderPayments(ORDER));
    expect(error.category).toBe("RETRYABLE_FAILURE");
    expect(error.code).toBe("malformed_response");
  });

  it("refuses an implausibly long listing instead of reading it", async () => {
    const items = Array.from({length: 501}, (_v, i) => rawPayment({id: `pay_${i}`}));
    expect((await failureOf(gatewayAnswering(200, {items}).listOrderPayments(ORDER))).code).toBe("malformed_response");
  });

  it.each<[number, ProviderFailureCategory, string]>([
    [401, "AUTH_CONFIGURATION", "provider_auth_rejected"],
    [403, "AUTH_CONFIGURATION", "provider_auth_rejected"],
    [429, "RETRYABLE_FAILURE", "rate_limited"],
    [500, "RETRYABLE_FAILURE", "provider_server_error"],
    [503, "RETRYABLE_FAILURE", "provider_server_error"],
    [404, "DEFINITIVE_FAILURE", "provider_error"],
  ])("HTTP %i is %s, never an answer about the payment", async (status, category, code) => {
    const error = await failureOf(gatewayAnswering(status, {error: {code: "BAD_REQUEST_ERROR", description: "no"}}).listOrderPayments(ORDER));
    expect(error.category).toBe(category);
    if (status !== 404) {
      expect(error.code).toBe(code);
    }
    expect(error.mayHaveBeenApplied).toBe(false);
  });

  it("a dropped connection and a timeout are retryable reads, not failures of the payment", async () => {
    const dropping = createRazorpayPaymentLookupGateway({
      getCredentials: () => ({keyId: KEY_ID, keySecret: KEY_SECRET}),
      fetchFn: async () => {
        throw new TypeError("fetch failed");
      },
      timeoutMs: 1000,
    });
    const dropped = await failureOf(dropping.listOrderPayments(ORDER));
    expect(dropped).toMatchObject({category: "RETRYABLE_FAILURE", code: "network_error", mayHaveBeenApplied: false});

    const hanging = createRazorpayPaymentLookupGateway({
      getCredentials: () => ({keyId: KEY_ID, keySecret: KEY_SECRET}),
      fetchFn: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      timeoutMs: 20,
    });
    expect(await failureOf(hanging.listOrderPayments(ORDER))).toMatchObject({category: "RETRYABLE_FAILURE", code: "timeout"});
  });

  it("missing credentials are a configuration failure and nothing is sent", async () => {
    const fetchFn = vi.fn();
    const gateway = createRazorpayPaymentLookupGateway({
      getCredentials: () => {
        throw new Error("RAZORPAY_KEY_ID is not configured.");
      },
      fetchFn: fetchFn as unknown as FetchLike,
    });
    expect(await failureOf(gateway.listOrderPayments(ORDER))).toMatchObject({category: "AUTH_CONFIGURATION", code: "credentials_missing"});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never puts an unsafe order ID in a URL", async () => {
    const seen: Seen[] = [];
    const error = await failureOf(gatewayAnswering(200, {items: []}, seen).listOrderPayments("order_x/../../refunds"));
    expect(error.code).toBe("invalid_input");
    expect(seen).toEqual([]);
  });

  it("never logs a credential or a customer detail", async () => {
    await failureOf(gatewayAnswering(500, `error mentioning ${KEY_SECRET} and customer@example.com`).listOrderPayments(ORDER));
    const text = JSON.stringify(logged.calls);
    expect(text).not.toContain(KEY_SECRET);
    expect(text).not.toContain("customer@example.com");
  });
});

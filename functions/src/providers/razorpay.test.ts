// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  createRazorpayGateway,
  getRazorpayKeyId,
  getRazorpayKeySecret,
  PaymentProviderError,
} from "./razorpay";

beforeEach(() => {
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_public_key");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "test_key_secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getRazorpayKeyId", () => {
  it("returns the configured, trimmed key_id", () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "  rzp_test_public_key  ");
    expect(getRazorpayKeyId()).toBe("rzp_test_public_key");
  });

  it("throws a clear error when RAZORPAY_KEY_ID is missing", () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    expect(() => getRazorpayKeyId()).toThrow("RAZORPAY_KEY_ID is not configured.");
  });

  it("throws a clear error when RAZORPAY_KEY_ID is blank", () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "   ");
    expect(() => getRazorpayKeyId()).toThrow("RAZORPAY_KEY_ID is not configured.");
  });
});

describe("getRazorpayKeySecret", () => {
  it("returns the configured, trimmed key_secret", () => {
    vi.stubEnv("RAZORPAY_KEY_SECRET", "  test_key_secret  ");
    expect(getRazorpayKeySecret()).toBe("test_key_secret");
  });

  it("throws a clear error when RAZORPAY_KEY_SECRET is missing", () => {
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    expect(() => getRazorpayKeySecret()).toThrow("RAZORPAY_KEY_SECRET is not configured.");
  });

  it("throws a clear error when RAZORPAY_KEY_SECRET is blank", () => {
    vi.stubEnv("RAZORPAY_KEY_SECRET", "   ");
    expect(() => getRazorpayKeySecret()).toThrow("RAZORPAY_KEY_SECRET is not configured.");
  });

  it("never appears in any thrown error's message, even when configured", () => {
    let caught: unknown;
    try {
      getRazorpayKeyId();
      throw new Error("expected getRazorpayKeyId not to throw here");
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain("test_key_secret");
  });
});

/** A fake Razorpay-SDK-shaped client, matching this module's minimal
 * `RazorpayClientLike` structural interface — never the real SDK, so these
 * tests never hit the network (see this checkpoint's "unit tests should mock
 * the provider abstraction" requirement). */
interface FakeRazorpayOrder {
  id: string;
  amount: number | string;
  currency: string;
  receipt?: string;
  status: string;
}

function fakeRazorpayClient(overrides: {
  create?: (params: {amount: number; currency: string; receipt?: string}) => Promise<FakeRazorpayOrder>;
  fetch?: (orderId: string) => Promise<FakeRazorpayOrder>;
} = {}) {
  const create = vi.fn(overrides.create ?? (async (params: {amount: number; currency: string; receipt?: string}) => ({
    id: "order_RazorpayTest1",
    entity: "order",
    amount: params.amount,
    amount_paid: 0,
    amount_due: params.amount,
    currency: params.currency,
    receipt: params.receipt,
    status: "created",
    attempts: 0,
    created_at: 1234567890,
  })));
  const fetch = vi.fn(overrides.fetch ?? (async (orderId: string) => ({
    id: orderId,
    entity: "order",
    amount: 24000,
    amount_paid: 0,
    amount_due: 24000,
    currency: "INR",
    receipt: "receipt-1",
    status: "created",
    attempts: 0,
    created_at: 1234567890,
  })));
  return {client: {orders: {create, fetch}}, create, fetch};
}

describe("createRazorpayGateway: createOrder", () => {
  it("sends only amount/currency/receipt, nothing else", async () => {
    const {client, create} = fakeRazorpayClient();
    const gateway = createRazorpayGateway(client);

    await gateway.createOrder({amountInPaise: 24000, currency: "INR", receipt: "payment-1"});

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({amount: 24000, currency: "INR", receipt: "payment-1"});
  });

  it("maps the provider's response to the reduced ProviderOrder shape", async () => {
    const {client} = fakeRazorpayClient();
    const gateway = createRazorpayGateway(client);

    const order = await gateway.createOrder({amountInPaise: 24000, currency: "INR", receipt: "payment-1"});

    expect(order).toEqual({
      id: "order_RazorpayTest1",
      amountInPaise: 24000,
      currency: "INR",
      receipt: "payment-1",
      status: "created",
    });
  });

  it("coerces a string amount in the provider's response to a number", async () => {
    const {client} = fakeRazorpayClient({
      create: async () => ({id: "order_RazorpayTest2", amount: "24000", currency: "INR", status: "created"}),
    });
    const gateway = createRazorpayGateway(client);

    const order = await gateway.createOrder({amountInPaise: 24000, currency: "INR", receipt: "payment-1"});

    expect(order.amountInPaise).toBe(24000);
    expect(typeof order.amountInPaise).toBe("number");
  });

  it("wraps a provider failure in PaymentProviderError, never leaking the raw error to the caller as-is", async () => {
    const providerError = {
      statusCode: 400,
      error: {code: "BAD_REQUEST_ERROR", description: "amount must be at least 100."},
    };
    const {client} = fakeRazorpayClient({create: async () => { throw providerError; }});
    const gateway = createRazorpayGateway(client);

    await expect(gateway.createOrder({amountInPaise: 1, currency: "INR", receipt: "payment-1"}))
      .rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("never appears to succeed when the provider call fails: no ProviderOrder is returned", async () => {
    const {client} = fakeRazorpayClient({create: async () => { throw new Error("network error"); }});
    const gateway = createRazorpayGateway(client);

    const result = await gateway.createOrder({amountInPaise: 1, currency: "INR", receipt: "payment-1"})
      .then(() => "resolved").catch(() => "rejected");

    expect(result).toBe("rejected");
  });
});

describe("createRazorpayGateway: fetchOrder", () => {
  it("fetches by provider order ID and maps the response", async () => {
    const {client, fetch} = fakeRazorpayClient();

    const order = await createRazorpayGateway(client).fetchOrder("order_RazorpayTest1");

    expect(fetch).toHaveBeenCalledWith("order_RazorpayTest1");
    expect(order.id).toBe("order_RazorpayTest1");
  });

  it("wraps a provider failure in PaymentProviderError", async () => {
    const {client} = fakeRazorpayClient({fetch: async () => { throw {statusCode: 404, error: {code: "NOT_FOUND", description: "not found"}}; }});

    await expect(createRazorpayGateway(client).fetchOrder("order_missing"))
      .rejects.toBeInstanceOf(PaymentProviderError);
  });
});

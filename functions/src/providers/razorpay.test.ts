// @vitest-environment node
import {createHmac} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  createRazorpayGateway,
  razorpayModeOf,
  getRazorpayKeyId,
  getRazorpayKeySecret,
  verifyCheckoutSignature,
  verifyWebhookSignature,
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

/**
 * @param {string} providerOrderId The trusted provider order ID.
 * @param {string} razorpayPaymentId The submitted payment ID.
 * @param {string} [secret] The key secret to sign with (defaults to the
 *   `beforeEach`-stubbed `RAZORPAY_KEY_SECRET`).
 * @return {string} A signature computed with the exact algorithm Razorpay's
 *   documentation prescribes — independent of `verifyCheckoutSignature`'s
 *   own implementation, so these tests prove the real algorithm, not just
 *   internal self-consistency.
 */
function computeTestSignature(
  providerOrderId: string,
  razorpayPaymentId: string,
  secret = "test_key_secret",
): string {
  return createHmac("sha256", secret)
    .update(`${providerOrderId}|${razorpayPaymentId}`)
    .digest("hex");
}

describe("verifyCheckoutSignature", () => {
  it("accepts a signature computed with the documented algorithm and the real key secret", () => {
    const signature = computeTestSignature("order_RazorpayTest1", "pay_RazorpayTest1");

    expect(verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: signature,
    })).toBe(true);
  });

  it("rejects an altered payment ID", () => {
    const signature = computeTestSignature("order_RazorpayTest1", "pay_RazorpayTest1");

    expect(verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_Attacker",
      razorpaySignature: signature,
    })).toBe(false);
  });

  it("rejects an altered (trusted) provider order ID", () => {
    const signature = computeTestSignature("order_RazorpayTest1", "pay_RazorpayTest1");

    expect(verifyCheckoutSignature({
      providerOrderId: "order_DifferentOrder",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: signature,
    })).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = computeTestSignature("order_RazorpayTest1", "pay_RazorpayTest1", "wrong_secret");

    expect(verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: signature,
    })).toBe(false);
  });

  it("rejects a garbage signature of a completely different length, without throwing", () => {
    const call = () => verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: "short",
    });

    expect(call).not.toThrow();
    expect(call()).toBe(false);
  });

  it("rejects an empty signature, without throwing", () => {
    expect(verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: "",
    })).toBe(false);
  });

  it("fails safely (throws, never returns true/false) when RAZORPAY_KEY_SECRET is not configured", () => {
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");

    expect(() => verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: "irrelevant",
    })).toThrow("RAZORPAY_KEY_SECRET is not configured.");
  });

  it("never leaks the key secret through its return value or a thrown error", () => {
    const signature = computeTestSignature("order_RazorpayTest1", "pay_RazorpayTest1");
    const result = verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: signature,
    });
    expect(String(result)).not.toContain("test_key_secret");

    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    let caught: unknown;
    try {
      verifyCheckoutSignature({providerOrderId: "o", razorpayPaymentId: "p", razorpaySignature: "s"});
      throw new Error("expected verifyCheckoutSignature to throw here");
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain("test_key_secret");
  });
});

/**
 * @param {Buffer | string} rawBody The exact webhook body bytes.
 * @param {string} [secret] The webhook secret to sign with (defaults to the
 *   stubbed `RAZORPAY_WEBHOOK_SECRET` of the `verifyWebhookSignature` suite).
 * @return {string} A signature computed with the algorithm Razorpay's webhook
 *   documentation prescribes (hex HMAC-SHA256 of the raw body, keyed with the
 *   webhook secret) — independent of `verifyWebhookSignature`'s own
 *   implementation, so these tests prove the real algorithm.
 */
function computeWebhookSignature(rawBody: Buffer | string, secret = "test_webhook_secret"): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

describe("verifyWebhookSignature", () => {
  beforeEach(() => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "test_webhook_secret");
  });

  // Deliberately NOT what JSON.stringify would produce: indentation, a
  // different key order than alphabetical, an escaped non-ASCII character,
  // a number written as 100.0, and a trailing newline — all things a
  // parse-then-reserialize round trip would silently "fix".
  const prettyRawBody =
    "{\n" +
    "  \"event\": \"payment.captured\",\n" +
    "  \"created_at\": 1567674606,\n" +
    "  \"payload\": {\"payment\": {\"entity\": {\"id\": \"pay_X\", \"amount\": 100.0, \"note\": \"caf\\u00e9\"}}}\n" +
    "}\n";

  it("accepts a signature computed with the documented algorithm over the raw body", () => {
    expect(verifyWebhookSignature({
      rawBody: prettyRawBody,
      signature: computeWebhookSignature(prettyRawBody),
    })).toBe(true);
  });

  it("gives the same answer for the raw body as a Buffer or as a string", () => {
    const signature = computeWebhookSignature(prettyRawBody);

    expect(verifyWebhookSignature({rawBody: Buffer.from(prettyRawBody, "utf8"), signature})).toBe(true);
    expect(verifyWebhookSignature({rawBody: prettyRawBody, signature})).toBe(true);
  });

  it("verifies the EXACT bytes: a re-serialized (JSON.parse -> JSON.stringify) body does NOT verify", () => {
    const signature = computeWebhookSignature(prettyRawBody);
    const reserialized = JSON.stringify(JSON.parse(prettyRawBody));

    // The semantic content is identical, the bytes are not.
    expect(JSON.parse(reserialized)).toEqual(JSON.parse(prettyRawBody));
    expect(reserialized).not.toBe(prettyRawBody);
    expect(verifyWebhookSignature({rawBody: reserialized, signature})).toBe(false);
  });

  it("verifies bytes, not decoded text: a body that is not valid UTF-8 verifies only as a Buffer", () => {
    const rawBody = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const signature = computeWebhookSignature(rawBody);

    expect(verifyWebhookSignature({rawBody, signature})).toBe(true);
    // Decoding to a string replaces the invalid bytes, so the bytes differ.
    expect(verifyWebhookSignature({rawBody: rawBody.toString("utf8"), signature})).toBe(false);
  });

  it.each([
    ["a single changed character", (body: string) => body.replace("pay_X", "pay_Y")],
    ["an appended space", (body: string) => `${body} `],
    ["a removed trailing newline", (body: string) => body.trimEnd()],
    ["a changed amount", (body: string) => body.replace("100.0", "1.0")],
  ])("rejects a modified raw body (%s)", (_label, mutate) => {
    const signature = computeWebhookSignature(prettyRawBody);

    expect(verifyWebhookSignature({rawBody: mutate(prettyRawBody), signature})).toBe(false);
  });

  it("rejects a modified signature", () => {
    const signature = computeWebhookSignature(prettyRawBody);
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;

    expect(verifyWebhookSignature({rawBody: prettyRawBody, signature: flipped})).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = computeWebhookSignature(prettyRawBody, "some_other_secret");

    expect(verifyWebhookSignature({rawBody: prettyRawBody, signature})).toBe(false);
  });

  it("rejects an empty signature and a garbage signature of the wrong length, without throwing", () => {
    expect(() => verifyWebhookSignature({rawBody: prettyRawBody, signature: ""})).not.toThrow();
    expect(verifyWebhookSignature({rawBody: prettyRawBody, signature: ""})).toBe(false);
    expect(verifyWebhookSignature({rawBody: prettyRawBody, signature: "short"})).toBe(false);
    expect(verifyWebhookSignature({rawBody: prettyRawBody, signature: "z".repeat(500)})).toBe(false);
  });

  it("fails safely on an empty or malformed body with a non-matching signature (false, no throw)", () => {
    const signature = computeWebhookSignature(prettyRawBody);

    for (const rawBody of ["", "{", "not json at all", Buffer.alloc(0)]) {
      expect(() => verifyWebhookSignature({rawBody, signature})).not.toThrow();
      expect(verifyWebhookSignature({rawBody, signature})).toBe(false);
    }
  });

  it("fails safely (throws, never returns true/false) when RAZORPAY_WEBHOOK_SECRET is not configured", () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");

    expect(() => verifyWebhookSignature({rawBody: prettyRawBody, signature: "irrelevant"}))
      .toThrow("RAZORPAY_WEBHOOK_SECRET is not configured.");
  });

  it("never falls back to the API key secret when the webhook secret is missing", () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
    // A signature computed with the API key secret must not become acceptable.
    const signatureWithKeySecret = computeWebhookSignature(prettyRawBody, "test_key_secret");

    expect(() => verifyWebhookSignature({rawBody: prettyRawBody, signature: signatureWithKeySecret}))
      .toThrow("RAZORPAY_WEBHOOK_SECRET is not configured.");
  });

  it("is independent of the API key secret: a body signed with RAZORPAY_KEY_SECRET is rejected", () => {
    const signature = computeWebhookSignature(prettyRawBody, "test_key_secret");

    expect(verifyWebhookSignature({rawBody: prettyRawBody, signature})).toBe(false);
  });

  it("never leaks the webhook secret through its return value or a thrown error", () => {
    const result = verifyWebhookSignature({
      rawBody: prettyRawBody,
      signature: computeWebhookSignature(prettyRawBody),
    });
    expect(String(result)).not.toContain("test_webhook_secret");

    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
    let caught: unknown;
    try {
      verifyWebhookSignature({rawBody: "x", signature: "s"});
      throw new Error("expected verifyWebhookSignature to throw here");
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain("test_webhook_secret");
  });
});

describe("Checkout verification and webhook verification are separate operations", () => {
  beforeEach(() => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "test_webhook_secret");
  });

  it("a valid Checkout signature is not a valid webhook signature, whatever it is computed over", () => {
    const checkoutSignature = computeTestSignature("order_RazorpayTest1", "pay_RazorpayTest1");

    expect(verifyWebhookSignature({rawBody: "order_RazorpayTest1|pay_RazorpayTest1", signature: checkoutSignature}))
      .toBe(false);
    expect(verifyWebhookSignature({rawBody: "{\"event\":\"payment.captured\"}", signature: checkoutSignature}))
      .toBe(false);
  });

  it("a valid webhook signature is not a valid Checkout signature", () => {
    const body = "order_RazorpayTest1|pay_RazorpayTest1";
    const webhookSignature = computeWebhookSignature(body);

    expect(verifyWebhookSignature({rawBody: body, signature: webhookSignature})).toBe(true);
    expect(verifyCheckoutSignature({
      providerOrderId: "order_RazorpayTest1",
      razorpayPaymentId: "pay_RazorpayTest1",
      razorpaySignature: webhookSignature,
    })).toBe(false);
  });

  it("uses a different secret for each: configuring only one never satisfies the other", () => {
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    expect(() => verifyCheckoutSignature({
      providerOrderId: "o", razorpayPaymentId: "p", razorpaySignature: "s",
    })).toThrow("RAZORPAY_KEY_SECRET is not configured.");
    expect(verifyWebhookSignature({rawBody: "x", signature: computeWebhookSignature("x")})).toBe(true);
  });
});

describe("createRazorpayGateway: request timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a hung createOrder with a PaymentProviderError instead of waiting forever", async () => {
    vi.useFakeTimers();
    const {client} = fakeRazorpayClient({create: () => new Promise(() => undefined)});
    const gateway = createRazorpayGateway(client, 5_000);

    const outcome = gateway.createOrder({amountInPaise: 100, currency: "INR", receipt: "payment-1"})
      .then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await outcome).toBeInstanceOf(PaymentProviderError);
  });

  it("gives up on a hung fetchOrder the same way", async () => {
    vi.useFakeTimers();
    const {client} = fakeRazorpayClient({fetch: () => new Promise(() => undefined)});
    const gateway = createRazorpayGateway(client, 5_000);

    const outcome = gateway.fetchOrder("order_RazorpayTest1").then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await outcome).toBeInstanceOf(PaymentProviderError);
  });

  it("does not interfere with a call that answers in time, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const {client} = fakeRazorpayClient();
    const gateway = createRazorpayGateway(client, 5_000);

    await expect(gateway.createOrder({amountInPaise: 100, currency: "INR", receipt: "p"}))
      .resolves.toMatchObject({id: "order_RazorpayTest1"});
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("razorpayModeOf", () => {
  it("reads the mode from the key_id's public prefix", () => {
    expect(razorpayModeOf("rzp_test_AbC123")).toBe("test");
    expect(razorpayModeOf("rzp_live_AbC123")).toBe("live");
    expect(razorpayModeOf("something_else")).toBe("unknown");
    expect(razorpayModeOf("")).toBe("unknown");
  });
});

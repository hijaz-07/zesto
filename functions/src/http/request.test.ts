// @vitest-environment node
import {createHmac} from "node:crypto";
import {createServer, request as httpRequest, type IncomingMessage, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {createWebhookRoutes} from "../routes/webhooks";
import {handleRequest} from "./handleRequest";
import {toNormalizedRequest} from "./request";

const WEBHOOK_SECRET = "test_webhook_secret_for_raw_body";

beforeEach(() => {
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function sign(rawBody: Buffer | string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
}

describe("toNormalizedRequest", () => {
  it("passes the runtime's raw body through untouched — the very same Buffer, not a copy", () => {
    const rawBody = Buffer.from("{ \"a\" :  1 }\n", "utf8");

    const normalized = toNormalizedRequest({
      method: "POST",
      path: "/api/webhooks/razorpay",
      headers: {"x-razorpay-signature": "sig"},
      query: {},
      body: {a: 1},
      rawBody,
    });

    expect(normalized.rawBody).toBe(rawBody);
  });

  it("keeps the parsed body separate from the raw body", () => {
    const rawBody = Buffer.from("{\"a\":1}");

    const normalized = toNormalizedRequest({
      method: "POST", path: "/x", headers: {}, query: {}, body: {a: 1}, rawBody,
    });

    expect(normalized.body).toEqual({a: 1});
    expect(normalized.rawBody).toBe(rawBody);
  });

  it("strips the /api prefix from the path (Hosting rewrite) and leaves a direct emulator path alone", () => {
    const base = {method: "POST", headers: {}, query: {}, body: undefined};

    expect(toNormalizedRequest({...base, path: "/api/webhooks/razorpay"}).path).toBe("/webhooks/razorpay");
    expect(toNormalizedRequest({...base, path: "/webhooks/razorpay"}).path).toBe("/webhooks/razorpay");
  });

  it("leaves rawBody undefined when the runtime didn't provide one (e.g. a GET)", () => {
    const normalized = toNormalizedRequest({
      method: "GET", path: "/me", headers: {}, query: {}, body: undefined,
    });

    expect(normalized.rawBody).toBeUndefined();
  });
});

/**
 * A real HTTP server that captures the raw request bytes the way the
 * Functions runtime does (body-parser's `verify` hook: keep the original
 * Buffer, THEN parse) and hands the request to the real router and webhook
 * route. This proves, over an actual socket, that the bytes the HMAC is
 * computed over are exactly the bytes that arrived — not a re-serialization
 * of the parsed body. `db` is never touched: only an unsupported event type
 * (which a signed delivery may carry without any Firestore access) is sent.
 */
describe("raw body over a real HTTP request", () => {
  let server: Server;
  let port: number;

  const routes = createWebhookRoutes({
    db: new Proxy({}, {
      get() {
        throw new Error("Firestore must not be touched by these requests.");
      },
    }) as never,
  });

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const rawBody = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        body = undefined;
      }
      const result = await handleRequest(
        routes,
        toNormalizedRequest({
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: req.headers,
          query: {},
          body,
          rawBody,
        }),
        () => {},
      );
      res.statusCode = result.status;
      res.end(JSON.stringify(result.kind === "success" ? result.data : {error: result.code}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(path: string, body: Buffer | string, headers: Record<string, string>): Promise<{status: number; body: string}> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
      const req = httpRequest(
        {
          host: "127.0.0.1", port, path, method: "POST",
          headers: {"content-type": "application/json", "content-length": payload.length, ...headers},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8")}));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  // Pretty-printed, unusual key order, escaped non-ASCII, `100.0`, trailing
  // newline: everything JSON.stringify(JSON.parse(x)) would normalize away.
  const sentBody =
    "{\n  \"event\" : \"refund.processed\",\n  \"created_at\":1567674606,\n" +
    "  \"payload\":{\"x\":{\"amount\":100.0,\"memo\":\"caf\\u00e9 \\ud83d\\ude00\"}}\n}\n";

  it("accepts a delivery whose signature was computed over the exact bytes sent", async () => {
    const response = await post("/api/webhooks/razorpay", sentBody, {"x-razorpay-signature": sign(sentBody)});

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({received: true, outcome: "ignored_unknown_event"});
  });

  it("proves the premise: re-serializing what was sent changes the bytes (so HMAC over a re-serialization would fail)", () => {
    const reserialized = JSON.stringify(JSON.parse(sentBody));

    expect(JSON.parse(reserialized)).toEqual(JSON.parse(sentBody));
    expect(reserialized).not.toBe(sentBody);
    expect(sign(reserialized)).not.toBe(sign(sentBody));
  });

  it("rejects a delivery signed over the re-serialized form — the server compares against what ARRIVED", async () => {
    const reserialized = JSON.stringify(JSON.parse(sentBody));

    // Sent as the original bytes, but signed over the normalized form.
    const response = await post("/api/webhooks/razorpay", sentBody, {"x-razorpay-signature": sign(reserialized)});

    expect(response.status).toBe(401);
  });

  it("rejects when even one byte of the arrived body differs from what was signed", async () => {
    const signature = sign(sentBody);

    const response = await post("/api/webhooks/razorpay", sentBody.replace("100.0", "100.1"), {
      "x-razorpay-signature": signature,
    });

    expect(response.status).toBe(401);
  });

  it("verifies non-UTF-8 request bytes exactly as received (invalid bytes aren't silently replaced)", async () => {
    const odd = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);

    const response = await post("/webhooks/razorpay", odd, {"x-razorpay-signature": sign(odd)});

    // Authenticated (not 401), but not JSON, so malformed.
    expect(response.status).toBe(400);
  });
});

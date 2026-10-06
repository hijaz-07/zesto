import type {FetchLike} from "./razorpayRefunds";

/**
 * A deterministic, in-memory stand-in for Razorpay's HTTPS API — a `fetch` double
 * for `createRazorpayRefundGateway`. It never opens a socket. Shipped nowhere
 * (excluded from the build by the `*.fake.ts` rule in `tsconfig.json`).
 *
 * It models only the documented behaviour the refund client depends on: Basic
 * auth; refund creation with `X-Refund-Idempotency` (same key + same body replays,
 * a different body is a 409), per-payment unique receipts (a repeat is a 400
 * "Duplicate receipt found"), the captured-amount ceiling; the refund / payment /
 * list endpoints with `count`/`skip`; and snake_case responses carrying extra raw
 * fields the client must NOT leak. Notes that were never set come back as `[]`,
 * as the real API does.
 *
 * Faults are scripted per request, once each, in order:
 * - `{respond}`: answer with that HTTP status/body, applying nothing;
 * - `{drop}`: the connection dies before the request is applied (`fetch` rejects);
 * - `{applyThenDrop}`: the request IS applied, then the connection dies — the
 *   response-lost case;
 * - `{applyThenRespond}`: applied, but the client sees this status/body instead;
 * - `{hang}`: never answers until the request is aborted (a timeout).
 */

export type HttpBehaviour =
  | {respond: {status: number; body: unknown}}
  | {drop: true}
  | {applyThenDrop: true}
  | {applyThenRespond: {status: number; body: unknown}}
  | {hang: true};

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FakeRazorpayHttp {
  fetchFn: FetchLike;
  /** Every request received (including those scripted to fail), in order. */
  readonly requests: readonly RecordedRequest[];
  addPayment(payment: {
    id: string; orderId?: string | null; amount: number; currency?: string;
    status?: string; captured?: boolean;
  }): void;
  script(...behaviours: HttpBehaviour[]): void;
  /** Raw refunds the fake holds for a payment. */
  rawRefunds(paymentId: string): Record<string, unknown>[];
}

interface StoredPayment {
  id: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
}

/**
 * @param {string} keyId The key_id the fake accepts.
 * @param {string} keySecret The key_secret the fake accepts.
 * @return {FakeRazorpayHttp} A fresh fake with no payments and no faults.
 */
export function createFakeRazorpayHttp(keyId: string, keySecret: string): FakeRazorpayHttp {
  const payments = new Map<string, StoredPayment>();
  const refunds = new Map<string, Record<string, unknown>>();
  const byKey = new Map<string, {body: string; refundId: string}>();
  const requests: RecordedRequest[] = [];
  const behaviours: HttpBehaviour[] = [];
  let sequence = 0;
  const expectedAuth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;

  /**
   * @param {number} status The HTTP status.
   * @param {unknown} body The body (JSON-serialized unless already a string).
   * @return {{status: number, text: () => Promise<string>}} A response.
   */
  function respond(status: number, body: unknown) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {status, text: async () => text};
  }

  /**
   * @param {number} status The HTTP status.
   * @param {string} code Razorpay's error code.
   * @param {string} description Its description.
   * @return {{status: number, text: () => Promise<string>}} An error response.
   */
  function error(status: number, code: string, description: string) {
    return respond(status, {error: {code, description, source: "NA", step: "NA", reason: "NA", metadata: {}}});
  }

  /**
   * @param {string} paymentId A payment ID.
   * @return {number} The paise the payment can still have refunded.
   */
  function remaining(paymentId: string): number {
    const payment = payments.get(paymentId);
    let taken = 0;
    for (const refund of refunds.values()) {
      if (refund.payment_id === paymentId && refund.status !== "failed") {
        taken += refund.amount as number;
      }
    }
    return (payment?.amount ?? 0) - taken;
  }

  /**
   * @param {StoredPayment} payment A stored payment.
   * @return {Record<string, unknown>} The raw payment object, with extra fields.
   */
  function rawPayment(payment: StoredPayment): Record<string, unknown> {
    const refunded = payment.amount - remaining(payment.id);
    return {
      id: payment.id,
      entity: "payment",
      amount: payment.amount,
      currency: payment.currency,
      status: refunded === payment.amount && payment.captured ? "refunded" : payment.status,
      order_id: payment.orderId,
      captured: payment.captured,
      amount_refunded: refunded,
      refund_status: refunded === 0 ? null : refunded === payment.amount ? "full" : "partial",
      method: "netbanking",
      email: "customer@example.invalid",
      contact: "+910000000000",
      notes: [],
    };
  }

  /**
   * Applies a request to the fake's state and returns the response it would give.
   *
   * @param {RecordedRequest} request The request.
   * @return {{status: number, text: () => Promise<string>}} The response.
   */
  function handle(request: RecordedRequest) {
    if (request.headers["Authorization"] !== expectedAuth) {
      return error(401, "BAD_REQUEST_ERROR", "Authentication failed");
    }
    const segments = request.path.split("/").filter(Boolean);

    if (request.method === "POST" && segments.length === 3 && segments[0] === "payments" && segments[2] === "refund") {
      const payment = payments.get(segments[1]);
      if (!payment) {
        return error(400, "BAD_REQUEST_ERROR", "The id provided does not exist");
      }
      const key = request.headers["X-Refund-Idempotency"];
      if (key !== undefined && !/^[A-Za-z0-9_-]{10,}$/.test(key)) {
        return error(400, "BAD_REQUEST_ERROR", "Idempotency key is invalid");
      }
      if (key !== undefined) {
        const prior = byKey.get(key);
        if (prior) {
          if (prior.body !== request.body) {
            return error(409, "BAD_REQUEST_ERROR", "Different request with the same idempotency key has already been processed.");
          }
          return respond(200, refunds.get(prior.refundId));
        }
      }
      const body = JSON.parse(request.body ?? "{}") as {
        amount: number; speed: string; receipt: string; notes: Record<string, string>;
      };
      for (const existing of refunds.values()) {
        if (existing.payment_id === payment.id && existing.receipt === body.receipt) {
          return error(400, "BAD_REQUEST_ERROR", "Duplicate receipt found");
        }
      }
      if (!payment.captured) {
        return error(400, "BAD_REQUEST_ERROR", "The payment has not been captured yet");
      }
      if (body.amount > remaining(payment.id)) {
        return error(400, "BAD_REQUEST_ERROR", "The refund amount provided is greater than amount captured");
      }
      sequence += 1;
      const refund = {
        id: `rfnd_Fake${sequence}`,
        entity: "refund",
        amount: body.amount,
        currency: payment.currency,
        payment_id: payment.id,
        notes: body.notes && Object.keys(body.notes).length > 0 ? body.notes : [],
        receipt: body.receipt,
        acquirer_data: {arn: null},
        created_at: 1_700_000_000 + sequence,
        batch_id: null,
        status: "pending",
        speed_processed: "normal",
        speed_requested: body.speed,
      };
      refunds.set(refund.id, refund);
      if (key !== undefined) {
        byKey.set(key, {body: request.body ?? "", refundId: refund.id});
      }
      return respond(200, refund);
    }

    if (request.method === "GET" && segments.length === 2 && segments[0] === "refunds") {
      const refund = refunds.get(segments[1]);
      return refund ? respond(200, refund) : error(400, "BAD_REQUEST_ERROR", "The id provided does not exist");
    }

    if (request.method === "GET" && segments.length === 3 && segments[0] === "payments" && segments[2] === "refunds") {
      const count = Number(request.query.count ?? "10");
      const skip = Number(request.query.skip ?? "0");
      const all = [...refunds.values()].filter((refund) => refund.payment_id === segments[1]);
      const items = all.slice(skip, skip + count);
      return respond(200, {entity: "collection", count: items.length, items});
    }

    if (request.method === "GET" && segments.length === 2 && segments[0] === "payments") {
      const payment = payments.get(segments[1]);
      return payment ? respond(200, rawPayment(payment)) : error(400, "BAD_REQUEST_ERROR", "The id provided does not exist");
    }

    return error(404, "BAD_REQUEST_ERROR", "The requested URL was not found on the server.");
  }

  const fetchFn: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const request: RecordedRequest = {
      method: init.method,
      url,
      path: parsed.pathname.replace(/^\/v1/, ""),
      query: Object.fromEntries(parsed.searchParams.entries()),
      headers: {...init.headers},
      body: init.body,
    };
    requests.push(request);
    const behaviour = behaviours.shift();

    if (behaviour && "drop" in behaviour) {
      throw new TypeError("fetch failed");
    }
    if (behaviour && "hang" in behaviour) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    }
    if (behaviour && "respond" in behaviour) {
      return respond(behaviour.respond.status, behaviour.respond.body);
    }
    const response = handle(request);
    if (behaviour && "applyThenDrop" in behaviour) {
      throw new TypeError("fetch failed");
    }
    if (behaviour && "applyThenRespond" in behaviour) {
      return respond(behaviour.applyThenRespond.status, behaviour.applyThenRespond.body);
    }
    return response;
  };

  return {
    fetchFn,
    get requests() {
      return requests;
    },
    addPayment(payment) {
      payments.set(payment.id, {
        id: payment.id,
        orderId: payment.orderId ?? null,
        amount: payment.amount,
        currency: payment.currency ?? "INR",
        status: payment.status ?? "captured",
        captured: payment.captured ?? (payment.status ?? "captured") === "captured",
      });
    },
    script(...queued) {
      behaviours.push(...queued);
    },
    rawRefunds(paymentId) {
      return [...refunds.values()].filter((refund) => refund.payment_id === paymentId);
    },
  };
}

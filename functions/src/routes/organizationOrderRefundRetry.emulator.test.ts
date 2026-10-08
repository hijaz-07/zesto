// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {AMOUNT, cleanupScenarios, loadState, seedScenario, type Scenario} from "../domain/refundScenario.fake";
import {handleRequest} from "../http/handleRequest";
import type {ApiResult} from "../http/types";
import {createOrganizationOrderRoutes} from "./organizationOrders";

/**
 * `POST /organizations/:org/orders/:id/retry-refund` against a REAL Firestore
 * emulator: who may ask, which orders it can reach, what it creates (one new refund
 * with the next deterministic ID, for the whole remaining amount and nothing the
 * caller sends) and what it refuses (a repeat, a race, a refund that has not failed).
 * The `onRefundCreated` trigger is not part of this suite, so a created refund stays
 * `requested` here.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

const PROJECT_ID = "demo-zesto-refund-retry-route";
let db: Firestore;

vi.setConfig({testTimeout: 20000});

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

const memberRefs: ReturnType<Firestore["doc"]>[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupScenarios(db);
  for (const ref of memberRefs.splice(0)) {
    await ref.delete();
  }
});

const freshUserId = (): string => `U-${randomUUID()}`;

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({jwt: "irrelevant", token: {sub: userId, aud: ["P-test"]}})),
  };
}

async function addMember(organizationId: string, role: string): Promise<string> {
  const userId = freshUserId();
  const ref = db.collection("organizations").doc(organizationId).collection("members").doc(userId);
  memberRefs.push(ref);
  await ref.set({userId, organizationId, role, status: "active", createdAt: new Date()});
  return userId;
}

interface Fixture {
  scenario: Scenario;
  ownerId: string;
  managerId: string;
  staffId: string;
}

/** A cancelled, paid order of a fresh organization whose only refund has FAILED. */
async function seedFailed(refundOverrides: Record<string, unknown> = {}): Promise<Fixture> {
  const organizationId = `org-${randomUUID().slice(0, 12)}`;
  const scenario = await seedScenario(db, {organizationId, refundStatus: "failed", refund: refundOverrides});
  return {
    scenario,
    ownerId: await addMember(organizationId, "owner"),
    managerId: await addMember(organizationId, "manager"),
    staffId: await addMember(organizationId, "staff"),
  };
}

function retry(userId: string, organizationId: string, orderId: string, body?: unknown, authorized = true): Promise<ApiResult> {
  return handleRequest(
    createOrganizationOrderRoutes({db, validator: acceptingValidator(userId)}),
    {
      method: "POST",
      path: `/organizations/${organizationId}/orders/${orderId}/retry-refund`,
      headers: authorized ? {authorization: "Bearer token"} : {},
      query: {},
      body,
    },
    () => {},
  );
}

const dataOf = (result: ApiResult): {order: Record<string, unknown>; refund?: Record<string, unknown>} => {
  if (result.kind !== "success") {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.data as {order: Record<string, unknown>; refund?: Record<string, unknown>};
};

const failedWith = (result: ApiResult, status: number, code: string): void => {
  expect(result).toMatchObject({kind: "error", status, code});
};

describe("organization refund retry route (Firestore emulator)", () => {
  it("an owner retries a failed refund: a NEW refund for the whole remaining amount; the failed one is untouched", async () => {
    const f = await seedFailed();
    const {scenario: s} = f;

    const result = await retry(f.ownerId, s.organizationId, s.orderId);

    const data = dataOf(result);
    expect(data.refund).toMatchObject({status: "requested", amountInPaise: AMOUNT, currency: "INR"});
    expect(data.order).toMatchObject({id: s.orderId, status: "cancelled", refund: {state: "in_progress", refundedInPaise: 0}});

    const state = await loadState(s);
    expect(Object.keys(state.refunds).sort()).toEqual([`${s.orderId}-r1`, `${s.orderId}-r2`]);
    expect(state.refunds[`${s.orderId}-r1`]).toMatchObject({status: "failed", failureCode: "seed_failed"});
    expect(state.refunds[`${s.orderId}-r2`]).toMatchObject({
      status: "requested",
      amountInPaise: AMOUNT,
      source: "retry",
      initiatedBy: f.ownerId,
      initiatedByRole: "organization",
      idempotencyKey: `${s.orderId}-r2`,
    });
    // The accounting never exceeds what was captured.
    expect(state.payment).toMatchObject({
      capturedAmountInPaise: AMOUNT, refundedAmountInPaise: 0, refundPendingInPaise: AMOUNT, refundSeq: 2,
    });
    expect(state.order).toMatchObject({refundStatus: "in_progress", refundedInPaise: 0});
  });

  it("a manager may retry too", async () => {
    const f = await seedFailed();

    const result = await retry(f.managerId, f.scenario.organizationId, f.scenario.orderId);

    expect(dataOf(result).refund).toMatchObject({status: "requested"});
  });

  it("staff are refused with 403 and nothing is created", async () => {
    const f = await seedFailed();

    const result = await retry(f.staffId, f.scenario.organizationId, f.scenario.orderId);

    failedWith(result, 403, "permission_denied");
    expect(Object.keys((await loadState(f.scenario)).refunds)).toEqual([`${f.scenario.orderId}-r1`]);
  });

  it("an unauthenticated request is 401", async () => {
    const f = await seedFailed();

    failedWith(await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId, undefined, false), 401, "unauthenticated");
  });

  it("another organization's owner gets a plain 404 and nothing is created", async () => {
    const f = await seedFailed();
    const other = await seedFailed();

    const result = await retry(other.ownerId, other.scenario.organizationId, f.scenario.orderId);

    failedWith(result, 404, "not_found");
    expect(Object.keys((await loadState(f.scenario)).refunds)).toEqual([`${f.scenario.orderId}-r1`]);
  });

  it("an owner cannot borrow another organization's ID in the path: 403, and nothing is created", async () => {
    const f = await seedFailed();
    const other = await seedFailed();

    // Owner of `other` addresses `f`'s organization (and its order) directly.
    const result = await retry(other.ownerId, f.scenario.organizationId, f.scenario.orderId);

    failedWith(result, 403, "permission_denied");
    expect(Object.keys((await loadState(f.scenario)).refunds)).toEqual([`${f.scenario.orderId}-r1`]);
  });

  it.each(["a%2Fb", "..", "__reserved__", "%2e%2e"])("a malformed order ID (%s) is refused before any lookup", async (badId) => {
    const f = await seedFailed();

    const result = await retry(f.ownerId, f.scenario.organizationId, badId);

    expect(result.kind).toBe("error");
    expect([400, 404]).toContain((result as {status: number}).status);
    expect(Object.keys((await loadState(f.scenario)).refunds)).toEqual([`${f.scenario.orderId}-r1`]);
  });

  it("an unknown order is a 404", async () => {
    const f = await seedFailed();

    failedWith(await retry(f.ownerId, f.scenario.organizationId, "no-such-order"), 404, "not_found");
  });

  it("nothing the caller sends is read: the amount is the whole remaining refundable amount", async () => {
    const f = await seedFailed();

    const result = await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId, {
      amountInPaise: 1, refundId: "evil-r9", providerRefundId: "rfnd_x", status: "processed",
    });

    expect(dataOf(result).refund).toMatchObject({amountInPaise: AMOUNT, status: "requested"});
    const state = await loadState(f.scenario);
    expect(Object.keys(state.refunds).sort()).toEqual([`${f.scenario.orderId}-r1`, `${f.scenario.orderId}-r2`]);
    expect(state.refunds[`${f.scenario.orderId}-r2`]).not.toHaveProperty("providerRefundId");
  });

  it("the response carries no provider, payment, idempotency or actor identifier", async () => {
    const f = await seedFailed();

    const body = JSON.stringify(dataOf(await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId)));

    for (const leaked of [
      f.scenario.providerPaymentId, f.scenario.providerOrderId, "providerPaymentId", "providerRefundId", "providerOrderId",
      "rfnd_", "idempotencyKey", "initiatedBy", "failureCode", "attentionRequired", f.ownerId,
    ]) {
      expect(body, leaked).not.toContain(leaked);
    }
  });

  it("a refund that has not failed (requested, pending, processed) is a 409 and creates nothing", async () => {
    for (const refundStatus of ["requested", "pending", "processed"] as const) {
      const organizationId = `org-${randomUUID().slice(0, 12)}`;
      const s = await seedScenario(db, {organizationId, refundStatus});
      const ownerId = await addMember(organizationId, "owner");

      failedWith(await retry(ownerId, organizationId, s.orderId), 409, "conflict");

      expect(Object.keys((await loadState(s)).refunds), refundStatus).toEqual([`${s.orderId}-r1`]);
    }
  });

  it("an order with no refund is a 409", async () => {
    const organizationId = `org-${randomUUID().slice(0, 12)}`;
    const s = await seedScenario(db, {organizationId, noRefund: true});
    const ownerId = await addMember(organizationId, "owner");

    failedWith(await retry(ownerId, organizationId, s.orderId), 409, "conflict");
  });

  it("an order that is not cancelled is a 409", async () => {
    const organizationId = `org-${randomUUID().slice(0, 12)}`;
    const s = await seedScenario(db, {organizationId, refundStatus: "failed", orderStatus: "confirmed"});
    const ownerId = await addMember(organizationId, "owner");

    failedWith(await retry(ownerId, organizationId, s.orderId), 409, "conflict");
    expect(Object.keys((await loadState(s)).refunds)).toEqual([`${s.orderId}-r1`]);
  });

  it("a refund made outside Zesto cannot be retried", async () => {
    const f = await seedFailed({reason: "external"});

    failedWith(await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId), 409, "conflict");
    expect(Object.keys((await loadState(f.scenario)).refunds)).toEqual([`${f.scenario.orderId}-r1`]);
  });

  it("a repeat after a successful retry is a 409 and creates no second refund", async () => {
    const f = await seedFailed();
    await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId);

    failedWith(await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId), 409, "conflict");

    expect(Object.keys((await loadState(f.scenario)).refunds)).toHaveLength(2);
  });

  it("two simultaneous retries create exactly one refund", async () => {
    const f = await seedFailed();

    const results = await Promise.all([
      retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId),
      retry(f.managerId, f.scenario.organizationId, f.scenario.orderId),
    ]);

    expect(results.filter((r) => r.kind === "success")).toHaveLength(1);
    const rejected = results.find((r) => r.kind === "error");
    expect(rejected).toMatchObject({kind: "error", status: 409, code: "conflict"});
    const state = await loadState(f.scenario);
    expect(Object.keys(state.refunds).sort()).toEqual([`${f.scenario.orderId}-r1`, `${f.scenario.orderId}-r2`]);
    expect(state.payment).toMatchObject({refundPendingInPaise: AMOUNT, refundedAmountInPaise: 0, refundSeq: 2});
  });

  it("a retry that fails again can be retried again, each with its own refund ID", async () => {
    const f = await seedFailed();
    await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId);
    // The second attempt is rejected by the provider too.
    await f.scenario.paymentRef.collection("refunds").doc(`${f.scenario.orderId}-r2`).update({
      status: "failed", failedAt: Timestamp.now(), failureCode: "seed_failed", failureMessage: "Seeded failure.", nextAttemptAt: FieldValue.delete(),
    });
    await f.scenario.paymentRef.update({refundPendingInPaise: 0, refundState: "none"});

    const third = await retry(f.ownerId, f.scenario.organizationId, f.scenario.orderId);

    expect(dataOf(third).refund).toMatchObject({status: "requested", amountInPaise: AMOUNT});
    expect(Object.keys((await loadState(f.scenario)).refunds).sort()).toEqual([
      `${f.scenario.orderId}-r1`, `${f.scenario.orderId}-r2`, `${f.scenario.orderId}-r3`,
    ]);
  });
});

// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {handleRequest} from "../http/handleRequest";
import type {NormalizedRequest} from "../http/types";
import {createOrganizationRoutes} from "./organizations";

/**
 * These tests exercise `createOrganization` / `listOrganizationsForUser`
 * against a REAL Firestore emulator, to prove the transaction's atomicity
 * and the collection-group query actually hold under Firestore's real
 * concurrency and indexing semantics — the same reason `me.emulator.test.ts`
 * exists for `getOrCreateUserProfile`. Descope stays faked.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

const PROJECT_ID = "demo-zesto-functions-test";

let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this file via " +
      "`npm run test:functions-emulator` (from the repo root), which " +
      "starts the Firestore emulator first.",
    );
  }
  const app = getApps().length > 0 ?
    getApps()[0] :
    initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "POST",
    path: "/organizations",
    headers: {authorization: "Bearer token"},
    query: {},
    body: undefined,
    ...overrides,
  };
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({
      jwt: "irrelevant",
      token: {sub: userId, aud: ["P-test"]},
    })),
  };
}

/** A fresh org name/slug pair per test/call, so tests never collide. */
function freshOrgInput() {
  const suffix = randomUUID();
  return {name: `Test Canteen ${suffix}`, slug: `test-canteen-${suffix}`};
}

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

async function callCreate(validator: SessionValidator, req = request()) {
  const routes = createOrganizationRoutes({db, validator});
  return handleRequest(routes, req, () => {});
}

async function callList(validator: SessionValidator) {
  const routes = createOrganizationRoutes({db, validator});
  return handleRequest(routes, request({method: "GET", path: "/organizations", body: undefined}), () => {});
}

describe("POST /organizations (Firestore emulator)", () => {
  it("creates the organization, slug reservation, and owner membership atomically", async () => {
    const userId = freshUserId();
    const input = freshOrgInput();

    const result = await callCreate(acceptingValidator(userId), request({body: input}));

    expect(result).toMatchObject({kind: "success", status: 201});
    if (result.kind !== "success") throw new Error("expected success");
    const {organization, membership} = result.data as {
      organization: {id: string};
      membership: {organizationId: string};
    };

    const orgSnapshot = await db.collection("organizations").doc(organization.id).get();
    expect(orgSnapshot.exists).toBe(true);
    expect(orgSnapshot.data()).toMatchObject({name: input.name, slug: input.slug, createdBy: userId});

    const slugSnapshot = await db.collection("organizationSlugs").doc(input.slug).get();
    expect(slugSnapshot.exists).toBe(true);
    expect(slugSnapshot.data()).toMatchObject({organizationId: organization.id});

    const memberSnapshot = await db
      .collection("organizations").doc(organization.id)
      .collection("members").doc(userId)
      .get();
    expect(memberSnapshot.exists).toBe(true);
    expect(memberSnapshot.data()).toMatchObject({
      userId,
      organizationId: organization.id,
      role: "owner",
      status: "active",
    });
    expect(membership.organizationId).toBe(organization.id);
  });

  it("lets exactly one of two concurrent requests for the SAME slug succeed", async () => {
    const input = freshOrgInput();
    const userA = freshUserId();
    const userB = freshUserId();

    const [resultA, resultB] = await Promise.all([
      callCreate(acceptingValidator(userA), request({body: input})),
      callCreate(acceptingValidator(userB), request({body: input})),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = resultA.status === 201 ? resultA : resultB;
    const loser = resultA.status === 201 ? resultB : resultA;
    expect(winner).toMatchObject({kind: "success"});
    expect(loser).toMatchObject({kind: "error", status: 409, code: "already_exists"});

    const orgsWithSlug = await db.collection("organizations").where("slug", "==", input.slug).get();
    expect(orgsWithSlug.size).toBe(1);
  });

  it("lets two concurrent requests for DIFFERENT slugs both succeed", async () => {
    const inputA = freshOrgInput();
    const inputB = freshOrgInput();

    const [resultA, resultB] = await Promise.all([
      callCreate(acceptingValidator(freshUserId()), request({body: inputA})),
      callCreate(acceptingValidator(freshUserId()), request({body: inputB})),
    ]);

    expect(resultA.status).toBe(201);
    expect(resultB.status).toBe(201);
  });

  it("returns 409, not 500, when the slug was already reserved before the request started", async () => {
    const input = freshOrgInput();
    await callCreate(acceptingValidator(freshUserId()), request({body: input}));

    const result = await callCreate(acceptingValidator(freshUserId()), request({body: input}));

    expect(result).toMatchObject({kind: "error", status: 409, code: "already_exists"});
  });

  it("rejects an invalid body without touching Firestore", async () => {
    const result = await callCreate(
      acceptingValidator(freshUserId()),
      request({body: {name: "", slug: "ab"}}),
    );

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });
});

describe("GET /organizations (Firestore emulator)", () => {
  it("returns only organizations where the caller has an ACTIVE membership, ordered by membership.createdAt", async () => {
    const userId = freshUserId();
    const first = await callCreate(acceptingValidator(userId), request({body: freshOrgInput()}));
    const second = await callCreate(acceptingValidator(userId), request({body: freshOrgInput()}));
    if (first.kind !== "success" || second.kind !== "success") throw new Error("setup failed");
    const firstOrgId = (first.data as {organization: {id: string}}).organization.id;
    const secondOrgId = (second.data as {organization: {id: string}}).organization.id;

    const result = await callList(acceptingValidator(userId));

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {organizations} = result.data as {organizations: Array<{id: string; role: string}>};
    const ids = organizations.map((o) => o.id);
    expect(ids.indexOf(firstOrgId)).toBeLessThan(ids.indexOf(secondOrgId));
    expect(organizations.find((o) => o.id === firstOrgId)).toMatchObject({role: "owner"});
  });

  it.each(["invited", "revoked"])("excludes a %s (non-active) membership", async (status) => {
    const userId = freshUserId();
    const orgRef = db.collection("organizations").doc();
    await orgRef.set({
      id: orgRef.id,
      name: "Non-active Org",
      slug: `non-active-${randomUUID()}`,
      createdAt: new Date(),
      createdBy: "someone-else",
    });
    await orgRef.collection("members").doc(userId).set({
      userId,
      organizationId: orgRef.id,
      role: "staff",
      status,
      createdAt: new Date(),
    });

    const result = await callList(acceptingValidator(userId));

    expect(result).toMatchObject({kind: "success"});
    if (result.kind !== "success") throw new Error("expected success");
    const {organizations} = result.data as {organizations: Array<{id: string}>};
    expect(organizations.some((o) => o.id === orgRef.id)).toBe(false);
  });

  it("excludes another user's organization entirely", async () => {
    const otherUsersOrg = await callCreate(acceptingValidator(freshUserId()), request({body: freshOrgInput()}));
    if (otherUsersOrg.kind !== "success") throw new Error("setup failed");
    const otherOrgId = (otherUsersOrg.data as {organization: {id: string}}).organization.id;

    const result = await callList(acceptingValidator(freshUserId()));

    expect(result).toMatchObject({kind: "success"});
    if (result.kind !== "success") throw new Error("expected success");
    const {organizations} = result.data as {organizations: Array<{id: string}>};
    expect(organizations.some((o) => o.id === otherOrgId)).toBe(false);
  });

  it("returns an empty array for a caller with no organizations", async () => {
    const result = await callList(acceptingValidator(freshUserId()));

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind === "success") {
      expect(result.data).toEqual({organizations: []});
    }
  });

  it("returns a generic 500 when an active membership points at a malformed organization document", async () => {
    const userId = freshUserId();
    const orgRef = db.collection("organizations").doc();
    // Written directly, bypassing createOrganization, to simulate corruption.
    await orgRef.set({id: orgRef.id, name: "Malformed"});
    await orgRef.collection("members").doc(userId).set({
      userId,
      organizationId: orgRef.id,
      role: "owner",
      status: "active",
      createdAt: new Date(),
    });

    const result = await callList(acceptingValidator(userId));

    expect(result).toEqual({
      kind: "error",
      status: 500,
      code: "internal",
      message: "An unexpected error occurred.",
    });
  });
});

describe("createOrganizationRoutes error mapping sanity (emulator)", () => {
  it("never leaks Firestore/HttpsError detail through a 500", async () => {
    // Sanity check that an unexpected HttpsError code (not 401/409/503) still
    // reaches the generic error path via the auth boundary, not this file's
    // own logic — regression guard for mapKnownError's default branch.
    const validator: SessionValidator = {
      validateSession: vi.fn(async () => {
        throw new HttpsError("internal", "boom");
      }),
    };

    const result = await callCreate(validator, request({body: freshOrgInput()}));

    expect(result).toMatchObject({kind: "error", status: 500, code: "internal"});
  });
});

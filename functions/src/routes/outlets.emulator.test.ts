// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {createOrganization} from "../domain/organizations";
import {handleRequest} from "../http/handleRequest";
import type {NormalizedRequest} from "../http/types";
import {createOutletRoutes} from "./outlets";

/**
 * These tests exercise the outlet routes against a REAL Firestore emulator,
 * the same reason `organizations.emulator.test.ts` exists: to prove the
 * create transaction's atomicity, the per-organization slug uniqueness
 * (and cross-organization slug reuse), the full owner/manager/staff/
 * non-member authorization matrix against real membership documents, and
 * tenant isolation, under Firestore's real concurrency semantics. Descope
 * stays faked.
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

function freshUserId(): string {
  return `U-${randomUUID()}`;
}

/** A fresh org name/slug pair per call, so tests never collide. */
function freshOrgInput() {
  const suffix = randomUUID();
  return {name: `Test Canteen ${suffix}`, slug: `test-canteen-${suffix}`};
}

/** A fresh outlet name/slug pair per call, so tests never collide. */
function freshOutletInput(overrides: Record<string, unknown> = {}) {
  const suffix = randomUUID();
  return {name: `Main Canteen ${suffix}`, slug: `main-canteen-${suffix}`, ...overrides};
}

/**
 * Creates a real organization (via the same `createOrganization` domain
 * function `POST /organizations` uses) with a fresh owner.
 *
 * @return {Promise<{organizationId: string, ownerId: string}>} The new
 *   organization's ID and its owner's user ID.
 */
async function setupOrgWithOwner(): Promise<{organizationId: string; ownerId: string}> {
  const ownerId = freshUserId();
  const {organization} = await createOrganization(db, ownerId, freshOrgInput());
  return {organizationId: organization.id, ownerId};
}

/**
 * Writes an additional membership document directly (bypassing any HTTP
 * endpoint, since organization invitations aren't implemented yet), so
 * manager/staff/non-active-member scenarios can be set up for these tests.
 *
 * @param {string} organizationId The organization to add a member to.
 * @param {string} userId The member's user ID.
 * @param {string} role The member's role.
 * @param {string} status The member's status (defaults to "active").
 * @return {Promise<void>} Resolves once the membership document is written.
 */
async function addMembership(
  organizationId: string,
  userId: string,
  role: string,
  status = "active",
): Promise<void> {
  await db
    .collection("organizations").doc(organizationId)
    .collection("members").doc(userId)
    .set({userId, organizationId, role, status, createdAt: new Date()});
}

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({
      jwt: "irrelevant",
      token: {sub: userId, aud: ["P-test"]},
    })),
  };
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "GET",
    path: "/",
    headers: {authorization: "Bearer token"},
    query: {},
    body: undefined,
    ...overrides,
  };
}

async function callCreate(organizationId: string, validator: SessionValidator, body: unknown) {
  const routes = createOutletRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "POST", path: `/organizations/${organizationId}/outlets`, body}),
    () => {},
  );
}

async function callList(organizationId: string, validator: SessionValidator) {
  const routes = createOutletRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "GET", path: `/organizations/${organizationId}/outlets`}),
    () => {},
  );
}

async function callPatch(
  organizationId: string,
  outletId: string,
  validator: SessionValidator,
  body: unknown,
) {
  const routes = createOutletRoutes({db, validator});
  return handleRequest(
    routes,
    request({method: "PATCH", path: `/organizations/${organizationId}/outlets/${outletId}`, body}),
    () => {},
  );
}

describe("POST /organizations/:organizationId/outlets (Firestore emulator)", () => {
  it("creates the outlet and slug reservation atomically", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const input = freshOutletInput();

    const result = await callCreate(organizationId, acceptingValidator(ownerId), input);

    expect(result).toMatchObject({kind: "success", status: 201});
    if (result.kind !== "success") throw new Error("expected success");
    const {outlet} = result.data as {outlet: {id: string}};

    const outletSnapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").doc(outlet.id)
      .get();
    expect(outletSnapshot.exists).toBe(true);
    expect(outletSnapshot.data()).toMatchObject({
      name: input.name, slug: input.slug, status: "active", createdBy: ownerId,
    });

    const slugSnapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outletSlugs").doc(input.slug)
      .get();
    expect(slugSnapshot.exists).toBe(true);
    expect(slugSnapshot.data()).toMatchObject({organizationId, outletId: outlet.id});
  });

  it("persists every optional field exactly as submitted, read back from Firestore", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const input = {
      ...freshOutletInput(),
      description: "Main campus food outlet",
      phone: "0499xxxxxxx",
      address: {line1: "Main Campus", city: "Kasaragod", state: "Kerala", postalCode: "671121"},
      location: {latitude: 12.5, longitude: 74.9},
    };

    const result = await callCreate(organizationId, acceptingValidator(ownerId), input);

    expect(result).toMatchObject({kind: "success", status: 201});
    if (result.kind !== "success") throw new Error("expected success");
    const {outlet} = result.data as {outlet: {id: string}};

    const snapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").doc(outlet.id)
      .get();
    expect(snapshot.data()).toMatchObject({
      description: input.description,
      phone: input.phone,
      address: input.address,
      location: input.location,
    });
  });

  it("a failed create (slug already taken) leaves the existing slug reservation and outlet count unchanged, with no orphaned outlet document", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const input = freshOutletInput();
    const validator = acceptingValidator(ownerId);

    const first = await callCreate(organizationId, validator, input);
    expect(first).toMatchObject({kind: "success", status: 201});
    if (first.kind !== "success") throw new Error("setup failed");
    const originalOutletId = (first.data as {outlet: {id: string}}).outlet.id;

    const second = await callCreate(organizationId, validator, input);
    expect(second).toMatchObject({kind: "error", status: 409, code: "already_exists"});

    const slugSnapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outletSlugs").doc(input.slug)
      .get();
    expect(slugSnapshot.data()).toMatchObject({organizationId, outletId: originalOutletId});

    const outletsSnapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").get();
    expect(outletsSnapshot.size).toBe(1);
    expect(outletsSnapshot.docs[0].id).toBe(originalOutletId);
  });

  it("lets exactly one of two concurrent requests for the SAME slug (same org) succeed", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const input = freshOutletInput();
    const validator = acceptingValidator(ownerId);

    const [resultA, resultB] = await Promise.all([
      callCreate(organizationId, validator, input),
      callCreate(organizationId, validator, input),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = resultA.status === 201 ? resultA : resultB;
    const loser = resultA.status === 201 ? resultB : resultA;
    expect(winner).toMatchObject({kind: "success"});
    expect(loser).toMatchObject({kind: "error", status: 409, code: "already_exists"});

    const outlets = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").where("slug", "==", input.slug).get();
    expect(outlets.size).toBe(1);
  });

  it("under concurrent requests for the same slug, exactly one outlet document exists afterward (no orphan from the losing attempt)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const input = freshOutletInput();
    const validator = acceptingValidator(ownerId);

    await Promise.all([
      callCreate(organizationId, validator, input),
      callCreate(organizationId, validator, input),
    ]);

    // Unfiltered by slug this time — an orphaned document under a different
    // ID would still show up here, unlike the slug-filtered query above.
    const outletsSnapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").get();
    expect(outletsSnapshot.size).toBe(1);

    const slugSnapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outletSlugs").doc(input.slug)
      .get();
    expect(slugSnapshot.exists).toBe(true);
    expect(slugSnapshot.data()?.outletId).toBe(outletsSnapshot.docs[0].id);
  }, 15000);

  it("lets two concurrent requests for DIFFERENT slugs (same org) both succeed", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const validator = acceptingValidator(ownerId);

    const [resultA, resultB] = await Promise.all([
      callCreate(organizationId, validator, freshOutletInput()),
      callCreate(organizationId, validator, freshOutletInput()),
    ]);

    expect(resultA.status).toBe(201);
    expect(resultB.status).toBe(201);
  });

  it("lets the same slug succeed again in a DIFFERENT organization", async () => {
    const orgA = await setupOrgWithOwner();
    const orgB = await setupOrgWithOwner();
    const input = freshOutletInput();

    const resultA = await callCreate(orgA.organizationId, acceptingValidator(orgA.ownerId), input);
    const resultB = await callCreate(orgB.organizationId, acceptingValidator(orgB.ownerId), input);

    expect(resultA.status).toBe(201);
    expect(resultB.status).toBe(201);
  });

  it("returns 409, not 500, when the slug was already reserved before the request started", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const input = freshOutletInput();
    await callCreate(organizationId, acceptingValidator(ownerId), input);

    const result = await callCreate(organizationId, acceptingValidator(ownerId), input);

    expect(result).toMatchObject({kind: "error", status: 409, code: "already_exists"});
  });

  it("rejects an invalid body without touching Firestore", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();

    const result = await callCreate(organizationId, acceptingValidator(ownerId), {name: "", slug: "ab"});

    expect(result).toMatchObject({kind: "error", status: 400, code: "invalid_argument"});
  });

  it("denies a non-member (403)", async () => {
    const {organizationId} = await setupOrgWithOwner();

    const result = await callCreate(organizationId, acceptingValidator(freshUserId()), freshOutletInput());

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it.each([
    ["owner", true], ["manager", true], ["staff", false],
  ])("%s can create: %s", async (role, canCreate) => {
    const {organizationId} = await setupOrgWithOwner();
    const memberId = freshUserId();
    await addMembership(organizationId, memberId, role);

    const result = await callCreate(organizationId, acceptingValidator(memberId), freshOutletInput());

    if (canCreate) {
      expect(result).toMatchObject({kind: "success", status: 201});
    } else {
      expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    }
  });

  it("denies a revoked former member (403)", async () => {
    const {organizationId} = await setupOrgWithOwner();
    const memberId = freshUserId();
    await addMembership(organizationId, memberId, "owner", "revoked");

    const result = await callCreate(organizationId, acceptingValidator(memberId), freshOutletInput());

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });
});

describe("GET /organizations/:organizationId/outlets (Firestore emulator)", () => {
  it("returns both active and inactive outlets, ordered by createdAt ascending", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const validator = acceptingValidator(ownerId);
    const first = await callCreate(organizationId, validator, freshOutletInput());
    const second = await callCreate(organizationId, validator, freshOutletInput());
    if (first.kind !== "success" || second.kind !== "success") throw new Error("setup failed");
    const firstId = (first.data as {outlet: {id: string}}).outlet.id;
    const secondId = (second.data as {outlet: {id: string}}).outlet.id;
    await callPatch(organizationId, secondId, validator, {status: "inactive"});

    const result = await callList(organizationId, validator);

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {outlets} = result.data as {outlets: Array<{id: string; status: string}>};
    const ids = outlets.map((o) => o.id);
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(secondId));
    expect(outlets.find((o) => o.id === secondId)).toMatchObject({status: "inactive"});
  });

  it("returns an empty array for an organization with no outlets", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();

    const result = await callList(organizationId, acceptingValidator(ownerId));

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind === "success") {
      expect(result.data).toEqual({outlets: []});
    }
  });

  it("denies a non-member (403)", async () => {
    const {organizationId} = await setupOrgWithOwner();

    const result = await callList(organizationId, acceptingValidator(freshUserId()));

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("allows staff to view the list", async () => {
    const {organizationId} = await setupOrgWithOwner();
    const staffId = freshUserId();
    await addMembership(organizationId, staffId, "staff");

    const result = await callList(organizationId, acceptingValidator(staffId));

    expect(result).toMatchObject({kind: "success", status: 200});
  });
});

describe("PATCH /organizations/:organizationId/outlets/:outletId (Firestore emulator)", () => {
  async function setupOutlet() {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const created = await callCreate(organizationId, acceptingValidator(ownerId), freshOutletInput());
    if (created.kind !== "success") throw new Error("setup failed");
    const outletId = (created.data as {outlet: {id: string}}).outlet.id;
    return {organizationId, ownerId, outletId};
  }

  it("owner can update allowed fields; updatedAt changes; immutable fields don't", async () => {
    const {organizationId, ownerId, outletId} = await setupOutlet();
    const before = await db
      .collection("organizations").doc(organizationId).collection("outlets").doc(outletId).get();
    const originalSlug = before.data()?.slug;
    const originalCreatedAt = before.data()?.createdAt;

    const result = await callPatch(organizationId, outletId, acceptingValidator(ownerId), {
      name: "Renamed Canteen",
      status: "inactive",
      slug: "attacker-slug",
      organizationId: "org-attacker",
      createdBy: "U-attacker",
    });

    expect(result).toMatchObject({kind: "success", status: 200});
    if (result.kind !== "success") throw new Error("expected success");
    const {outlet} = result.data as {
      outlet: {name: string; status: string; slug: string; organizationId: string; createdBy: string};
    };
    expect(outlet.name).toBe("Renamed Canteen");
    expect(outlet.status).toBe("inactive");
    expect(outlet.slug).toBe(originalSlug);
    expect(outlet.organizationId).toBe(organizationId);
    expect(outlet.createdBy).toBe(ownerId);

    const after = await db
      .collection("organizations").doc(organizationId).collection("outlets").doc(outletId).get();
    expect(after.data()?.updatedAt.toMillis()).toBeGreaterThan(originalCreatedAt.toMillis());
    expect(after.data()?.slug).toBe(originalSlug);
  });

  it("manager can update", async () => {
    const {organizationId, outletId} = await setupOutlet();
    const managerId = freshUserId();
    await addMembership(organizationId, managerId, "manager");

    const result = await callPatch(organizationId, outletId, acceptingValidator(managerId), {name: "New Name"});

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("staff cannot update (403)", async () => {
    const {organizationId, outletId} = await setupOutlet();
    const staffId = freshUserId();
    await addMembership(organizationId, staffId, "staff");

    const result = await callPatch(organizationId, outletId, acceptingValidator(staffId), {name: "New Name"});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("a non-member cannot update (403)", async () => {
    const {organizationId, outletId} = await setupOutlet();

    const result = await callPatch(organizationId, outletId, acceptingValidator(freshUserId()), {name: "New Name"});

    expect(result).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });

  it("returns 404, not 500, for a nonexistent outlet", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();

    const result = await callPatch(organizationId, "no-such-outlet", acceptingValidator(ownerId), {
      name: "New Name",
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("never creates a document at the target path when the outlet doesn't exist (no upsert)", async () => {
    const {organizationId, ownerId} = await setupOrgWithOwner();
    const missingOutletId = "does-not-exist-outlet";

    const result = await callPatch(organizationId, missingOutletId, acceptingValidator(ownerId), {
      name: "Should Never Be Persisted",
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});

    const snapshot = await db
      .collection("organizations").doc(organizationId)
      .collection("outlets").doc(missingOutletId)
      .get();
    expect(snapshot.exists).toBe(false);
  });

  it("an outlet from another organization cannot be updated (404, never leaking cross-tenant data)", async () => {
    const orgA = await setupOrgWithOwner();
    const orgBOutlet = await setupOutlet();

    const result = await callPatch(
      orgA.organizationId, orgBOutlet.outletId, acceptingValidator(orgA.ownerId), {name: "Hijacked"},
    );

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });
});

describe("Tenant isolation (Firestore emulator)", () => {
  it("a user from Organization A cannot create, list, or update in Organization B", async () => {
    const orgA = await setupOrgWithOwner();
    const orgB = await setupOrgWithOwner();
    const outletInB = await callCreate(
      orgB.organizationId, acceptingValidator(orgB.ownerId), freshOutletInput(),
    );
    if (outletInB.kind !== "success") throw new Error("setup failed");
    const outletId = (outletInB.data as {outlet: {id: string}}).outlet.id;

    const userAValidator = acceptingValidator(orgA.ownerId);
    const createResult = await callCreate(orgB.organizationId, userAValidator, freshOutletInput());
    const listResult = await callList(orgB.organizationId, userAValidator);
    const patchResult = await callPatch(orgB.organizationId, outletId, userAValidator, {name: "Hijacked"});

    expect(createResult).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    expect(listResult).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
    expect(patchResult).toMatchObject({kind: "error", status: 403, code: "permission_denied"});
  });
});

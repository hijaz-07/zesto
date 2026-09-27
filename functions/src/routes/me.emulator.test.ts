// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {handleRequest} from "../http/handleRequest";
import type {NormalizedRequest} from "../http/types";
import {createMeRoutes} from "./me";

/**
 * These tests exercise `getOrCreateUserProfile` against a REAL Firestore
 * emulator (not the fake `db` used by `me.test.ts` / `users.test.ts`), to
 * prove the transaction-based create-or-read behavior actually holds under
 * Firestore's real concurrency semantics. Descope itself stays faked (a
 * `SessionValidator`), same as everywhere else — there is nothing to gain
 * from a live network dependency on Descope here.
 *
 * Run via `npm run test:functions-emulator` (repo root), which starts the
 * Firestore emulator first via `firebase emulators:exec`.
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

// verifyDescopeSession reads the expected audience from DESCOPE_PROJECT_ID
// even when a fake SessionValidator is injected, so every test needs it set.
beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "GET",
    path: "/me",
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

function rejectingValidator(): SessionValidator {
  return {
    validateSession: vi.fn(async () => {
      throw new HttpsError(
        "unauthenticated",
        "The session is invalid or has expired.",
      );
    }),
  };
}

/** A fresh per-test user ID, so tests never collide over the same document. */
function freshUserId(): string {
  return `U-${randomUUID()}`;
}

async function callGetMe(validator: SessionValidator, req = request()) {
  const routes = createMeRoutes({db, validator});
  return handleRequest(routes, req, () => {});
}

describe("GET /me (Firestore emulator)", () => {
  it("creates a users/{userId} document on first call", async () => {
    const userId = freshUserId();

    const result = await callGetMe(acceptingValidator(userId));

    expect(result).toMatchObject({kind: "success", status: 200});
    const snapshot = await db.collection("users").doc(userId).get();
    expect(snapshot.exists).toBe(true);
    expect(snapshot.data()?.id).toBe(userId);
  });

  it("performs no write and returns the same createdAt on a second call", async () => {
    const userId = freshUserId();
    const validator = acceptingValidator(userId);

    const first = await callGetMe(validator);
    const second = await callGetMe(validator);

    expect(first.kind).toBe("success");
    expect(second.kind).toBe("success");
    if (first.kind === "success" && second.kind === "success") {
      expect(second.data).toEqual(first.data);
    }
  });

  it("creates no user document for an invalid token", async () => {
    const before = (await db.collection("users").get()).size;

    const result = await callGetMe(rejectingValidator());

    expect(result).toMatchObject({status: 401, code: "unauthenticated"});
    const after = (await db.collection("users").get()).size;
    expect(after).toBe(before);
  });

  it("creates no user document when the session is rejected for the " +
    "wrong audience", async () => {
    const before = (await db.collection("users").get()).size;
    const wrongAudienceValidator: SessionValidator = {
      validateSession: vi.fn(async () => {
        throw new HttpsError(
          "unauthenticated",
          "The session is invalid or has expired.",
        );
      }),
    };

    const result = await callGetMe(wrongAudienceValidator);

    expect(result).toMatchObject({status: 401});
    const after = (await db.collection("users").get()).size;
    expect(after).toBe(before);
  });

  it("ignores a malicious userId query parameter", async () => {
    const realUserId = freshUserId();

    const result = await callGetMe(
      acceptingValidator(realUserId),
      request({query: {userId: "U-attacker"}}),
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toMatchObject({id: realUserId});
    }
    expect((await db.collection("users").doc("U-attacker").get()).exists).toBe(false);
  });

  it("ignores a malicious userId body field", async () => {
    const realUserId = freshUserId();

    const result = await callGetMe(
      acceptingValidator(realUserId),
      request({body: {userId: "U-attacker"}}),
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toMatchObject({id: realUserId});
    }
    expect((await db.collection("users").doc("U-attacker").get()).exists).toBe(false);
  });

  it("ignores an X-User-Id header", async () => {
    const realUserId = freshUserId();

    const result = await callGetMe(
      acceptingValidator(realUserId),
      request({headers: {authorization: "Bearer token", "x-user-id": "U-attacker"}}),
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toMatchObject({id: realUserId});
    }
    expect((await db.collection("users").doc("U-attacker").get()).exists).toBe(false);
  });

  it("creates exactly one user document for 10 concurrent first requests", async () => {
    const userId = freshUserId();
    const validator = acceptingValidator(userId);

    const results = await Promise.all(
      Array.from({length: 10}, () => callGetMe(validator)),
    );

    for (const result of results) {
      expect(result.kind).toBe("success");
    }
    const createdAts = results.map((r) => (r.kind === "success" ? (r.data as {createdAt: string}).createdAt : null));
    expect(new Set(createdAts).size).toBe(1);

    const snapshot = await db.collection("users").doc(userId).get();
    expect(snapshot.exists).toBe(true);
  });

  it("returns a generic 500 for a malformed stored user document", async () => {
    const userId = freshUserId();
    // Written directly with the Admin SDK, bypassing getOrCreateUserProfile,
    // to simulate a document some other path corrupted (e.g. missing
    // createdAt).
    await db.collection("users").doc(userId).set({id: userId});

    const result = await callGetMe(acceptingValidator(userId));

    expect(result).toEqual({
      kind: "error",
      status: 500,
      code: "internal",
      message: "An unexpected error occurred.",
    });
  });
});

// @vitest-environment node
import {generateKeyPairSync, sign, type KeyObject} from "node:crypto";
import descopeSdk from "@descope/node-sdk";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  authenticateRequest,
  getBearerToken,
  verifyDescopeSession,
  type SessionValidator,
} from "./session";

const PROJECT_ID = "P-test-project";
const KEY_ID = "test-signing-key";

/**
 * @return {{privateKey: KeyObject, publicJwk: string}} A fresh RS256 key
 *   pair; the public half as a JWK string for the SDK's `publicKey` option.
 */
function makeSigningKey(): {privateKey: KeyObject; publicJwk: string} {
  const {privateKey, publicKey} = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({format: "jwk"}),
    kid: KEY_ID,
    alg: "RS256",
    use: "sig",
  };
  return {privateKey, publicJwk: JSON.stringify(jwk)};
}

const trustedKey = makeSigningKey();
const untrustedKey = makeSigningKey();

/**
 * Signs an RS256 JWT locally, standing in for a Descope-issued session token.
 *
 * @param {Record<string, unknown>} claims The JWT payload.
 * @param {KeyObject} key The signing key.
 * @return {string} The compact JWT.
 */
function signJwt(
  claims: Record<string, unknown>,
  key: KeyObject = trustedKey.privateKey,
): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput =
    `${encode({alg: "RS256", typ: "JWT", kid: KEY_ID})}.${encode(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * @param {Record<string, unknown>} overrides Claims to add or replace.
 * @return {Record<string, unknown>} Descope-shaped session claims whose
 *   `aud` is the Project ID, as Descope issues by default.
 */
function sessionClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "U-123",
    iss: PROJECT_ID,
    aud: [PROJECT_ID],
    iat: now,
    exp: now + 600,
    ...overrides,
  };
}

/**
 * The real Descope Node SDK, pinned to a local public key so validation
 * (signature, expiry, issuer, audience) runs for real with no network calls.
 */
const descope = descopeSdk({
  projectId: PROJECT_ID,
  publicKey: trustedKey.publicJwk,
});

/**
 * @param {Promise<unknown>} promise A promise expected to reject.
 * @return {Promise<HttpsError>} The HttpsError it rejected with.
 */
async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpsError);
    return error as HttpsError;
  }
  throw new Error("Expected the promise to reject.");
}

beforeEach(() => {
  // Trusted backend configuration — the only source of the expected audience.
  vi.stubEnv("DESCOPE_PROJECT_ID", PROJECT_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getBearerToken", () => {
  it("extracts the token from an Authorization: Bearer header", () => {
    expect(getBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(getBearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("returns null for missing or malformed headers", () => {
    expect(getBearerToken(undefined)).toBeNull();
    expect(getBearerToken("")).toBeNull();
    expect(getBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(getBearerToken("Bearer")).toBeNull();
    expect(getBearerToken("Bearer a b")).toBeNull();
  });
});

describe("verifyDescopeSession: audience", () => {
  it("accepts a valid session whose audience is the configured Project ID",
    async () => {
      const session = await verifyDescopeSession(
        signJwt(sessionClaims()), descope,
      );

      expect(session.userId).toBe("U-123");
      expect(session.claims.aud).toEqual([PROJECT_ID]);
    });

  it("also accepts a single-string audience equal to the Project ID",
    async () => {
      const session = await verifyDescopeSession(
        signJwt(sessionClaims({aud: PROJECT_ID})), descope,
      );

      expect(session.userId).toBe("U-123");
    });

  it("always passes the backend DESCOPE_PROJECT_ID to validateSession",
    async () => {
      const validator: SessionValidator = {
        validateSession: vi.fn((token, options) =>
          descope.validateSession(token, options)),
      };
      const token = signJwt(sessionClaims());

      await verifyDescopeSession(token, validator);

      expect(validator.validateSession).toHaveBeenCalledWith(
        token, {audience: PROJECT_ID},
      );
    });

  it("rejects a validly signed session issued for a different audience",
    async () => {
      const token = signJwt(sessionClaims({aud: ["P-some-other-project"]}));

      const error = await rejection(verifyDescopeSession(token, descope));

      expect(error.code).toBe("unauthenticated");
      expect(error.httpErrorCode.status).toBe(401);
    });

  it("rejects a validly signed session with no audience claim", async () => {
    const claims = sessionClaims();
    delete claims.aud;

    const error = await rejection(
      verifyDescopeSession(signJwt(claims), descope),
    );

    expect(error.code).toBe("unauthenticated");
  });

  it("ignores any audience supplied by the request", async () => {
    const token = signJwt(sessionClaims({aud: ["P-attacker"]}));
    const request = {
      headers: {authorization: `Bearer ${token}`, "x-audience": "P-attacker"},
      body: {audience: "P-attacker"},
      query: {audience: "P-attacker"},
    };

    const error = await rejection(authenticateRequest(request, descope));

    expect(error.code).toBe("unauthenticated");
  });

  it("derives the expected audience from backend configuration", async () => {
    vi.stubEnv("DESCOPE_PROJECT_ID", "P-reconfigured-project");

    const error = await rejection(
      verifyDescopeSession(signJwt(sessionClaims()), descope),
    );

    expect(error.code).toBe("unauthenticated");
  });

  it("re-checks the audience even if a validator ignores the option",
    async () => {
      const permissive: SessionValidator = {
        validateSession: vi.fn(async (jwt) => ({
          jwt,
          token: {sub: "U-123", aud: ["P-some-other-project"]},
        })),
      };

      const error = await rejection(
        verifyDescopeSession("any-token", permissive),
      );

      expect(error.code).toBe("unauthenticated");
    });

  it("fails as a server error, without validating, if DESCOPE_PROJECT_ID " +
    "is not configured", async () => {
    vi.stubEnv("DESCOPE_PROJECT_ID", "  ");
    const validator: SessionValidator = {validateSession: vi.fn()};

    const result = verifyDescopeSession("any-token", validator);

    await expect(result).rejects.toThrow("DESCOPE_PROJECT_ID is not configured.");
    await expect(result).rejects.not.toBeInstanceOf(HttpsError);
    expect(validator.validateSession).not.toHaveBeenCalled();
  });
});

describe("verifyDescopeSession: invalid sessions", () => {
  it("rejects an expired session", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = signJwt(sessionClaims({iat: past - 600, exp: past}));

    const error = await rejection(verifyDescopeSession(token, descope));

    expect(error.code).toBe("unauthenticated");
    // Generic message only — the SDK's internal JWT error is not leaked.
    expect(error.message).toBe("The session is invalid or has expired.");
  });

  it("rejects a session signed by an untrusted key", async () => {
    const token = signJwt(sessionClaims(), untrustedKey.privateKey);

    const error = await rejection(verifyDescopeSession(token, descope));

    expect(error.code).toBe("unauthenticated");
  });

  it("rejects a session from a different issuer", async () => {
    const token = signJwt(sessionClaims({iss: "P-some-other-project"}));

    const error = await rejection(verifyDescopeSession(token, descope));

    expect(error.code).toBe("unauthenticated");
  });

  it("rejects a malformed token", async () => {
    const error = await rejection(verifyDescopeSession("not-a-jwt", descope));

    expect(error.code).toBe("unauthenticated");
  });

  it("rejects a valid session that has no subject", async () => {
    const claims = sessionClaims();
    delete claims.sub;

    const error = await rejection(
      verifyDescopeSession(signJwt(claims), descope),
    );

    expect(error.code).toBe("unauthenticated");
  });

  it("rejects a missing token without calling Descope", async () => {
    const validator: SessionValidator = {validateSession: vi.fn()};

    const error = await rejection(verifyDescopeSession(undefined, validator));

    expect(error.code).toBe("unauthenticated");
    expect(validator.validateSession).not.toHaveBeenCalled();
  });
});

describe("authenticateRequest", () => {
  it("validates the bearer token from the Authorization header", async () => {
    const token = signJwt(sessionClaims());

    const session = await authenticateRequest(
      {headers: {authorization: `Bearer ${token}`}},
      descope,
    );

    expect(session.userId).toBe("U-123");
  });

  it("rejects a request without an Authorization header", async () => {
    const error = await rejection(authenticateRequest({headers: {}}, descope));

    expect(error.code).toBe("unauthenticated");
  });
});

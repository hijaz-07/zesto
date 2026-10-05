// @vitest-environment node
import {createHmac} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {afterEach, describe, expect, it, vi} from "vitest";
import {
  PICKUP_CREDENTIAL_MAX_LENGTH,
  PICKUP_SECRET_MIN_LENGTH,
  derivePickupCredentials,
  getPickupCredentialSecret,
  parsePickupCredential,
  pickupCodeFor,
  pickupCredentialMatches,
} from "./pickupCredential";

// Made up for these tests; the real one lives only in Secret Manager.
const SECRET = "test-pickup-secret-0123456789-abcdefghij";
const OTHER_SECRET = "another-pickup-secret-9876543210-zyxwvu";
const ORDER_ID = "kQ3vR8nT2xLpA7mZdW1e";
const OTHER_ORDER_ID = "Zp0aY6bX4cV2nM8lK1jH";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** HttpsError thrown by `fn` (failing the test if it threw anything else, or nothing). */
function httpsErrorOf(fn: () => unknown): HttpsError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an HttpsError, but nothing was thrown");
}

// ---------------------------------------------------------------------------
// An INDEPENDENT implementation of the format, written from the documented
// design rather than from the code under test, so a drift in either shows up.
// ---------------------------------------------------------------------------
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function referenceProof(secret: string, orderId: string): string {
  return createHmac("sha256", secret).update(`zesto:pickup:v1:qr:${orderId}`).digest()
    .subarray(0, 16).toString("base64url");
}

function referenceCode(secret: string, orderId: string): string {
  const digest = createHmac("sha256", secret).update(`zesto:pickup:v1:code:${orderId}`).digest();
  // 40 bits fit exactly in a Number (< 2^53), so plain arithmetic suffices — and
  // differs deliberately from the bit-shifting in the code under test.
  let value = parseInt(digest.subarray(0, 5).toString("hex"), 16);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code = CROCKFORD[value % 32] + code;
    value = Math.floor(value / 32);
  }
  return code;
}

describe("getPickupCredentialSecret", () => {
  it("returns the configured secret, trimmed", () => {
    vi.stubEnv("PICKUP_CREDENTIAL_SECRET", `  ${SECRET}  `);

    expect(getPickupCredentialSecret()).toBe(SECRET);
  });

  it.each([["missing", ""], ["blank", "   "]])("throws a clear error when it is %s", (_label, value) => {
    vi.stubEnv("PICKUP_CREDENTIAL_SECRET", value);

    expect(() => getPickupCredentialSecret()).toThrow("PICKUP_CREDENTIAL_SECRET is not configured.");
  });

  it("throws a plain Error, never an HttpsError: a missing secret is a server fault, not a bad credential", () => {
    vi.stubEnv("PICKUP_CREDENTIAL_SECRET", "");

    let thrown: unknown;
    try {
      getPickupCredentialSecret();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpsError);
  });
});

describe("derivePickupCredentials", () => {
  it("builds the QR payload as ZP1.<orderId>.<128-bit HMAC proof>, exactly as documented", () => {
    const {qrPayload} = derivePickupCredentials(SECRET, ORDER_ID);

    expect(qrPayload).toBe(`ZP1.${ORDER_ID}.${referenceProof(SECRET, ORDER_ID)}`);
    expect(qrPayload).toMatch(/^ZP1\.[A-Za-z0-9]{20}\.[A-Za-z0-9_-]{22}$/);
  });

  it("builds the backup code as 40 bits of a SEPARATE HMAC, 8 Crockford characters, shown XXXX-XXXX", () => {
    const {code} = derivePickupCredentials(SECRET, ORDER_ID);
    const reference = referenceCode(SECRET, ORDER_ID);

    expect(code).toBe(`${reference.slice(0, 4)}-${reference.slice(4)}`);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(pickupCodeFor(SECRET, ORDER_ID)).toBe(reference);
  });

  it("is deterministic, so a reloaded customer screen shows the same credential", () => {
    expect(derivePickupCredentials(SECRET, ORDER_ID)).toEqual(derivePickupCredentials(SECRET, ORDER_ID));
  });

  it("gives every order its own credential", () => {
    const a = derivePickupCredentials(SECRET, ORDER_ID);
    const b = derivePickupCredentials(SECRET, OTHER_ORDER_ID);

    expect(a.qrPayload).not.toBe(b.qrPayload);
    expect(a.code).not.toBe(b.code);
  });

  it("gives the same order a different credential under a different secret", () => {
    const a = derivePickupCredentials(SECRET, ORDER_ID);
    const b = derivePickupCredentials(OTHER_SECRET, ORDER_ID);

    expect(a.qrPayload).not.toBe(b.qrPayload);
    expect(a.code).not.toBe(b.code);
  });

  it("never contains the secret, and the code reveals nothing of the QR proof", () => {
    const {qrPayload, code} = derivePickupCredentials(SECRET, ORDER_ID);
    const proof = referenceProof(SECRET, ORDER_ID);

    expect(qrPayload).not.toContain(SECRET);
    expect(code).not.toContain(SECRET);
    expect(qrPayload.toUpperCase()).not.toContain(code.replace("-", ""));
    expect(code.replace("-", "")).not.toBe(proof.slice(0, 8).toUpperCase());
  });

  it("is not a reversible encoding of the order ID: the proof does not depend on it in any guessable way", () => {
    const proof = referenceProof(SECRET, ORDER_ID);

    expect(Buffer.from(proof, "base64url").toString("utf8")).not.toContain(ORDER_ID);
    expect(proof).not.toContain(ORDER_ID);
    expect(proof).not.toBe(Buffer.from(ORDER_ID).toString("base64url").slice(0, 22));
  });

  it("gives 2,000 different orders 2,000 different codes (no accidental collisions)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      codes.add(pickupCodeFor(SECRET, `order-${i}`));
    }

    expect(codes.size).toBe(2000);
  });

  it("refuses a secret shorter than the minimum, with a plain Error that does not echo it", () => {
    const short = "x".repeat(PICKUP_SECRET_MIN_LENGTH - 1);

    expect(() => derivePickupCredentials(short, ORDER_ID)).toThrow(/at least 32 characters/);
    expect(() => derivePickupCredentials(short, ORDER_ID)).not.toThrow(short);
    expect(() => pickupCodeFor(short, ORDER_ID)).toThrow(/at least 32 characters/);
  });

  it("accepts a secret of exactly the minimum length", () => {
    expect(() => derivePickupCredentials("x".repeat(PICKUP_SECRET_MIN_LENGTH), ORDER_ID)).not.toThrow();
  });

  it.each(["", "a/b", "..", ".", "__x__"])("refuses to derive a credential for the malformed order ID %j", (id) => {
    expect(() => derivePickupCredentials(SECRET, id)).toThrow(/malformed order ID/);
  });

  it("refuses an order ID that would make a payload longer than a client may send back", () => {
    expect(() => derivePickupCredentials(SECRET, "a".repeat(PICKUP_CREDENTIAL_MAX_LENGTH))).toThrow(/too long/);
  });

  it("round-trips an order ID that contains a dot (the proof, not the ID, has no dots)", () => {
    const id = "legacy.order.id";
    const {qrPayload} = derivePickupCredentials(SECRET, id);

    const parsed = parsePickupCredential(qrPayload);

    expect(parsed).toMatchObject({kind: "qr", orderId: id});
    expect(pickupCredentialMatches(SECRET, id, parsed)).toBe(true);
  });
});

describe("parsePickupCredential — QR payloads", () => {
  it("parses a genuine payload into its order ID and proof", () => {
    const {qrPayload} = derivePickupCredentials(SECRET, ORDER_ID);

    expect(parsePickupCredential(qrPayload)).toEqual({
      kind: "qr",
      orderId: ORDER_ID,
      proof: referenceProof(SECRET, ORDER_ID),
    });
  });

  it("tolerates surrounding whitespace, as a keyboard-wedge scanner may add a newline", () => {
    const {qrPayload} = derivePickupCredentials(SECRET, ORDER_ID);

    expect(parsePickupCredential(`  ${qrPayload}\n`)).toMatchObject({kind: "qr", orderId: ORDER_ID});
  });

  it("is case-sensitive: a lower-case prefix is not a QR payload, and is not forgiven into one", () => {
    const {qrPayload} = derivePickupCredentials(SECRET, ORDER_ID);

    const error = httpsErrorOf(() => parsePickupCredential(qrPayload.replace("ZP1.", "zp1.")));

    expect(error.httpErrorCode.status).toBe(400);
  });

  it("is case-sensitive about the proof too: a re-cased proof parses but does not match", () => {
    const {qrPayload} = derivePickupCredentials(SECRET, ORDER_ID);
    const [prefix, orderId, proof] = qrPayload.split(".");
    const recased = proof === proof.toLowerCase() ? proof.toUpperCase() : proof.toLowerCase();

    const parsed = parsePickupCredential([prefix, orderId, recased].join("."));

    expect(pickupCredentialMatches(SECRET, ORDER_ID, parsed)).toBe(false);
  });

  it.each([
    ["no order ID", "ZP1..aaaaaaaaaaaaaaaaaaaaaa"],
    ["no proof", `ZP1.${ORDER_ID}.`],
    ["no separator", `ZP1.${ORDER_ID}`],
    ["a short proof", `ZP1.${ORDER_ID}.aaaa`],
    ["a long proof", `ZP1.${ORDER_ID}.${"a".repeat(23)}`],
    ["a proof with a bad character", `ZP1.${ORDER_ID}.${"a".repeat(21)}!`],
    ["a proof with padding", `ZP1.${ORDER_ID}.${"a".repeat(21)}=`],
    ["an order ID with a slash", `ZP1.a/b.${"a".repeat(22)}`],
    ["an order ID that is just dots", `ZP1...${"a".repeat(22)}`],
    ["an order ID of the reserved __x__ form", `ZP1.__x__.${"a".repeat(22)}`],
    ["another format version", `ZP2.${ORDER_ID}.${"a".repeat(22)}`],
  ])("rejects a payload with %s (400)", (_label, raw) => {
    const error = httpsErrorOf(() => parsePickupCredential(raw));

    expect(error.code).toBe("invalid-argument");
    expect(error.httpErrorCode.status).toBe(400);
  });
});

describe("parsePickupCredential — backup codes", () => {
  const code = referenceCode(SECRET, ORDER_ID);
  const display = `${code.slice(0, 4)}-${code.slice(4)}`;

  it.each([
    ["as displayed", display],
    ["without the hyphen", code],
    ["lower case", display.toLowerCase()],
    ["with spaces instead of the hyphen", `${code.slice(0, 4)} ${code.slice(4)}`],
    ["with stray whitespace", `  ${display}\t`],
    ["with extra separators", `${code.slice(0, 2)}-${code.slice(2, 6)} - ${code.slice(6)}`],
  ])("reads the code %s as the same code", (_label, raw) => {
    expect(parsePickupCredential(raw)).toEqual({kind: "code", code});
  });

  it("reads the look-alike characters Crockford base32 defines as their digit (O->0, I and L->1)", () => {
    expect(parsePickupCredential("OILO-OIL1")).toEqual({kind: "code", code: "01100111"});
    expect(parsePickupCredential("oilo-oil1")).toEqual({kind: "code", code: "01100111"});
  });

  it.each([
    ["empty", ""],
    ["blank", "    "],
    ["7 characters", "ABCD-EFG"],
    ["9 characters", "ABCD-EFGHJ"],
    ["a U (not in the alphabet)", "ABCD-EFGU"],
    ["a symbol", "ABCD-EF!H"],
    ["an emoji", "ABCD-EF🙂H"],
    ["a QR payload cut short", "ZP1.abc"],
    ["only separators", "- - -"],
  ])("rejects %s (400)", (_label, raw) => {
    const error = httpsErrorOf(() => parsePickupCredential(raw));

    expect(error.code).toBe("invalid-argument");
    expect(error.httpErrorCode.status).toBe(400);
  });

  it.each([undefined, null, 12345678, {}, [], ["K7QX4M2P"], true])("rejects the non-string %j (400)", (raw) => {
    expect(httpsErrorOf(() => parsePickupCredential(raw)).httpErrorCode.status).toBe(400);
  });

  it("rejects anything longer than the bound, however it is shaped", () => {
    expect(() => parsePickupCredential("A".repeat(PICKUP_CREDENTIAL_MAX_LENGTH + 1))).toThrow(HttpsError);
    expect(() => parsePickupCredential(`ZP1.${ORDER_ID}.${"a".repeat(PICKUP_CREDENTIAL_MAX_LENGTH)}`)).toThrow(HttpsError);
  });

  it("never echoes what it was given in its message", () => {
    const secretLooking = "SUPER-SECRET-VALUE-do-not-leak";

    expect(httpsErrorOf(() => parsePickupCredential(secretLooking)).message).not.toContain("SECRET");
    expect(httpsErrorOf(() => parsePickupCredential(`ZP1.${secretLooking}`)).message).not.toContain("SECRET");
  });
});

describe("pickupCredentialMatches", () => {
  const genuine = derivePickupCredentials(SECRET, ORDER_ID);

  it("accepts the genuine QR payload for its order", () => {
    expect(pickupCredentialMatches(SECRET, ORDER_ID, parsePickupCredential(genuine.qrPayload))).toBe(true);
  });

  it("accepts the genuine backup code however it was typed", () => {
    for (const typed of [genuine.code, genuine.code.toLowerCase(), genuine.code.replace("-", " ")]) {
      expect(pickupCredentialMatches(SECRET, ORDER_ID, parsePickupCredential(typed))).toBe(true);
    }
  });

  it("rejects a payload whose proof has been altered, one character at a time", () => {
    const [prefix, orderId, proof] = genuine.qrPayload.split(".");
    for (let i = 0; i < proof.length; i++) {
      const flipped = proof.slice(0, i) + (proof[i] === "A" ? "B" : "A") + proof.slice(i + 1);
      const parsed = parsePickupCredential([prefix, orderId, flipped].join("."));

      expect(pickupCredentialMatches(SECRET, ORDER_ID, parsed)).toBe(false);
    }
  });

  it("rejects a genuine payload presented for a different order (the proof binds the order)", () => {
    const parsed = parsePickupCredential(genuine.qrPayload);

    expect(pickupCredentialMatches(SECRET, OTHER_ORDER_ID, parsed)).toBe(false);
  });

  it("rejects a payload that merely re-labels another order's proof with this order's ID", () => {
    const stolenProof = derivePickupCredentials(SECRET, OTHER_ORDER_ID).qrPayload.split(".")[2];
    const forged = parsePickupCredential(`ZP1.${ORDER_ID}.${stolenProof}`);

    expect(pickupCredentialMatches(SECRET, ORDER_ID, forged)).toBe(false);
  });

  it("rejects a typed code that belongs to a different order", () => {
    const otherCode = derivePickupCredentials(SECRET, OTHER_ORDER_ID).code;

    expect(pickupCredentialMatches(SECRET, ORDER_ID, parsePickupCredential(otherCode))).toBe(false);
  });

  it("rejects the order's own credential once the secret has been rotated", () => {
    expect(pickupCredentialMatches(OTHER_SECRET, ORDER_ID, parsePickupCredential(genuine.qrPayload))).toBe(false);
    expect(pickupCredentialMatches(OTHER_SECRET, ORDER_ID, parsePickupCredential(genuine.code))).toBe(false);
  });

  it("rejects a guess made from the order ID alone", () => {
    const guesses = [
      `ZP1.${ORDER_ID}.${Buffer.from(ORDER_ID).toString("base64url").slice(0, 22)}`,
      `ZP1.${ORDER_ID}.${"A".repeat(22)}`,
      `ZP1.${ORDER_ID}.${createHmac("sha256", ORDER_ID).update(ORDER_ID).digest().subarray(0, 16).toString("base64url")}`,
    ];
    for (const guess of guesses) {
      expect(pickupCredentialMatches(SECRET, ORDER_ID, parsePickupCredential(guess))).toBe(false);
    }
    expect(pickupCredentialMatches(SECRET, ORDER_ID, parsePickupCredential("0000-0000"))).toBe(false);
  });

  it("is a boolean, never a throw, for any well-formed credential — whatever the order", () => {
    expect(pickupCredentialMatches(SECRET, "some-other-order", parsePickupCredential(genuine.code))).toBe(false);
  });
});

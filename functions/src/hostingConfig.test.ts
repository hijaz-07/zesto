// @vitest-environment node
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";

/**
 * Guards the production-facing parts of `firebase.json`: the API rewrite that fronts the
 * `api` function, the no-store header on API responses, and the baseline security headers
 * every page is served with. The CSP is REPORT-ONLY by design (see
 * docs/operations/production-readiness-audit.md): it is asserted not to enforce.
 */

interface HeaderRule {
  source: string;
  headers: {key: string; value: string}[];
}
interface Rewrite {
  source: string;
  function?: {functionId: string; region: string};
  destination?: string;
}
interface FirebaseJson {
  hosting: {public: string; headers: HeaderRule[]; rewrites: Rewrite[]};
}

const config = JSON.parse(
  readFileSync(resolve(__dirname, "../../firebase.json"), "utf8"),
) as FirebaseJson;

const headersFor = (source: string): Record<string, string> =>
  Object.fromEntries(
    (config.hosting.headers.find((rule) => rule.source === source)?.headers ?? []).map((h) => [h.key, h.value]),
  );

describe("firebase.json hosting", () => {
  it("serves the built app and rewrites /api/** to the api function in asia-south1 before the SPA fallback", () => {
    expect(config.hosting.public).toBe("dist");
    const rewrites = config.hosting.rewrites;
    expect(rewrites[0]).toEqual({source: "/api/**", function: {functionId: "api", region: "asia-south1"}});
    expect(rewrites[rewrites.length - 1]).toEqual({source: "**", destination: "/index.html"});
  });

  it("never caches API responses and revalidates the app shell", () => {
    expect(headersFor("/api/**")["Cache-Control"]).toBe("private, no-store");
    expect(headersFor("**")["Cache-Control"]).toBe("no-cache");
  });

  it("sends the baseline security headers on every page", () => {
    const all = headersFor("**");
    expect(all["X-Content-Type-Options"]).toBe("nosniff");
    expect(all["X-Frame-Options"]).toBe("DENY");
    expect(all["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  describe("Content-Security-Policy-Report-Only", () => {
    const policyText = headersFor("**")["Content-Security-Policy-Report-Only"] ?? "";
    const directives = Object.fromEntries(
      policyText.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, ...sources] = part.split(/\s+/);
        return [name, sources];
      }),
    ) as Record<string, string[]>;

    it("is present, and is NOT an enforcing policy (an unverified CSP could break sign-in or payment)", () => {
      expect(policyText).not.toBe("");
      expect(Object.keys(headersFor("**"))).not.toContain("Content-Security-Policy");
    });

    it("lets Razorpay Checkout work: its script, its frames and its API", () => {
      expect(directives["script-src"]).toContain("https://checkout.razorpay.com");
      expect(directives["frame-src"]).toEqual(expect.arrayContaining(["https://api.razorpay.com", "https://checkout.razorpay.com"]));
      expect(directives["connect-src"]).toEqual(expect.arrayContaining(["https://api.razorpay.com", "https://lumberjack.razorpay.com"]));
    });

    it("lets Descope work: its flow assets, its API (any region) and its CDN fallbacks", () => {
      expect(directives["script-src"]).toEqual(expect.arrayContaining([
        "https://static.descope.com", "https://static2.descope.com", "https://descopecdn.com", "https://cdn.jsdelivr.net",
      ]));
      expect(directives["connect-src"]).toContain("https://*.descope.com");
    });

    it("never allows inline or eval'd script, nor a wildcard script source", () => {
      const scripts = directives["script-src"];
      expect(scripts).toContain("'self'");
      expect(scripts).not.toContain("'unsafe-inline'");
      expect(scripts).not.toContain("'unsafe-eval'");
      expect(scripts.some((source) => source === "*" || source === "https:" || source === "http:")).toBe(false);
    });

    it("forbids plugins and base-tag injection, and leaves form-action open for the banks Checkout redirects to", () => {
      expect(directives["object-src"]).toEqual(["'none'"]);
      expect(directives["base-uri"]).toEqual(["'self'"]);
      expect(directives["form-action"]).toBeUndefined();
    });

    it("allows no http: source anywhere and names no Firebase data endpoint (the frontend uses none)", () => {
      expect(policyText).not.toMatch(/\bhttp:/);
      expect(policyText).not.toMatch(/firestore\.googleapis|firebaseio|googleapis\.com\/identitytoolkit|firebasestorage/);
    });
  });

  it("keeps the camera available to the app itself (the pickup QR scanner) and nothing else", () => {
    const policy = headersFor("**")["Permissions-Policy"];
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
  });
});

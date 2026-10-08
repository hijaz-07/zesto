// @vitest-environment node
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";

/**
 * Guards the production-facing parts of `firebase.json`: the API rewrite that fronts the
 * `api` function, the no-store header on API responses, and the baseline security headers
 * every page is served with. A CSP is deliberately NOT asserted: it is a later,
 * report-only step (see docs/operations/production-readiness-audit.md).
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

  it("keeps the camera available to the app itself (the pickup QR scanner) and nothing else", () => {
    const policy = headersFor("**")["Permissions-Policy"];
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
  });
});

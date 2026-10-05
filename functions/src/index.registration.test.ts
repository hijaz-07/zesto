// @vitest-environment node
import {readFileSync, readdirSync} from "node:fs";
import {describe, expect, it} from "vitest";

/**
 * `index.ts` is the one place route modules are wired into the `api` function,
 * and it cannot be imported by a test without starting the Functions runtime —
 * so every route test builds its own route list and could never notice a module
 * that was written, tested, and never registered (which is exactly how
 * `createNotificationRoutes` once shipped unwired: every notification test was
 * green while `GET /notifications` was a 404). These checks read the source
 * instead: every route module in `routes/` must be registered, and the
 * Firestore trigger must be exported.
 */

const SRC = `${__dirname}/`;
const indexSource = readFileSync(`${SRC}index.ts`, "utf8");

const routeModules = readdirSync(`${SRC}routes`)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({file, source: readFileSync(`${SRC}routes/${file}`, "utf8")}))
  .flatMap(({file, source}) => {
    const factories = [...source.matchAll(/export function (create\w+Routes)\(/g)].map((match) => match[1]);
    return factories.map((factory) => ({file, factory}));
  });

describe("functions/src/index.ts registers every route module", () => {
  it("found the route modules (the check itself is not vacuous)", () => {
    expect(routeModules.length).toBeGreaterThanOrEqual(9);
    expect(routeModules.map(({factory}) => factory)).toContain("createNotificationRoutes");
  });

  it.each(routeModules)("$file: $factory is imported and spread into ROUTES", ({file, factory}) => {
    const module = file.replace(/\.ts$/, "");
    expect(indexSource).toContain(`import {${factory}} from "./routes/${module}";`);
    expect(indexSource).toContain(`...${factory}({db: getAdminFirestore()}),`);
  });

  it("exports the notification trigger", () => {
    expect(indexSource).toContain("export const onNotificationEventCreated = onDocumentCreated(");
    expect(indexSource).toContain('document: "notificationEvents/{eventId}"');
    expect(indexSource).toContain('region: "asia-south1"');
  });
});

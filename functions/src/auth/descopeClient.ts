import descopeSdk from "@descope/node-sdk";
import {defineString} from "firebase-functions/params";

/**
 * Descope Project ID used for server-side session validation. It is read from
 * Firebase Functions parameterized configuration (`functions/.env`,
 * `functions/.env.<project>`, or `functions/.env.local` for the emulator) —
 * never from the frontend's `VITE_*` variables.
 *
 * The Project ID is a public identifier, so a string param is sufficient.
 * Any future Descope management key is a real secret and must be declared
 * with `defineSecret()` (Cloud Secret Manager) instead.
 */
export const descopeProjectId = defineString("DESCOPE_PROJECT_ID", {
  description: "Descope Project ID used to validate session tokens.",
});

export type DescopeSdk = ReturnType<typeof descopeSdk>;

let client: DescopeSdk | undefined;

/**
 * Reads the trusted backend Descope Project ID. It is both the SDK's project
 * and the expected session-token audience, so it must never be empty: the
 * SDK silently skips audience validation when given an empty audience.
 *
 * @return {string} The configured Descope Project ID.
 * @throws {Error} If `DESCOPE_PROJECT_ID` is missing or blank.
 */
export function getDescopeProjectId(): string {
  const projectId = descopeProjectId.value().trim();
  if (!projectId) {
    throw new Error("DESCOPE_PROJECT_ID is not configured.");
  }
  return projectId;
}

/**
 * Returns the process-wide Descope client, created on first use. Creation is
 * deferred because param values are only available at runtime, not while
 * the deploy tooling loads this module. Reusing one client lets warm
 * instances reuse Descope's cached public signing keys.
 *
 * @return {DescopeSdk} The shared Descope Node SDK client.
 */
export function getDescopeClient(): DescopeSdk {
  if (!client) {
    client = descopeSdk({projectId: getDescopeProjectId()});
  }
  return client;
}

import {getApps, initializeApp, type App} from "firebase-admin/app";
import {getFirestore, type Firestore} from "firebase-admin/firestore";

/**
 * Centralized Firebase Admin SDK access. Every read/write of Firestore from
 * Cloud Functions must go through `getAdminFirestore()` rather than each
 * module creating its own app/client, so there is exactly one place that
 * decides how the Admin SDK connects.
 */

let app: App | undefined;
let firestore: Firestore | undefined;

/**
 * @return {App} The shared Admin SDK app, created on first use.
 */
function getAdminApp(): App {
  if (!app) {
    const existing = getApps();
    app = existing.length > 0 ? existing[0] : initializeApp();
  }
  return app;
}

/**
 * Whether this process is a Cloud Functions emulator instance, as opposed
 * to a deployed function or a plain Node process (e.g. a test run).
 *
 * @return {boolean} Whether `FUNCTIONS_EMULATOR` is set by the emulator.
 */
function isFunctionsEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

/**
 * Returns the shared Admin Firestore client, created on first use.
 *
 * Guards against the one dangerous local-development path: running the
 * Functions emulator (e.g. via `firebase emulators:start --only functions`)
 * without also running the Firestore emulator. Without this guard, the
 * Admin SDK would silently fall back to whatever real Firestore project the
 * developer's environment is authenticated against — for Zesto that would be
 * production (`zesto-dev-2026`). The Functions dev scripts start both
 * emulators together (see `functions/package.json`), so this should never
 * actually trigger in normal local development.
 *
 * @return {Firestore} The shared Admin Firestore client.
 * @throws {Error} If running in the Functions emulator without
 *   `FIRESTORE_EMULATOR_HOST` set.
 */
export function getAdminFirestore(): Firestore {
  if (!firestore) {
    if (isFunctionsEmulator() && !process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error(
        "Refusing to use Firestore: the Functions emulator is running " +
        "without FIRESTORE_EMULATOR_HOST set, which means Admin SDK calls " +
        "would hit real Firestore instead of the emulator. Start the " +
        "Firestore emulator alongside Functions (`npm run serve`, which " +
        "starts both).",
      );
    }
    firestore = getFirestore(getAdminApp());
  }
  return firestore;
}

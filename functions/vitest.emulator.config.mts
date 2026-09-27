import {defineConfig} from 'vitest/config';

// Functions tests that need a live Firestore emulator (not the fake `db`
// used by the rest of functions/src/**/*.test.ts). Run via
// `npm run test:functions-emulator` from the repo root, which wraps this in
// `firebase emulators:exec` so FIRESTORE_EMULATOR_HOST is set first.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['functions/src/**/*.emulator.test.ts'],
  },
});

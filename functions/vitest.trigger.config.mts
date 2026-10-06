import {defineConfig} from 'vitest/config';

// Tests that need the real Functions emulator AND the Firestore emulator, so the
// production Firestore trigger (`onNotificationEventCreated`) is what processes
// the events. Run via `npm run test:functions-trigger` from the repo root, which
// prepares an isolated, secret-free Functions source and wraps this in
// `firebase emulators:exec` (see scripts/test-notification-trigger.mjs).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['functions/src/**/*.trigger.test.ts'],
  },
});

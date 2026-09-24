import { defineConfig } from 'vitest/config';

// Firestore rules tests run against a live emulator in a Node environment,
// separate from the app's jsdom-based unit test config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['firestore/**/*.test.ts'],
  },
});

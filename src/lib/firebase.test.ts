import { getApps } from 'firebase/app';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const TEST_ENV = {
  VITE_FIREBASE_API_KEY: 'test-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'zesto-test.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'zesto-test',
  VITE_FIREBASE_STORAGE_BUCKET: 'zesto-test.firebasestorage.app',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  VITE_FIREBASE_APP_ID: '1:000000000000:web:0000000000000000000000',
};

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    vi.stubEnv(key, value);
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('firebase client', () => {
  it('initializes the Firebase app from env-provided config', async () => {
    const { firebaseApp } = await import('./firebase');
    expect(firebaseApp.options.projectId).toBe(TEST_ENV.VITE_FIREBASE_PROJECT_ID);
  });

  it('reuses the existing Firebase app instance rather than creating a duplicate', async () => {
    const first = await import('./firebase');
    const second = await import('./firebase');
    expect(second.firebaseApp).toBe(first.firebaseApp);
    expect(getApps()).toHaveLength(1);
  });

  it('creates Auth, Firestore, Functions, and Storage service instances', async () => {
    const { auth, db, functions, storage, firebaseApp } = await import('./firebase');
    expect(auth.app).toBe(firebaseApp);
    expect(db.app).toBe(firebaseApp);
    expect(functions.app).toBe(firebaseApp);
    expect(storage.app).toBe(firebaseApp);
  });

  describe('shouldUseEmulators', () => {
    it('is true in development, so local builds target the emulator suite', async () => {
      const { shouldUseEmulators } = await import('./firebase');
      expect(shouldUseEmulators({ DEV: true })).toBe(true);
    });

    it('is false in production, so production builds never target the emulator suite', async () => {
      const { shouldUseEmulators } = await import('./firebase');
      expect(shouldUseEmulators({ DEV: false })).toBe(false);
    });
  });
});

import { type FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { type Auth, connectAuthEmulator, getAuth } from 'firebase/auth';
import { type Firestore, connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { type Functions, connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { type FirebaseStorage, connectStorageEmulator, getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseApp: FirebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const auth: Auth = getAuth(firebaseApp);
export const db: Firestore = getFirestore(firebaseApp);
export const functions: Functions = getFunctions(firebaseApp);
export const storage: FirebaseStorage = getStorage(firebaseApp);

const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORTS = {
  auth: 9099,
  firestore: 8080,
  functions: 5001,
  storage: 9199,
} as const;

/** Pure decision logic for whether local emulators should be used, kept separate from `import.meta.env` for easy testing. */
export function shouldUseEmulators(env: { DEV: boolean } = import.meta.env): boolean {
  return env.DEV;
}

const globalForFirebase = globalThis as typeof globalThis & {
  __zestoFirebaseEmulatorsConnected?: boolean;
};

if (shouldUseEmulators() && !globalForFirebase.__zestoFirebaseEmulatorsConnected) {
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore);
  connectFunctionsEmulator(functions, EMULATOR_HOST, EMULATOR_PORTS.functions);
  connectStorageEmulator(storage, EMULATOR_HOST, EMULATOR_PORTS.storage);
  globalForFirebase.__zestoFirebaseEmulatorsConnected = true;
}

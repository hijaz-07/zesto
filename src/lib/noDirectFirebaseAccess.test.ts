import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pins the data-access architecture that makes `firestore.rules` and `storage.rules`
 * `allow read, write: if false` correct and safe:
 *
 *   Frontend ──HTTPS /api/**──▶ Cloud Functions (verify the Descope session, authorize)
 *            ──Admin SDK──▶ Firestore
 *
 * No application code may talk to Firestore, Storage, Cloud Functions callables or Firebase
 * Auth directly. If a feature ever needs that, the rules for exactly that data must be
 * designed and reviewed first — the rules must not be loosened to make a feature work.
 * `src/lib/firebase.ts` still exists (it initialises the SDK) but nothing imports it.
 */

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: `/${relative(SRC, path).replace(/\\/g, '/')}`,
  text: readFileSync(path, 'utf8'),
}));

const importsOf = (pattern: RegExp): string[] =>
  files.filter(({ text }) => pattern.test(text)).map(({ path }) => path);

describe('the frontend reaches data only through the backend API', () => {
  it('found the application sources (the check itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(({ path }) => path)).toContain('/lib/api/client.ts');
  });

  it('no application code imports Firestore, Storage, Functions, Auth or Messaging from the Firebase SDK, except the unused initialiser', () => {
    expect(importsOf(/from\s+['"]firebase\/(firestore|storage|functions|auth|messaging|database)/)).toEqual(['/lib/firebase.ts']);
    expect(importsOf(/require\(\s*['"]firebase/)).toEqual([]);
  });

  it('nothing imports the Firebase initialiser: no feature has a client handle on Firestore or Storage', () => {
    expect(importsOf(/from\s+['"][^'"]*\/lib\/firebase['"]|from\s+['"]\.\/firebase['"]|from\s+['"]\.\.\/firebase['"]/)).toEqual([]);
  });

  it('Firebase Authentication is not used anywhere: Descope is the sole identity provider', () => {
    expect(importsOf(/firebase\/auth|signInWithCustomToken|onAuthStateChanged/)).toEqual([]);
  });

  it('the only network client the application code uses for its own data is the /api client', () => {
    expect(importsOf(/\bfetch\(/)).toEqual(['/lib/api/client.ts']);
    expect(importsOf(/XMLHttpRequest|axios|navigator\.sendBeacon/)).toEqual([]);
  });

  it('the API client talks to the same-origin /api prefix (Hosting rewrite to the api function), never to Firebase directly', () => {
    const client = files.find(({ path }) => path === '/lib/api/client.ts')?.text ?? '';
    expect(client).toMatch(/['"`]\/api/);
    expect(client).not.toMatch(/firestore\.googleapis\.com|firebaseio\.com|cloudfunctions\.net|run\.app/);
  });
});

import { expect, vi } from 'vitest';

/**
 * Watches every way a page could persist or leak a value in the browser, so a
 * test can prove a secret (a pickup credential) stayed in memory:
 *
 * - `localStorage` and `sessionStorage` (any `setItem`, which is stricter than
 *   "no secret written": nothing at all may be written);
 * - IndexedDB (`indexedDB.open` throws if anything reaches for it);
 * - cookies (any write to `document.cookie`);
 * - the URL and history (`pushState`/`replaceState`, and the address itself).
 *
 * `expectNothingPersisted(secrets)` also fails if any of `secrets` shows up in
 * the address, in storage, or in the cookie jar. Call `restore()` afterwards
 * (an `afterEach` is the natural place). Firestore is not watched here: this
 * app's frontend has no Firestore access at all, which `security.test.ts`-style
 * source checks already enforce.
 */
export interface PersistenceGuard {
  expectNothingPersisted(secrets?: readonly string[]): void;
  restore(): void;
}

export function watchPersistence(): PersistenceGuard {
  window.localStorage.clear();
  window.sessionStorage.clear();

  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const pushState = vi.spyOn(window.history, 'pushState');
  const replaceState = vi.spyOn(window.history, 'replaceState');
  const cookieWrite = vi.spyOn(document, 'cookie', 'set');
  const indexedDbOpen = vi.fn(() => {
    throw new Error('IndexedDB must not be used for a pickup credential.');
  });
  vi.stubGlobal('indexedDB', { open: indexedDbOpen, deleteDatabase: indexedDbOpen });

  return {
    expectNothingPersisted(secrets = []) {
      expect(setItem, 'localStorage/sessionStorage.setItem').not.toHaveBeenCalled();
      expect(window.localStorage.length, 'localStorage entries').toBe(0);
      expect(window.sessionStorage.length, 'sessionStorage entries').toBe(0);
      expect(indexedDbOpen, 'indexedDB access').not.toHaveBeenCalled();
      expect(cookieWrite, 'document.cookie writes').not.toHaveBeenCalled();
      expect(pushState, 'history.pushState').not.toHaveBeenCalled();
      expect(replaceState, 'history.replaceState').not.toHaveBeenCalled();

      const address = `${window.location.href}${window.location.search}${window.location.hash}`;
      for (const secret of secrets) {
        expect(address, 'the address').not.toContain(secret);
        expect(address, 'the address (encoded)').not.toContain(encodeURIComponent(secret));
        expect(document.cookie, 'the cookie jar').not.toContain(secret);
      }
    },
    restore() {
      setItem.mockRestore();
      pushState.mockRestore();
      replaceState.mockRestore();
      cookieWrite.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

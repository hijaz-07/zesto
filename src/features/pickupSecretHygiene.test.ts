import { describe, expect, it } from 'vitest';

/**
 * A source-level guard for the rule "a pickup credential lives in memory only".
 * The behavioural tests (`persistenceGuard`) prove nothing was written during
 * the flows they exercise; this proves the code that handles a credential
 * cannot reach any persistence or leak channel at all, so a future edit that
 * adds one fails here even if no test happens to take that path.
 *
 * It reads the real source of every file that touches a credential, with
 * comments stripped (several say "never localStorage" on purpose).
 */

const credentialFiles = import.meta.glob(
  [
    '../components/common/QrCode.tsx',
    './order/{useOrderPickup,PickupCredentialCard,useReadyOrderRefresh}.{ts,tsx}',
    './organizationOrder/{pickupInput,usePickupRedeem,QrScanner,cameraScanning,useQrScannerSupport,PickupResultCard}.{ts,tsx}',
    '../pages/organization/OrganizationPickupPage.tsx',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const customerPage = import.meta.glob('../pages/customer/CustomerOrderConfirmationPage.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every non-test source file of the app. */
const allSources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** `source` without comments (block, whole-line and trailing). Crude on purpose: it only has to hide prose. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '');
}

const PERSISTENCE = /\b(localStorage|sessionStorage|indexedDB|IndexedDB|caches|BroadcastChannel|serviceWorker|document\.cookie|cookieStore)\b/;
const LOGGING = /\bconsole\s*\./;
const URL_WRITES =
  /\b(pushState|replaceState|useSearchParams|setSearchParams|window\.open)\b|\blocation\.(href|assign|replace|search|hash)\b\s*(=|\()/;
const MARKUP_INJECTION = /\b(dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write)\b/;

describe('the files that handle a pickup credential', () => {
  it('are all found (so a rename cannot quietly shrink what this guard covers)', () => {
    expect(Object.keys(credentialFiles).map((path) => path.split('/').pop()).sort()).toEqual([
      'OrganizationPickupPage.tsx',
      'PickupCredentialCard.tsx',
      'PickupResultCard.tsx',
      'QrCode.tsx',
      'QrScanner.tsx',
      'cameraScanning.ts',
      'pickupInput.ts',
      'useOrderPickup.ts',
      'usePickupRedeem.ts',
      'useQrScannerSupport.ts',
      'useReadyOrderRefresh.ts',
    ]);
  });

  describe.each(Object.entries(credentialFiles))('%s', (path, source) => {
    const code = withoutComments(source);

    it('never touches browser storage, cookies, IndexedDB, caches or workers', () => {
      expect(code).not.toMatch(PERSISTENCE);
    });

    it('never logs', () => {
      expect(code).not.toMatch(LOGGING);
    });

    it('never writes to the address bar, history or query string', () => {
      expect(code).not.toMatch(URL_WRITES);
    });

    it('never injects markup (the QR is built from the module matrix, not an HTML string)', () => {
      expect(code).not.toMatch(MARKUP_INJECTION);
    });

    it(`is not mistaken for something it is not (${path.split('/').pop()})`, () => {
      expect(code.trim().length).toBeGreaterThan(0);
    });
  });

  it('also holds for the customer order page that shows the credential', () => {
    const [[, source]] = Object.entries(customerPage);
    const code = withoutComments(source);

    expect(code).not.toMatch(PERSISTENCE);
    expect(code).not.toMatch(LOGGING);
    expect(code).not.toMatch(MARKUP_INJECTION);
    expect(code).not.toMatch(/\buseSearchParams\b/);
  });
});

describe('who may ask for or redeem a credential', () => {
  const callers = (name: string) =>
    Object.entries(allSources)
      .filter(([, source]) => new RegExp(`\\b${name}\\b`).test(withoutComments(source)))
      .map(([path]) => path.split('/').pop())
      .sort();

  it('only the credential hook asks for the customer credential (besides the module that defines it)', () => {
    expect(callers('getPickupCredential')).toEqual(['api.ts', 'useOrderPickup.ts']);
  });

  it('only the redemption hook redeems one (besides the module that defines it)', () => {
    expect(callers('redeemPickup')).toEqual(['api.ts', 'usePickupRedeem.ts']);
  });
});

describe('this guard itself', () => {
  it('sees through comments, but not through code', () => {
    expect(withoutComments('// never localStorage\nconst a = 1;')).not.toMatch(PERSISTENCE);
    expect(withoutComments('/* sessionStorage */ const a = 1;')).not.toMatch(PERSISTENCE);
    expect(withoutComments('const x = 1; // note\nlocalStorage.setItem("k", v);')).toMatch(PERSISTENCE);
  });

  it('detects each channel it is meant to', () => {
    expect(PERSISTENCE.test('indexedDB.open("x")')).toBe(true);
    expect(PERSISTENCE.test('document.cookie = "a=b"')).toBe(true);
    expect(LOGGING.test('console.log(value)')).toBe(true);
    expect(URL_WRITES.test('history.pushState({}, "", url)')).toBe(true);
    expect(URL_WRITES.test('window.location.href = url')).toBe(true);
    expect(MARKUP_INJECTION.test('<div dangerouslySetInnerHTML={{ __html: x }} />')).toBe(true);
  });
});

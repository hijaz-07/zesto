import { describe, expect, it } from 'vitest';

/**
 * Source-level guards for the payment flow's trust boundary (see root
 * CLAUDE.md's "Never trust the frontend for security"): the browser holds no
 * Razorpay secret and no hard-coded key, and never writes payment or order
 * state to Firestore itself — only the backend confirms a payment.
 *
 * These scan the application's own non-test source. (Test files and
 * `src/test/` fixtures are excluded: they legitimately contain fake keys and
 * the very strings these tests look for.) The built bundle is checked
 * separately after `npm run build`.
 */

const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const sourceEntries = Object.entries(sources);

/** Drops block and line comments, so a guard can check what the code does rather than what its docs say. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function filesMatching(
  pattern: RegExp,
  scope: (path: string) => boolean = () => true,
  options: { ignoreComments?: boolean } = {},
): string[] {
  return sourceEntries
    .filter(([path, text]) => scope(path) && pattern.test(options.ignoreComments ? withoutComments(text) : text))
    .map(([path]) => path);
}

describe('payment security (source scan)', () => {
  it('scans a meaningful set of application source files', () => {
    expect(sourceEntries.length).toBeGreaterThan(50);
    expect(Object.keys(sources)).toContain('/src/features/payment/usePayOrder.ts');
    expect(Object.keys(sources)).toContain('/src/pages/customer/CustomerOrderConfirmationPage.tsx');
  });

  it('never references the Razorpay key secret anywhere in frontend source', () => {
    expect(filesMatching(/RAZORPAY_KEY_SECRET|key_secret|keySecret/i)).toEqual([]);
  });

  it('never defines a client-exposed (VITE_) Razorpay variable, so no Razorpay credential can be bundled', () => {
    expect(filesMatching(/VITE_RAZORPAY/i)).toEqual([]);
  });

  it('hard-codes no Razorpay key at all: the Checkout key only ever comes from the backend response', () => {
    expect(filesMatching(/rzp_(test|live)_[A-Za-z0-9]/)).toEqual([]);
  });

  it('never refers to Live Mode', () => {
    expect(filesMatching(/rzp_live|live[_ -]?mode/i)).toEqual([]);
  });

  it('never reads import.meta.env for anything payment-related', () => {
    const paymentFiles = (path: string) => path.startsWith('/src/features/payment/');
    expect(filesMatching(/import\.meta\.env/, paymentFiles)).toEqual([]);
  });

  it('never sends the Descope session token or Firebase credentials to Checkout', () => {
    const checkoutFiles = (path: string) => /\/src\/features\/payment\/razorpay(Checkout|Script|Types)\.ts$/.test(path);
    expect(filesMatching(/getSessionToken|Authorization|firebase/i, checkoutFiles, { ignoreComments: true })).toEqual([]);
  });

  it('never imports Firestore (or the Firebase module that exposes it) from the payment feature, the order feature, or the order page', () => {
    const paymentPaths = (path: string) =>
      path.startsWith('/src/features/payment/') ||
      path.startsWith('/src/features/order/') ||
      path === '/src/pages/customer/CustomerOrderConfirmationPage.tsx';

    expect(filesMatching(/firebase\/firestore|lib\/firebase/, paymentPaths)).toEqual([]);
  });

  it('never calls a Firestore write API from any React or feature code', () => {
    expect(filesMatching(/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\s*\(/)).toEqual([]);
  });

  it("only src/lib/firebase.ts touches Firestore at all, and nothing in the app imports it for payments", () => {
    expect(filesMatching(/firebase\/firestore/)).toEqual(['/src/lib/firebase.ts']);
    expect(filesMatching(/['"]payments['"]|\/payments\//, (path) => !path.startsWith('/src/features/payment/'))).toEqual([]);
  });

  it('reaches payment state only through the two backend endpoints', () => {
    const apiCalls = filesMatching(/apiFetch/, (path) => path.startsWith('/src/features/payment/'));
    expect(apiCalls).toEqual(['/src/features/payment/api.ts']);
  });
});

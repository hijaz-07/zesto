import type { RazorpayConstructor } from './razorpayTypes';

/** Razorpay's official hosted Web Checkout script. */
export const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** How long to wait for the script before giving up, so a stalled network can't leave a payment attempt hanging forever. */
const LOAD_TIMEOUT_MS = 15_000;

export type RazorpayScriptErrorCode = 'load_failed' | 'timeout' | 'missing_global';

/** The Checkout script couldn't be made available. Safe to retry — nothing is cached after a failure. */
export class RazorpayScriptError extends Error {
  readonly code: RazorpayScriptErrorCode;

  constructor(code: RazorpayScriptErrorCode, message: string) {
    super(message);
    this.name = 'RazorpayScriptError';
    this.code = code;
  }
}

let pendingLoad: Promise<RazorpayConstructor> | null = null;

function loadedConstructor(): RazorpayConstructor | null {
  return typeof window.Razorpay === 'function' ? window.Razorpay : null;
}

/**
 * Loads Razorpay's Checkout script on demand and resolves with its global
 * `Razorpay` constructor. Called only when a customer actually starts a
 * payment — never at app start or on page load — so every other page, and
 * the rest of the app, is unaffected by (and never waits on) this script.
 *
 * - Already loaded: resolves immediately, adding nothing to the DOM.
 * - Load already in flight: concurrent callers share one promise and one
 *   `<script>` tag.
 * - Failure (network error, timeout, or the script loading without defining
 *   `window.Razorpay`): rejects with `RazorpayScriptError`, removes the
 *   failed tag, and caches nothing — so the next call starts a clean
 *   attempt, and there is never more than one Checkout `<script>` tag.
 */
export function loadRazorpayCheckout(): Promise<RazorpayConstructor> {
  const existing = loadedConstructor();
  if (existing) {
    return Promise.resolve(existing);
  }
  if (pendingLoad) {
    return pendingLoad;
  }

  // A tag left over from an earlier attempt that never produced the global
  // is dead weight; replace it rather than stacking a second tag beside it.
  document.querySelectorAll(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`).forEach((stale) => stale.remove());

  pendingLoad = new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;

    // `fail` runs only after `timeout` is assigned (it's invoked from the
    // timer or script events, never synchronously here).
    const fail = (error: RazorpayScriptError) => {
      window.clearTimeout(timeout);
      script.remove();
      pendingLoad = null;
      reject(error);
    };

    const timeout = window.setTimeout(
      () => fail(new RazorpayScriptError('timeout', 'Razorpay Checkout took too long to load.')),
      LOAD_TIMEOUT_MS,
    );

    script.addEventListener('load', () => {
      const razorpay = loadedConstructor();
      if (!razorpay) {
        fail(new RazorpayScriptError('missing_global', 'Razorpay Checkout loaded but is unavailable.'));
        return;
      }
      window.clearTimeout(timeout);
      pendingLoad = null;
      resolve(razorpay);
    });
    script.addEventListener('error', () => {
      fail(new RazorpayScriptError('load_failed', 'Razorpay Checkout could not be loaded.'));
    });

    document.head.appendChild(script);
  });

  return pendingLoad;
}

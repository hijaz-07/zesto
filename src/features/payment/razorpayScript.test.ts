import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRazorpay } from '../../test/paymentFixtures';

// The loader keeps its in-flight promise in module state; load a fresh copy
// per test so one test's pending load can't leak into the next.
type ScriptModule = typeof import('./razorpayScript');
let loadRazorpayCheckout: ScriptModule['loadRazorpayCheckout'];
let RAZORPAY_CHECKOUT_SRC: ScriptModule['RAZORPAY_CHECKOUT_SRC'];
let RazorpayScriptError: ScriptModule['RazorpayScriptError'];

function checkoutScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`));
}

/** Plays the browser finishing the script download, optionally defining the global as the real script would. */
function finishLoading(options: { defineGlobal: boolean }): void {
  if (options.defineGlobal) {
    window.Razorpay = FakeRazorpay;
  }
  checkoutScripts()[0].dispatchEvent(new Event('load'));
}

describe('loadRazorpayCheckout', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ loadRazorpayCheckout, RAZORPAY_CHECKOUT_SRC, RazorpayScriptError } = await import('./razorpayScript'));
    delete window.Razorpay;
    checkoutScripts().forEach((script) => script.remove());
  });

  afterEach(() => {
    // Settle any load a test left in flight, which also clears its timeout.
    checkoutScripts()[0]?.dispatchEvent(new Event('error'));
    vi.useRealTimers();
    delete window.Razorpay;
    checkoutScripts().forEach((script) => script.remove());
  });

  it("loads Razorpay's official hosted Checkout script only when called", () => {
    expect(checkoutScripts()).toHaveLength(0);

    void loadRazorpayCheckout().catch(() => {});

    expect(checkoutScripts()).toHaveLength(1);
    expect(checkoutScripts()[0].src).toBe('https://checkout.razorpay.com/v1/checkout.js');
  });

  it('resolves with the global Razorpay constructor once the script loads', async () => {
    const promise = loadRazorpayCheckout();

    finishLoading({ defineGlobal: true });

    await expect(promise).resolves.toBe(FakeRazorpay);
  });

  it('adds nothing to the DOM and resolves immediately when Razorpay is already loaded', async () => {
    window.Razorpay = FakeRazorpay;

    await expect(loadRazorpayCheckout()).resolves.toBe(FakeRazorpay);

    expect(checkoutScripts()).toHaveLength(0);
  });

  it('shares one script tag and one result between concurrent callers', async () => {
    const first = loadRazorpayCheckout();
    const second = loadRazorpayCheckout();

    expect(checkoutScripts()).toHaveLength(1);
    expect(second).toBe(first);

    finishLoading({ defineGlobal: true });
    await expect(Promise.all([first, second])).resolves.toEqual([FakeRazorpay, FakeRazorpay]);
  });

  it('does not add another script tag after a successful load', async () => {
    const promise = loadRazorpayCheckout();
    finishLoading({ defineGlobal: true });
    await promise;

    await loadRazorpayCheckout();
    await loadRazorpayCheckout();

    expect(checkoutScripts()).toHaveLength(1);
  });

  it('rejects with load_failed on a network error, removing the failed tag', async () => {
    const promise = loadRazorpayCheckout();

    checkoutScripts()[0].dispatchEvent(new Event('error'));

    await expect(promise).rejects.toMatchObject({ name: 'RazorpayScriptError', code: 'load_failed' });
    expect(checkoutScripts()).toHaveLength(0);
  });

  it('rejects with missing_global when the script loads but defines no Razorpay global', async () => {
    const promise = loadRazorpayCheckout();

    finishLoading({ defineGlobal: false });

    await expect(promise).rejects.toMatchObject({ code: 'missing_global' });
    await expect(promise).rejects.toBeInstanceOf(RazorpayScriptError);
    expect(checkoutScripts()).toHaveLength(0);
  });

  it('rejects with timeout if the script never finishes loading', async () => {
    vi.useFakeTimers();
    const promise = loadRazorpayCheckout();
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });

    await vi.advanceTimersByTimeAsync(15_000);

    await assertion;
    expect(checkoutScripts()).toHaveLength(0);
  });

  it('can be retried after a failure, with a fresh tag and never more than one at a time', async () => {
    const failed = loadRazorpayCheckout();
    checkoutScripts()[0].dispatchEvent(new Event('error'));
    await expect(failed).rejects.toMatchObject({ code: 'load_failed' });

    const retry = loadRazorpayCheckout();
    expect(checkoutScripts()).toHaveLength(1);
    finishLoading({ defineGlobal: true });

    await expect(retry).resolves.toBe(FakeRazorpay);
    expect(checkoutScripts()).toHaveLength(1);
  });

  it('replaces a stale tag left in the page instead of stacking a second one beside it', () => {
    const stale = document.createElement('script');
    stale.src = RAZORPAY_CHECKOUT_SRC;
    document.head.appendChild(stale);

    void loadRazorpayCheckout().catch(() => {});

    expect(checkoutScripts()).toHaveLength(1);
    expect(checkoutScripts()[0]).not.toBe(stale);
  });
});

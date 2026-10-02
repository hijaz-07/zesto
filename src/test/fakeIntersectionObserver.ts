import { vi } from 'vitest';

/**
 * A controllable `IntersectionObserver` for jsdom, which has none. A test
 * installs it with `FakeIntersectionObserver.install()`, then drives
 * visibility by hand with `emit(true | false)` on the live observer.
 */
export class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly observed: Element[] = [];
  disconnected = false;
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  /** Replaces the global observer with this fake; undo with `uninstall`. */
  static install(): void {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  }

  static uninstall(): void {
    FakeIntersectionObserver.instances = [];
    vi.unstubAllGlobals();
  }

  /** The observers that are currently watching something. */
  static live(): FakeIntersectionObserver[] {
    return FakeIntersectionObserver.instances.filter((observer) => !observer.disconnected);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Reports the observed element as now visible (`true`) or hidden (`false`). */
  emit(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Calls `onVisible` each time `ref`'s element goes from hidden to visible
 * again. Built for pages Ionic keeps mounted but hides (`display: none`) when
 * the customer switches tabs: coming back to such a page is not a mount, and
 * Ionic's own `ionView*` lifecycle events were observed not to fire for these
 * tab switches, so visibility itself is the signal.
 *
 * The first report is only a baseline: a page that is visible when it mounts
 * is not "becoming visible", so `onVisible` never fires for it. Does nothing
 * where `IntersectionObserver` doesn't exist.
 */
export function useOnBecameVisible(ref: RefObject<Element | null>, onVisible: () => void): void {
  const latest = useRef(onVisible);
  useEffect(() => {
    latest.current = onVisible;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      return;
    }

    let wasVisible: boolean | null = null;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1].isIntersecting;
      if (visible && wasVisible === false) {
        latest.current();
      }
      wasVisible = visible;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
}

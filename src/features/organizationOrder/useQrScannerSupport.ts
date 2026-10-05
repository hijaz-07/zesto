import { useEffect, useState } from 'react';
import { detectQrScannerSupport } from './cameraScanning';

/** `checking` until the browser has been asked; the page offers scanning only on `supported`. */
export type QrScannerSupport = 'checking' | 'supported' | 'unsupported';

/**
 * Whether this browser can scan QR codes with a camera (see
 * `detectQrScannerSupport`), asked once on mount. It starts as `checking` and
 * becomes `supported` or `unsupported` — so "Scan QR" never flashes up on a
 * browser that cannot use it, and a check that fails for any reason is simply
 * `unsupported`. Typing the code does not depend on this at all.
 */
export function useQrScannerSupport(): QrScannerSupport {
  const [support, setSupport] = useState<QrScannerSupport>('checking');

  useEffect(() => {
    let cancelled = false;
    void detectQrScannerSupport().then((supported) => {
      if (!cancelled) {
        setSupport(supported ? 'supported' : 'unsupported');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return support;
}

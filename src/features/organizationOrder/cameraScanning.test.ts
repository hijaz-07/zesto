import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QrScannerUnsupportedError,
  cameraFailureMessage,
  classifyCameraError,
  createQrDetector,
  detectQrScannerSupport,
  type CameraFailure,
} from './cameraScanning';

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

function stubCamera(present: boolean) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: present ? { getUserMedia: vi.fn() } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  } else {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  }
});

/** A `BarcodeDetector` stand-in. */
function stubDetector(options: { formats?: string[] | Error; withFormatQuery?: boolean; throwsOnConstruct?: boolean }) {
  const { formats = ['qr_code'], withFormatQuery = true, throwsOnConstruct = false } = options;
  class FakeDetector {
    static constructed: Array<{ formats?: string[] } | undefined> = [];
    constructor(config?: { formats?: string[] }) {
      if (throwsOnConstruct) {
        throw new TypeError('unsupported format');
      }
      FakeDetector.constructed.push(config);
    }
    async detect() {
      return [];
    }
    static getSupportedFormats = withFormatQuery
      ? async () => {
          if (formats instanceof Error) {
            throw formats;
          }
          return formats;
        }
      : undefined;
  }
  vi.stubGlobal('BarcodeDetector', FakeDetector);
  return FakeDetector;
}

describe('detectQrScannerSupport', () => {
  it('is false in a browser with no camera API (no secure context, or no device API at all)', async () => {
    stubCamera(false);
    stubDetector({});

    await expect(detectQrScannerSupport()).resolves.toBe(false);
  });

  it('is false in a browser with no BarcodeDetector (Safari, Firefox, some desktop Chromes)', async () => {
    stubCamera(true);

    await expect(detectQrScannerSupport()).resolves.toBe(false);
  });

  it('is true when there is a camera and the detector reports it can read QR codes', async () => {
    stubCamera(true);
    stubDetector({ formats: ['ean_13', 'qr_code'] });

    await expect(detectQrScannerSupport()).resolves.toBe(true);
  });

  it('is false when the detector exists but cannot read QR codes: the constructor existing is not enough', async () => {
    stubCamera(true);
    stubDetector({ formats: ['ean_13', 'code_128'] });

    await expect(detectQrScannerSupport()).resolves.toBe(false);
  });

  it('is false when asking which formats it supports fails', async () => {
    stubCamera(true);
    stubDetector({ formats: new Error('boom') });

    await expect(detectQrScannerSupport()).resolves.toBe(false);
  });

  it('accepts an older detector with no format query, as long as it takes qr_code', async () => {
    stubCamera(true);
    const Detector = stubDetector({ withFormatQuery: false });

    await expect(detectQrScannerSupport()).resolves.toBe(true);
    expect(Detector.constructed).toEqual([{ formats: ['qr_code'] }]);
  });

  it('is false for an older detector that rejects qr_code', async () => {
    stubCamera(true);
    stubDetector({ withFormatQuery: false, throwsOnConstruct: true });

    await expect(detectQrScannerSupport()).resolves.toBe(false);
  });

  it('is false when BarcodeDetector is something other than a constructor', async () => {
    stubCamera(true);
    vi.stubGlobal('BarcodeDetector', { not: 'a function' });

    await expect(detectQrScannerSupport()).resolves.toBe(false);
  });
});

describe('createQrDetector', () => {
  it('builds a detector for QR codes only', () => {
    const Detector = stubDetector({});

    createQrDetector();

    expect(Detector.constructed).toEqual([{ formats: ['qr_code'] }]);
  });

  it('throws an unsupported error when there is no BarcodeDetector', () => {
    expect(() => createQrDetector()).toThrow(QrScannerUnsupportedError);
  });

  it('throws an unsupported error when the detector refuses QR codes', () => {
    stubDetector({ throwsOnConstruct: true });

    expect(() => createQrDetector()).toThrow(QrScannerUnsupportedError);
  });
});

describe('classifyCameraError', () => {
  const named = (name: string) => Object.assign(new Error('x'), { name });

  it.each<[unknown, CameraFailure]>([
    [named('NotAllowedError'), 'denied'],
    [named('SecurityError'), 'denied'],
    [named('PermissionDeniedError'), 'denied'],
    [named('NotFoundError'), 'no_camera'],
    [named('DevicesNotFoundError'), 'no_camera'],
    [named('OverconstrainedError'), 'no_camera'],
    [named('NotSupportedError'), 'unsupported'],
    [new QrScannerUnsupportedError(), 'unsupported'],
    [named('NotReadableError'), 'failed'],
    [named('AbortError'), 'failed'],
    [new Error('anything else'), 'failed'],
    ['a string', 'failed'],
    [undefined, 'failed'],
  ])('reads %j as %s', (error, failure) => {
    expect(classifyCameraError(error)).toBe(failure);
  });
});

describe('cameraFailureMessage', () => {
  it.each(['denied', 'no_camera', 'unsupported', 'failed'] as const)(
    'always points %s at typing the code, so a camera problem never leaves staff stuck',
    (failure) => {
      expect(cameraFailureMessage(failure)).toMatch(/type the code instead/i);
    },
  );

  it('tells staff how to fix a blocked camera', () => {
    expect(cameraFailureMessage('denied')).toContain('browser settings');
  });
});

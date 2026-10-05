/**
 * Browser QR scanning for `/org/pickup`, built on what the browser itself offers
 * — `getUserMedia` for the camera and `BarcodeDetector` for reading — with NO
 * bundled QR decoder. Neither is available everywhere (`BarcodeDetector` is
 * missing in Safari and Firefox and in some desktop Chromes, and a camera needs
 * a secure context and a device), so nothing here may be assumed: support is
 * detected, the page shows "Scan QR" only where it is real, and typing the
 * backup code (or a keyboard-wedge scanner, which types into the same field)
 * always works without any of this. A later native app can scan with its own
 * camera plugin and reach the same backend.
 */

/** One barcode a detector found. */
interface DetectedBarcode {
  rawValue: string;
}

/** The part of the Shape Detection API's `BarcodeDetector` this feature uses. */
export interface QrDetector {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

interface QrDetectorConstructor {
  new (options?: { formats?: string[] }): QrDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

/** The scanner is not available in this browser (raised when one is asked for anyway). */
export class QrScannerUnsupportedError extends Error {
  constructor() {
    super('QR scanning is not supported in this browser.');
    this.name = 'QrScannerUnsupportedError';
  }
}

function detectorConstructor(): QrDetectorConstructor | null {
  const candidate = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof candidate === 'function' ? (candidate as QrDetectorConstructor) : null;
}

function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * Whether this browser can really scan QR codes with a camera: a camera API AND a
 * `BarcodeDetector` that reports it reads `qr_code` (the constructor merely
 * existing is not enough — some browsers ship it for other formats only).
 * Resolves `false`, never throws, for anything it cannot confirm.
 */
export async function detectQrScannerSupport(): Promise<boolean> {
  if (!cameraAvailable()) {
    return false;
  }
  const Detector = detectorConstructor();
  if (!Detector) {
    return false;
  }
  try {
    if (typeof Detector.getSupportedFormats === 'function') {
      return (await Detector.getSupportedFormats()).includes('qr_code');
    }
    // An older implementation without the format query: it must at least accept `qr_code`.
    new Detector({ formats: ['qr_code'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * @return A detector for QR codes only.
 * @throws {QrScannerUnsupportedError} If the browser has none.
 */
export function createQrDetector(): QrDetector {
  const Detector = detectorConstructor();
  if (!Detector) {
    throw new QrScannerUnsupportedError();
  }
  try {
    return new Detector({ formats: ['qr_code'] });
  } catch {
    throw new QrScannerUnsupportedError();
  }
}

/** Why the camera could not be used, in the terms the screen needs. */
export type CameraFailure = 'denied' | 'no_camera' | 'unsupported' | 'failed';

/** @return What went wrong, from the error a camera or detector call threw. */
export function classifyCameraError(error: unknown): CameraFailure {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
  case 'NotAllowedError':
  case 'SecurityError':
  case 'PermissionDeniedError':
    return 'denied';
  case 'NotFoundError':
  case 'DevicesNotFoundError':
  case 'OverconstrainedError':
    return 'no_camera';
  case 'NotSupportedError':
  case 'QrScannerUnsupportedError':
    return 'unsupported';
  default:
    return 'failed';
  }
}

/** @return A message for the person at the counter; every one ends by pointing at typing the code. */
export function cameraFailureMessage(failure: CameraFailure): string {
  switch (failure) {
  case 'denied':
    return 'Camera access was blocked. Allow the camera for this site in your browser settings, or type the code instead.';
  case 'no_camera':
    return 'No camera was found on this device. Type the code instead.';
  case 'unsupported':
    return "This browser can't read QR codes. Type the code instead.";
  case 'failed':
    return "The camera couldn't be started. Type the code instead.";
  }
}

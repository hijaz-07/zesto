import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import {
  cameraFailureMessage,
  classifyCameraError,
  createQrDetector,
  type CameraFailure,
  type QrDetector,
} from './cameraScanning';

export interface QrScannerProps {
  /** Called once with the first QR code read; the camera has already been released. */
  onScan: (value: string) => void;
  /** Called when staff close the scanner, or after a failure they dismiss. */
  onClose: () => void;
}

type ScannerPhase = { phase: 'starting' } | { phase: 'scanning' } | { phase: 'failed'; failure: CameraFailure };

/** How often a frame is checked for a QR code. */
const SCAN_INTERVAL_MS = 250;

/**
 * A camera preview that reads ONE QR code and reports it — the live camera path
 * of `/org/pickup`. Only rendered where `useQrScannerSupport` said scanning is
 * real, but it still copes with everything that can go wrong at runtime:
 * permission refused, no camera, a camera that will not start, a detector that
 * turns out not to work. Each is shown here, in this panel, with a way to close
 * it — never thrown into the page — so a camera problem can never take typing the
 * code away.
 *
 * The camera is released on EVERY way out: a code was read, the panel was closed,
 * the component unmounted, or starting failed part-way (a stream that arrives
 * after the panel was already closed is stopped at once). What was read is handed
 * to `onScan` and kept nowhere; this component stores and logs nothing.
 */
export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScannerPhase>({ phase: 'starting' });
  // The latest callback, without restarting the camera when the parent re-renders.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const video = videoRef.current;

    function release() {
      clearTimeout(timer);
      timer = undefined;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (video) {
        video.srcObject = null;
      }
    }

    async function scanFrame(detector: QrDetector) {
      if (cancelled) {
        return;
      }
      try {
        // A frame is only readable once the video has data (HAVE_CURRENT_DATA = 2).
        if (video && video.readyState >= 2) {
          const found = await detector.detect(video);
          if (cancelled) {
            return;
          }
          const value = found.map((barcode) => barcode.rawValue).find((raw) => raw);
          if (value) {
            release();
            onScanRef.current(value);
            return;
          }
        }
      } catch {
        // A frame that cannot be read is skipped; the next one is tried.
      }
      timer = setTimeout(() => void scanFrame(detector), SCAN_INTERVAL_MS);
    }

    async function start() {
      try {
        const detector = createQrDetector();
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        if (!video) {
          throw new Error('The camera preview is not available.');
        }
        video.srcObject = media;
        await video.play();
        if (cancelled) {
          return;
        }
        setState({ phase: 'scanning' });
        void scanFrame(detector);
      } catch (error) {
        release();
        if (!cancelled) {
          setState({ phase: 'failed', failure: classifyCameraError(error) });
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      release();
    };
  }, []);

  return (
    <Card className="flex flex-col gap-3" aria-label="QR scanner">
      <div className="aspect-square w-full max-w-sm self-center overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} muted playsInline aria-label="Camera preview" className="h-full w-full object-cover" />
      </div>

      {state.phase === 'starting' && (
        <p role="status" className="text-sm text-muted">
          Starting the camera…
        </p>
      )}
      {state.phase === 'scanning' && (
        <p role="status" className="text-sm text-muted">
          Point the camera at the customer&apos;s QR code.
        </p>
      )}
      {state.phase === 'failed' && (
        <p role="alert" className="text-sm text-danger">
          {cameraFailureMessage(state.failure)}
        </p>
      )}

      <Button variant="secondary" onClick={onClose} className="self-start">
        {state.phase === 'failed' ? 'Close' : 'Cancel scanning'}
      </Button>
    </Card>
  );
}

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QrScanner } from './QrScanner';

const QR = 'ZP1.kQ3vR8nT2xLpA7mZdW1e.AbCdEfGhIjKlMnOpQrStUv';

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

/** A camera stream whose tracks can be checked for having been stopped. */
function fakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function namedError(name: string) {
  return Object.assign(new Error(`camera: ${name}`), { name });
}

/** The detector the scanner builds; `detect` answers from the queue the test fills. */
const detections: Array<Array<{ rawValue: string }> | Error> = [];
const detect = vi.fn(async () => {
  const next = detections.shift() ?? [];
  if (next instanceof Error) {
    throw next;
  }
  return next;
});

class FakeBarcodeDetector {
  detect = detect;
}

let readyState = 4;
const getUserMedia = vi.fn();

function installCamera(stream: MediaStream) {
  getUserMedia.mockResolvedValue(stream);
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('QrScanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    detections.length = 0;
    detect.mockClear();
    getUserMedia.mockReset();
    readyState = 4;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(() => readyState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  describe('scanning', () => {
    it('asks for the rear camera, video only, and tells staff what to do once it is running', async () => {
      installCamera(fakeStream().stream);

      render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('Starting the camera…');
      await pass(0);

      expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      expect(screen.getByRole('status')).toHaveTextContent("Point the camera at the customer's QR code.");
      expect(screen.getByRole('button', { name: 'Cancel scanning' })).toBeInTheDocument();
    });

    it('reports the first QR code it reads, exactly once, and releases the camera', async () => {
      const { stream, tracks } = fakeStream();
      installCamera(stream);
      detections.push([], [{ rawValue: QR }], [{ rawValue: 'second-code' }]);
      const onScan = vi.fn();

      render(<QrScanner onScan={onScan} onClose={vi.fn()} />);
      await pass(1000);

      expect(onScan).toHaveBeenCalledTimes(1);
      expect(onScan).toHaveBeenCalledWith(QR);
      for (const track of tracks) {
        expect(track.stop).toHaveBeenCalledTimes(1);
      }
      const calls = detect.mock.calls.length;
      await pass(5000);
      expect(detect.mock.calls.length).toBe(calls);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps trying through empty frames, empty values and frames that throw', async () => {
      installCamera(fakeStream().stream);
      detections.push([], [{ rawValue: '' }], new Error('InvalidStateError'), [{ rawValue: QR }]);
      const onScan = vi.fn();

      render(<QrScanner onScan={onScan} onClose={vi.fn()} />);
      await pass(2000);

      expect(onScan).toHaveBeenCalledTimes(1);
      expect(onScan).toHaveBeenCalledWith(QR);
    });

    it('does not try to read a frame before the video has data', async () => {
      installCamera(fakeStream().stream);
      readyState = 0;
      detections.push([{ rawValue: QR }]);
      const onScan = vi.fn();

      render(<QrScanner onScan={onScan} onClose={vi.fn()} />);
      await pass(1000);
      expect(detect).not.toHaveBeenCalled();

      readyState = 4;
      await pass(300);
      expect(onScan).toHaveBeenCalledWith(QR);
    });

    it('calls the latest onScan, without restarting the camera when the page re-renders', async () => {
      installCamera(fakeStream().stream);
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = render(<QrScanner onScan={first} onClose={vi.fn()} />);
      await pass(0);

      rerender(<QrScanner onScan={second} onClose={vi.fn()} />);
      detections.push([{ rawValue: QR }]);
      await pass(500);

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(QR);
    });

    it('stores and logs nothing it reads: the value goes to onScan and nowhere else', async () => {
      installCamera(fakeStream().stream);
      detections.push([{ rawValue: QR }]);
      const log = vi.spyOn(console, 'log');
      const warn = vi.spyOn(console, 'warn');
      const error = vi.spyOn(console, 'error');

      const { container } = render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
      await pass(500);

      expect(container.textContent).not.toContain('ZP1');
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('closing', () => {
    it('Cancel scanning calls onClose, and unmounting then releases the camera', async () => {
      const { stream, tracks } = fakeStream();
      installCamera(stream);
      const onClose = vi.fn();
      const { unmount } = render(<QrScanner onScan={vi.fn()} onClose={onClose} />);
      await pass(0);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel scanning' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();

      for (const track of tracks) {
        expect(track.stop).toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops reading frames once unmounted', async () => {
      installCamera(fakeStream().stream);
      const onScan = vi.fn();
      const { unmount } = render(<QrScanner onScan={onScan} onClose={vi.fn()} />);
      await pass(600);
      const calls = detect.mock.calls.length;

      unmount();
      detections.push([{ rawValue: QR }]);
      await pass(5000);

      expect(detect.mock.calls.length).toBe(calls);
      expect(onScan).not.toHaveBeenCalled();
    });

    it('stops a camera stream that arrives after the scanner was already closed', async () => {
      const { stream, tracks } = fakeStream();
      let grant!: (value: MediaStream) => void;
      getUserMedia.mockReturnValue(new Promise<MediaStream>((resolve) => (grant = resolve)));
      const { unmount } = render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);

      unmount();
      await act(async () => grant(stream));

      for (const track of tracks) {
        expect(track.stop).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('when the camera cannot be used', () => {
    it.each([
      ['permission is denied', 'NotAllowedError', 'Camera access was blocked'],
      ['the page is not allowed a camera (security)', 'SecurityError', 'Camera access was blocked'],
      ['there is no camera', 'NotFoundError', 'No camera was found on this device'],
      ['no camera matches', 'OverconstrainedError', 'No camera was found on this device'],
      ['it is already in use', 'NotReadableError', "The camera couldn't be started"],
    ])('shows an alert, with a way to close, when %s — and never calls onScan', async (_label, name, message) => {
      getUserMedia.mockRejectedValue(namedError(name));
      const onScan = vi.fn();
      const onClose = vi.fn();

      render(<QrScanner onScan={onScan} onClose={onClose} />);
      await pass(0);

      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('alert')).toHaveTextContent(/type the code instead/i);
      expect(onScan).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('says the browser cannot read QR codes when there is no detector, without asking for the camera at all', async () => {
      vi.unstubAllGlobals();

      render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
      await pass(0);

      expect(screen.getByRole('alert')).toHaveTextContent("This browser can't read QR codes. Type the code instead.");
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('releases a camera that started but whose preview then failed', async () => {
      const { stream, tracks } = fakeStream();
      installCamera(stream);
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(namedError('NotAllowedError'));

      render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
      await pass(0);

      expect(screen.getByRole('alert')).toHaveTextContent('Camera access was blocked');
      for (const track of tracks) {
        expect(track.stop).toHaveBeenCalled();
      }
    });

    it('does not throw out of the component: the page around it keeps rendering', async () => {
      getUserMedia.mockRejectedValue(namedError('NotAllowedError'));

      const { container } = render(
        <div>
          <p>The rest of the page</p>
          <QrScanner onScan={vi.fn()} onClose={vi.fn()} />
        </div>,
      );
      await pass(0);

      expect(container).toHaveTextContent('The rest of the page');
    });
  });
});

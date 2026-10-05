import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { cn } from '../../lib/cn';

export interface QrCodeProps {
  /** The exact text to encode. Rendered locally; it is never sent anywhere. */
  value: string;
  /** What a screen reader says for the image. Should not repeat `value`. */
  label: string;
  className?: string;
}

/** The empty border a scanner needs around a QR code, in modules (the standard is 4). */
const QUIET_ZONE = 4;

/**
 * Encodes `value` as rows of dark/light modules, or `null` if it cannot be
 * encoded (more data than the largest QR code holds, or an encoder fault).
 * Error correction level M recovers from ~15% damage or glare while keeping the
 * code small enough to read on a phone screen.
 */
function encode(value: string): boolean[][] | null {
  try {
    const code = qrcode(0, 'M');
    code.addData(value, 'Byte');
    code.make();
    const size = code.getModuleCount();
    return Array.from({ length: size }, (_unusedRow, row) =>
      Array.from({ length: size }, (_unusedColumn, column) => code.isDark(row, column)),
    );
  } catch {
    return null;
  }
}

/**
 * A QR code for `value`, drawn as a single SVG path: the markup is built here
 * from the module matrix, never from the encoder's own HTML string, so nothing
 * from `value` is ever interpreted as markup.
 *
 * It is always black on white with a quiet zone, whatever the app's theme —
 * scanners read dark modules on a light ground, and an inverted or tinted code
 * fails — so it stays readable on a dark-mode screen too. The encoding happens
 * in the browser; nothing about `value` leaves it.
 */
export function QrCode({ value, label, className }: QrCodeProps) {
  const modules = useMemo(() => encode(value), [value]);

  if (!modules) {
    return (
      <p role="alert" className="text-sm text-danger">
        The QR code couldn&apos;t be drawn. Use the pickup code instead.
      </p>
    );
  }

  const size = modules.length + QUIET_ZONE * 2;
  const path = modules
    .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z` : '')))
    .join('');

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn('h-auto w-56 max-w-full rounded-lg', className)}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

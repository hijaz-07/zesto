import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QrCode } from './QrCode';

const PAYLOAD = 'ZP1.kQ3vR8nT2xLpA7mZdW1e.AbCdEfGhIjKlMnOpQrStUv';

/** The dark modules the SVG draws, as `x,y` pairs in module coordinates (quiet zone included). */
function darkModules(svg: Element): Set<string> {
  const path = svg.querySelector('path')?.getAttribute('d') ?? '';
  const modules = new Set<string>();
  for (const match of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    modules.add(`${match[1]},${match[2]}`);
  }
  return modules;
}

function viewBoxSize(svg: Element): number {
  return Number((svg.getAttribute('viewBox') ?? '').split(' ')[2]);
}

describe('QrCode', () => {
  it('draws an image with the accessible label it was given — and the label does not leak the value', () => {
    render(<QrCode value={PAYLOAD} label="Pickup QR code" />);

    const image = screen.getByRole('img', { name: 'Pickup QR code' });
    expect(image.tagName.toLowerCase()).toBe('svg');
    expect(image.getAttribute('aria-label')).not.toContain('ZP1');
  });

  it('puts the value nowhere in the page text or markup: only the drawn modules carry it', () => {
    const { container } = render(<QrCode value={PAYLOAD} label="Pickup QR code" />);

    expect(container.textContent).toBe('');
    expect(container.innerHTML).not.toContain(PAYLOAD);
    expect(container.innerHTML).not.toContain('ZP1');
  });

  it('is square, with the four-module quiet zone every scanner expects', () => {
    const { container } = render(<QrCode value={PAYLOAD} label="Pickup QR code" />);
    const svg = container.querySelector('svg') as SVGElement;

    const size = viewBoxSize(svg);
    const modules = darkModules(svg);
    const coordinates = [...modules].map((pair) => pair.split(',').map(Number));
    const dimension = size - 8; // modules per side, from the viewBox
    expect(dimension).toBeGreaterThanOrEqual(21);
    expect((dimension - 21) % 4).toBe(0); // QR sizes are 21, 25, 29, ...
    expect(Math.min(...coordinates.map(([x]) => x))).toBe(4);
    expect(Math.min(...coordinates.map(([, y]) => y))).toBe(4);
    expect(Math.max(...coordinates.map(([x]) => x))).toBe(size - 5);
    expect(Math.max(...coordinates.map(([, y]) => y))).toBe(size - 5);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${size} ${size}`);
  });

  it('has the three finder patterns a real QR code has, at the top-left, top-right and bottom-left', () => {
    const { container } = render(<QrCode value={PAYLOAD} label="Pickup QR code" />);
    const svg = container.querySelector('svg') as SVGElement;
    const modules = darkModules(svg);
    const size = viewBoxSize(svg);
    const last = size - 4 - 7; // the first module of the right/bottom 7-module pattern

    /** A 7x7 finder: solid outer ring, empty ring, solid 3x3 core. */
    const isFinderAt = (originX: number, originY: number) => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const onRing = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          const expected = onRing || inCore;
          if (modules.has(`${originX + dx},${originY + dy}`) !== expected) {
            return false;
          }
        }
      }
      return true;
    };

    expect(isFinderAt(4, 4)).toBe(true);
    expect(isFinderAt(last, 4)).toBe(true);
    expect(isFinderAt(4, last)).toBe(true);
  });

  it('is black on white whatever the theme: a tinted or inverted code would not scan', () => {
    const { container } = render(<QrCode value={PAYLOAD} label="Pickup QR code" />);

    expect(container.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff');
    expect(container.querySelector('path')?.getAttribute('fill')).toBe('#000000');
    expect(container.innerHTML).not.toContain('currentColor');
  });

  it('draws the same code for the same value, and a different one for a different value', () => {
    const a = render(<QrCode value={PAYLOAD} label="a" />).container.innerHTML;
    const b = render(<QrCode value={PAYLOAD} label="a" />).container.innerHTML;
    const c = render(<QrCode value={`${PAYLOAD}x`} label="a" />).container.innerHTML;

    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('never interprets the value as markup', () => {
    const hostile = '</svg><script>window.__pwned = true</script><img src=x onerror=alert(1)>';

    const { container } = render(<QrCode value={hostile} label="Pickup QR code" />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('draws a different, larger code for a longer value, within a single SVG', () => {
    const short = render(<QrCode value="ZP1.a.b" label="short" />).container.querySelector('svg') as SVGElement;
    const long = render(<QrCode value={'ZP1.'.padEnd(150, 'x')} label="long" />).container.querySelector('svg') as SVGElement;

    expect(viewBoxSize(long)).toBeGreaterThan(viewBoxSize(short));
  });

  it('says so, and does not crash, when the value is too long to encode', () => {
    render(<QrCode value={'A'.repeat(6000)} label="Pickup QR code" />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("The QR code couldn't be drawn. Use the pickup code instead.");
  });

  it('accepts a className for sizing without losing its own', () => {
    const { container } = render(<QrCode value={PAYLOAD} label="Pickup QR code" className="w-40" />);

    expect(container.querySelector('svg')?.getAttribute('class')).toContain('w-40');
  });
});

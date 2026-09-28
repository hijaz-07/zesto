import { describe, expect, it } from 'vitest';
import { formatPaiseAsRupees, parseRupeesToPaise } from './currency';

describe('formatPaiseAsRupees', () => {
  it('formats a whole-rupee amount with no decimal places', () => {
    expect(formatPaiseAsRupees(12000)).toBe('₹120');
  });

  it('formats a fractional-rupee amount with 2 decimal places', () => {
    expect(formatPaiseAsRupees(9950)).toBe('₹99.50');
  });

  it('formats zero', () => {
    expect(formatPaiseAsRupees(0)).toBe('₹0');
  });

  it('formats a single-paise amount', () => {
    expect(formatPaiseAsRupees(50)).toBe('₹0.50');
  });
});

describe('parseRupeesToPaise', () => {
  it.each([
    ['120', 12000],
    ['120.00', 12000],
    ['99.50', 9950],
    ['0.50', 50],
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
  ])('parses %s -> %i paise', (input, expected) => {
    expect(parseRupeesToPaise(input)).toBe(expected);
  });

  it('preserves paise as an exact integer, not a rounded float', () => {
    // A classic floating-point trap: parseFloat('0.29') * 100 === 28.999999999999996 in JS.
    expect(parseRupeesToPaise('0.29')).toBe(29);
    expect(Number.isInteger(parseRupeesToPaise('0.29'))).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(parseRupeesToPaise('  120.50  ')).toBe(12050);
  });

  it.each([
    ['-10', 'negative amounts'],
    ['99.999', 'more than 2 decimal places'],
    ['abc', 'non-numeric input'],
    ['', 'empty input'],
    ['12.', 'a trailing decimal point with no digits'],
    ['1e5', 'scientific notation'],
    ['1,200', 'thousands separators'],
    ['+10', 'a leading plus sign'],
  ])('rejects %s (%s)', (input) => {
    expect(parseRupeesToPaise(input)).toBeNull();
  });

  it('rejects an amount too large to represent as a safe integer', () => {
    expect(parseRupeesToPaise('99999999999999999')).toBeNull();
  });
});

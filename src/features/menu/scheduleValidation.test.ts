import { describe, expect, it } from 'vitest';
import { isOrderingBeforePickup, isOrderingWindowValid, isPickupDateValid, isPickupWindowValid } from './scheduleValidation';

describe('isOrderingWindowValid', () => {
  it('is true when ordering opens before it closes', () => {
    expect(isOrderingWindowValid('2026-09-29T08:00:00+05:30', '2026-09-29T10:00:00+05:30')).toBe(true);
  });

  it('is false when ordering opens after it closes', () => {
    expect(isOrderingWindowValid('2026-09-29T10:00:00+05:30', '2026-09-29T08:00:00+05:30')).toBe(false);
  });

  it('is false when ordering opens and closes at the same instant', () => {
    expect(isOrderingWindowValid('2026-09-29T08:00:00+05:30', '2026-09-29T08:00:00+05:30')).toBe(false);
  });
});

describe('isPickupWindowValid', () => {
  it('is true when pickup starts before it ends', () => {
    expect(isPickupWindowValid('2026-09-29T12:00:00+05:30', '2026-09-29T14:00:00+05:30')).toBe(true);
  });

  it('is false when pickup starts after it ends', () => {
    expect(isPickupWindowValid('2026-09-29T14:00:00+05:30', '2026-09-29T12:00:00+05:30')).toBe(false);
  });

  it('is false when pickup starts and ends at the same instant', () => {
    expect(isPickupWindowValid('2026-09-29T12:00:00+05:30', '2026-09-29T12:00:00+05:30')).toBe(false);
  });
});

describe('isOrderingBeforePickup', () => {
  it('is true when ordering closes before pickup starts', () => {
    expect(isOrderingBeforePickup('2026-09-29T10:00:00+05:30', '2026-09-29T12:00:00+05:30')).toBe(true);
  });

  it('is true when ordering closes at the exact instant pickup starts (inclusive)', () => {
    expect(isOrderingBeforePickup('2026-09-29T10:00:00+05:30', '2026-09-29T10:00:00+05:30')).toBe(true);
  });

  it('is false when ordering closes after pickup starts', () => {
    expect(isOrderingBeforePickup('2026-09-29T12:00:00+05:30', '2026-09-29T10:00:00+05:30')).toBe(false);
  });
});

describe('isPickupDateValid', () => {
  it('is true when pickup starts on the menu date', () => {
    expect(isPickupDateValid('2026-09-29T12:00:00+05:30', '2026-09-29')).toBe(true);
  });

  it('is true when pickup starts after the menu date', () => {
    expect(isPickupDateValid('2026-09-30T00:30:00+05:30', '2026-09-29')).toBe(true);
  });

  it('is false when pickup starts before the menu date in Asia/Kolkata', () => {
    expect(isPickupDateValid('2026-09-28T23:00:00+05:30', '2026-09-29')).toBe(false);
  });

  it('compares Asia/Kolkata calendar dates, not raw UTC instants', () => {
    // 2026-09-28T19:00:00Z is 2026-09-29T00:30:00+05:30 — already the menu date in Kolkata.
    expect(isPickupDateValid('2026-09-28T19:00:00Z', '2026-09-29')).toBe(true);
  });
});

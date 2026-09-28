import { afterEach, describe, expect, it } from 'vitest';
import { formatDate, getOrderingState } from './date';

const orderingOpensAt = '2026-09-28T04:00:00+05:30';
const orderingClosesAt = '2026-09-29T10:00:00+05:30';

describe('formatDate', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('formats a plain calendar date', () => {
    expect(formatDate('2026-09-25')).toBe('25 Sept 2026');
  });

  it('does not shift the calendar date for a viewer west of UTC', () => {
    // A date-only string like a menu's `menuDate` parses as UTC midnight; a
    // viewer in a negative-offset zone (e.g. US Eastern) must still see the
    // same calendar date, not the previous day.
    process.env.TZ = 'EST5EDT';
    expect(formatDate('2026-09-25')).toBe('25 Sept 2026');
  });

  it('does not shift the calendar date across a month/year boundary', () => {
    process.env.TZ = 'EST5EDT';
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026');
  });
});

describe('getOrderingState', () => {
  it('is "not_open" before ordering opens', () => {
    const now = new Date('2026-09-28T03:59:59+05:30');
    expect(getOrderingState(orderingOpensAt, orderingClosesAt, now)).toBe('not_open');
  });

  it('is "open" while ordering is in progress', () => {
    const now = new Date('2026-09-28T12:00:00+05:30');
    expect(getOrderingState(orderingOpensAt, orderingClosesAt, now)).toBe('open');
  });

  it('is "closed" after ordering closes', () => {
    const now = new Date('2026-09-29T10:00:01+05:30');
    expect(getOrderingState(orderingOpensAt, orderingClosesAt, now)).toBe('closed');
  });

  it('is "open" at the exact opening instant (opening is inclusive)', () => {
    const now = new Date(orderingOpensAt);
    expect(getOrderingState(orderingOpensAt, orderingClosesAt, now)).toBe('open');
  });

  it('is "closed" at the exact closing instant (closing is inclusive)', () => {
    const now = new Date(orderingClosesAt);
    expect(getOrderingState(orderingOpensAt, orderingClosesAt, now)).toBe('closed');
  });

  it('compares absolute instants, independent of the offset used to express them', () => {
    // "2026-09-28T04:00:00+05:30" and "2026-09-27T22:30:00Z" are the exact
    // same instant; the result must not depend on which offset is used to
    // write either the schedule or `now`.
    const equivalentUtcOpensAt = '2026-09-27T22:30:00Z';
    const equivalentUtcClosesAt = '2026-09-29T04:30:00Z';
    const nowAsUtc = new Date('2026-09-28T06:30:00Z'); // == 2026-09-28T12:00:00+05:30
    const nowAsIst = new Date('2026-09-28T12:00:00+05:30');

    expect(nowAsUtc.getTime()).toBe(nowAsIst.getTime());
    expect(getOrderingState(orderingOpensAt, orderingClosesAt, nowAsUtc)).toBe('open');
    expect(getOrderingState(equivalentUtcOpensAt, equivalentUtcClosesAt, nowAsIst)).toBe('open');
    expect(getOrderingState(orderingOpensAt, orderingClosesAt, nowAsUtc)).toBe(
      getOrderingState(equivalentUtcOpensAt, equivalentUtcClosesAt, nowAsIst),
    );
  });

  it('defaults `now` to the current instant when omitted', () => {
    const farFutureOpensAt = '2099-01-01T00:00:00+05:30';
    const farFutureClosesAt = '2099-01-02T00:00:00+05:30';
    expect(getOrderingState(farFutureOpensAt, farFutureClosesAt)).toBe('not_open');
  });
});

import { describe, expect, it } from 'vitest';
import { getOrderingState } from './date';

const orderingOpensAt = '2026-09-28T04:00:00+05:30';
const orderingClosesAt = '2026-09-29T10:00:00+05:30';

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

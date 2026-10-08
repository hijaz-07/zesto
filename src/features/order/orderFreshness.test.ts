import { describe, expect, it } from 'vitest';
import { cancellableConfirmedOrder, cancelledPaidOrder } from '../../test/cancellationFixtures';
import { confirmedOrder, pendingOrder } from '../../test/paymentFixtures';
import { newestOrder } from './orderFreshness';

describe('newestOrder', () => {
  it('picks the most recently updated copy of the order', () => {
    expect(newestOrder('order-1', pendingOrder, confirmedOrder)).toBe(confirmedOrder);
    expect(newestOrder('order-1', confirmedOrder, pendingOrder)).toBe(confirmedOrder);
  });

  it('a cancellation supersedes an older copy that still looks cancellable', () => {
    const cancelled = cancelledPaidOrder();
    expect(newestOrder('order-1', cancellableConfirmedOrder, cancelled)).toBe(cancelled);
  });

  it("on a tie, the copy carrying the server's cancellation hint wins", () => {
    expect(newestOrder('order-1', confirmedOrder, cancellableConfirmedOrder)).toBe(cancellableConfirmedOrder);
    expect(newestOrder('order-1', cancellableConfirmedOrder, confirmedOrder)).toBe(cancellableConfirmedOrder);
  });

  it('ignores missing copies and copies of a different order', () => {
    expect(newestOrder('order-1', null, undefined, { ...confirmedOrder, id: 'other' }, pendingOrder)).toBe(pendingOrder);
  });

  it('returns null when there is nothing for this order', () => {
    expect(newestOrder('order-1', null, undefined)).toBeNull();
    expect(newestOrder(undefined, pendingOrder)).toBeNull();
  });
});

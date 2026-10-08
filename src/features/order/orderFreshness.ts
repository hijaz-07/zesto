import type { Order } from './types';

/**
 * Of several copies of the same order the page may hold at once (the one it
 * loaded, the one payment verification returned, the one a cancellation
 * returned), the one to show: the most recently updated. On a tie, the copy that
 * carries the server's cancellation hint wins, so a read that has it is never
 * hidden by an equally-recent copy that does not. Copies of a different order,
 * and missing ones, are ignored.
 */
export function newestOrder(orderId: string | undefined, ...copies: Array<Order | null | undefined>): Order | null {
  let best: Order | null = null;
  for (const copy of copies) {
    if (!copy || copy.id !== orderId) {
      continue;
    }
    if (best === null) {
      best = copy;
      continue;
    }
    const a = Date.parse(copy.updatedAt);
    const b = Date.parse(best.updatedAt);
    if (a > b || (a === b && best.cancellation === undefined && copy.cancellation !== undefined)) {
      best = copy;
    }
  }
  return best;
}

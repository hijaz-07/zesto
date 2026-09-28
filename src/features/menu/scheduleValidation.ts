import { businessDateOf } from '../../utils/date';

/**
 * Frontend UX mirrors of the backend's schedule rules
 * (functions/src/domain/menus.ts#findScheduleViolation). Each takes already-
 * combined ISO instants (see `toBusinessTimestamp`) and answers one relational
 * question in isolation, so a form can attach each check to the specific
 * field it concerns instead of a single "first violation" message landing on
 * the wrong field. The backend remains the authority — these exist only to
 * give the organization a clear message before they submit.
 */

/** Whether ordering's opening instant is strictly before its closing instant. */
export function isOrderingWindowValid(orderingOpensAt: string, orderingClosesAt: string): boolean {
  return new Date(orderingOpensAt).getTime() < new Date(orderingClosesAt).getTime();
}

/** Whether pickup's starting instant is strictly before its ending instant. */
export function isPickupWindowValid(pickupStartsAt: string, pickupEndsAt: string): boolean {
  return new Date(pickupStartsAt).getTime() < new Date(pickupEndsAt).getTime();
}

/** Whether ordering closes at or before pickup starts. */
export function isOrderingBeforePickup(orderingClosesAt: string, pickupStartsAt: string): boolean {
  return new Date(orderingClosesAt).getTime() <= new Date(pickupStartsAt).getTime();
}

/** Whether pickup's Asia/Kolkata calendar date is not before the menu's service date. */
export function isPickupDateValid(pickupStartsAt: string, menuDate: string): boolean {
  return businessDateOf(pickupStartsAt) >= menuDate;
}

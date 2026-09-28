import type { ISODateString } from '../../types/common';
import type { OrderingState } from '../../utils/date';

/**
 * Public, unauthenticated customer-discovery types. These mirror the
 * backend's public response shapes (functions/src/domain/explore.ts)
 * exactly — never `createdBy`, `organizationId`, `enabled`, or any other
 * admin/audit field, since these are served to anonymous customers.
 * Deliberately separate from `../../domain/types`' `Outlet`/`Menu`/
 * `MenuItem` (the full organization-management shapes): an Explore type
 * only ever has the reduced customer-safe fields, so reusing the
 * management types here would either widen them or require awkward
 * `Omit<...>` gymnastics for no benefit.
 */

export type ExploreOutletId = string;
export type ExploreMenuId = string;

/** The customer-safe subset of an outlet's address: only `city`/`state`. */
export interface ExploreOutletAddress {
  city?: string;
  state?: string;
}

/** The customer-safe response shape for an outlet, without any menus. */
export interface ExploreOutlet {
  id: ExploreOutletId;
  name: string;
  description?: string;
  address?: ExploreOutletAddress;
}

/**
 * The customer-safe response shape for a menu, without its items.
 * `orderingState` is derived by the backend on every request from the
 * schedule fields below — trust it as-is; see `../../utils/date`'s
 * `getOrderingState` doc comment for why the frontend must not compute a
 * second, possibly-conflicting value from these same fields.
 */
export interface ExploreOutletMenu {
  id: ExploreMenuId;
  menuDate: string;
  title: string;
  description?: string;
  orderingOpensAt: ISODateString;
  orderingClosesAt: ISODateString;
  pickupStartsAt: ISODateString;
  pickupEndsAt: ISODateString;
  orderingState: OrderingState;
}

/** One row of `GET /explore/outlets`: an outlet plus the earliest upcoming menu that made it eligible. */
export interface ExploreOutletSummary {
  id: ExploreOutletId;
  name: string;
  description?: string;
  address?: ExploreOutletAddress;
  nextMenu?: ExploreOutletMenu;
}

/** The customer-safe response shape for a menu item. No `enabled` field: a disabled item is never returned at all. */
export interface ExploreMenuItem {
  id: string;
  name: string;
  description?: string;
  priceInPaise: number;
  displayOrder: number;
}

/** A full menu, as returned by the customer menu-detail endpoint: the menu's own fields plus its enabled items. */
export interface ExploreMenuDetail extends ExploreOutletMenu {
  items: ExploreMenuItem[];
}

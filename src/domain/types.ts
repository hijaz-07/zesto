/**
 * Core domain types for the frontend foundation.
 * These mirror docs/architecture/domain-model.md and are placeholder
 * shapes for development shells — no persistence layer exists yet.
 */

export type MenuItemId = string;

export interface MenuItem {
  id: MenuItemId;
  name: string;
  description?: string;
  priceInPaise: number;
  imageUrl?: string;
  displayOrder: number;
  enabled: boolean;
}

export type MenuState = 'draft' | 'published' | 'ordering_open' | 'ordering_closed';

export interface Menu {
  id: string;
  menuDate: string;
  title: string;
  description?: string;
  state: MenuState;
  orderingOpensAt: string;
  orderingClosesAt: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  items: MenuItem[];
}

export interface DemandLine {
  menuItemId: MenuItemId;
  menuItemName: string;
  totalQuantity: number;
}

export type UserId = string;

/** A person authenticated with Zesto. Identity comes from Descope (`id` is the Descope user ID); this is their Firestore profile. */
export interface User {
  id: UserId;
  displayName?: string;
  phoneNumber?: string;
  email?: string;
  createdAt: string;
}

export type OrganizationId = string;

export interface Organization {
  id: OrganizationId;
  name: string;
  /** Globally unique, immutable for this first implementation. */
  slug: string;
  createdAt: string;
  /** The Descope user ID that created the organization; not necessarily the current owner. */
  createdBy: UserId;
}

/** A member's standing within one organization. Roles are tenant-scoped, never a global claim. */
export type OrganizationMemberRole = 'owner' | 'manager' | 'staff';

export type OrganizationMemberStatus = 'active' | 'invited' | 'revoked';

export interface OrganizationMember {
  userId: UserId;
  organizationId: OrganizationId;
  role: OrganizationMemberRole;
  status: OrganizationMemberStatus;
  createdAt: string;
}

/** One row of `GET /organizations`: an organization plus the caller's role in it. */
export interface OrganizationWithRole extends Organization {
  role: OrganizationMemberRole;
}

export type OutletId = string;

export type OutletStatus = 'active' | 'inactive';

export interface OutletAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface OutletLocation {
  latitude: number;
  longitude: number;
}

/**
 * A physical point of service belonging to an `Organization`. `slug` is
 * unique only within its organization (not globally, unlike an
 * organization's own slug), and immutable for this first implementation.
 */
export interface Outlet {
  id: OutletId;
  organizationId: OrganizationId;
  name: string;
  slug: string;
  description?: string;
  status: OutletStatus;
  phone?: string;
  address?: OutletAddress;
  location?: OutletLocation;
  createdAt: string;
  updatedAt: string;
  /** The Descope user ID that created the outlet. */
  createdBy: UserId;
}

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

/** A person authenticated with Zesto. Identity comes from Firebase Auth; this is their Firestore profile. */
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
  createdAt: string;
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

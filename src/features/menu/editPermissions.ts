import type { OrganizationMemberRole } from '../../domain/types';
import type { OrderingState } from '../../utils/date';
import type { MenuStatus } from './types';

/**
 * Whether `role` may create, edit, enable/disable, delete, publish, or
 * archive menus/items — mirrors the backend's own `MANAGE_ROLES` gate
 * (functions/src/routes/menus.ts and routes/menuItems.ts: `["owner",
 * "manager"]`, checked before the outlet/menu are even looked up). `staff`
 * may still view everything; this only gates mutation UI. A UX guard only —
 * the backend re-checks via `requireOrganizationRole` and rejects
 * independently (403) if a race or a hand-crafted request occurs.
 */
export function canManageMenu(role: OrganizationMemberRole): boolean {
  return role === 'owner' || role === 'manager';
}

export interface MenuEditPermissions {
  canEditSchedule: boolean;
  canEditTitleDescription: boolean;
  canSave: boolean;
}

/**
 * What a menu's current status/ordering-state combination permits editing.
 * Mirrors the backend's own gate (functions/src/domain/menus.ts#updateMenu):
 * an archived menu rejects every PATCH outright, and once ordering has
 * closed a PATCH may still touch title/description but is rejected if it
 * touches any schedule field. Ordering being merely "open" (not yet closed)
 * imposes no extra restriction beyond a draft menu's — the backend only
 * blocks schedule edits once `now >= orderingClosesAt`. This is a UX guard
 * only; the backend re-checks and rejects independently if a race occurs.
 */
export function getMenuEditPermissions(status: MenuStatus, orderingState: OrderingState): MenuEditPermissions {
  if (status === 'archived') {
    return { canEditSchedule: false, canEditTitleDescription: false, canSave: false };
  }
  if (status === 'published' && orderingState === 'closed') {
    return { canEditSchedule: false, canEditTitleDescription: true, canSave: true };
  }
  return { canEditSchedule: true, canEditTitleDescription: true, canSave: true };
}

export interface MenuItemMutationPermissions {
  canAdd: boolean;
  canEdit: boolean;
  canToggleEnabled: boolean;
  canDelete: boolean;
}

/**
 * What a menu's current status/ordering-state/outlet-active/caller-role
 * combination permits for its items right now. Mirrors the backend's own
 * gates (functions/src/domain/menuItems.ts#findItemMutationViolation and
 * #findItemDeletionViolation, composed with routes/menuItems.ts's
 * `requireOutlet({requireActive: true})` and `MANAGE_ROLES` check on every
 * mutating endpoint): a draft menu always allows add/edit/enable-disable/
 * delete regardless of its (meaningless, pre-publish) ordering window; a
 * published menu allows add/edit/enable-disable only until ordering closes,
 * and never allows delete (disable instead, so historical order data is
 * never destroyed); an archived menu never allows any item mutation. Staff
 * (`!canManage`) never gets any mutation control, regardless of menu/outlet
 * state — they may still view items via `useMenuItems()` directly, since
 * reads are ungated by both role and outlet-active on the backend. This is a
 * UX guard only — the backend re-checks and rejects independently if a race
 * occurs.
 */
export function getMenuItemMutationPermissions(
  status: MenuStatus,
  orderingState: OrderingState,
  outletActive: boolean,
  canManage: boolean,
): MenuItemMutationPermissions {
  if (!outletActive || !canManage) {
    return { canAdd: false, canEdit: false, canToggleEnabled: false, canDelete: false };
  }
  const mutationAllowed = status !== 'archived' && !(status === 'published' && orderingState === 'closed');
  return {
    canAdd: mutationAllowed,
    canEdit: mutationAllowed,
    canToggleEnabled: mutationAllowed,
    canDelete: mutationAllowed && status === 'draft',
  };
}

/**
 * Whether the menu can be published right now. Mirrors the backend's own
 * gate (functions/src/domain/menus.ts#publishMenu requires `status ===
 * "draft"`; routes/menus.ts's `handlePostPublish` requires an active
 * outlet). Deliberately does NOT check for an enabled item — that depends on
 * `useMenuItems()`'s independently-loaded state, not menu/outlet state, so
 * callers combine this with their own enabled-item check. A UX guard only;
 * the backend re-validates and rejects independently if a race occurs.
 */
export function canPublishMenu(status: MenuStatus, outletActive: boolean): boolean {
  return status === 'draft' && outletActive;
}

/**
 * Whether the menu can be archived right now. Mirrors the backend's own gate
 * (functions/src/domain/menus.ts#archiveMenu requires `status ===
 * "published"`). Deliberately does NOT depend on outlet-active, matching
 * routes/menus.ts's `handlePostArchive`, which allows archiving a published
 * menu even after its outlet has since gone inactive.
 */
export function canArchiveMenu(status: MenuStatus): boolean {
  return status === 'published';
}

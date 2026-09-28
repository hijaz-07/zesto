import type { OrderingState } from '../../utils/date';
import type { MenuStatus } from './types';

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

import type { BadgeTone } from '../../components/ui/Badge';
import type { OrderingState } from '../../utils/date';
import type { MenuStatus } from './types';

/**
 * Shared badge tone/label maps for a menu's status and ordering state —
 * used by both `MenuCard` (the list view) and the menu detail/editor page,
 * kept in one place so the two views can never drift into showing different
 * labels or colors for the same state.
 */

export const MENU_STATUS_TONE: Record<MenuStatus, BadgeTone> = {
  draft: 'warning',
  published: 'success',
  archived: 'neutral',
};

export const ORDERING_STATE_LABEL: Record<OrderingState, string> = {
  not_open: 'NOT OPEN',
  open: 'OPEN',
  closed: 'CLOSED',
};

export const ORDERING_STATE_TONE: Record<OrderingState, BadgeTone> = {
  not_open: 'neutral',
  open: 'success',
  closed: 'warning',
};

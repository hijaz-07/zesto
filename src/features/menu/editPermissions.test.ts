import { describe, expect, it } from 'vitest';
import {
  canArchiveMenu,
  canManageMenu,
  canPublishMenu,
  getMenuEditPermissions,
  getMenuItemMutationPermissions,
} from './editPermissions';

describe('getMenuEditPermissions', () => {
  it('A. draft: everything editable, saving allowed', () => {
    expect(getMenuEditPermissions('draft', 'not_open')).toEqual({
      canEditSchedule: true,
      canEditTitleDescription: true,
      canSave: true,
    });
  });

  it('B. published + not open: everything editable, saving allowed', () => {
    expect(getMenuEditPermissions('published', 'not_open')).toEqual({
      canEditSchedule: true,
      canEditTitleDescription: true,
      canSave: true,
    });
  });

  it('C. published + open: everything editable, saving allowed', () => {
    expect(getMenuEditPermissions('published', 'open')).toEqual({
      canEditSchedule: true,
      canEditTitleDescription: true,
      canSave: true,
    });
  });

  it('D. published + closed: schedule locked, title/description still editable', () => {
    expect(getMenuEditPermissions('published', 'closed')).toEqual({
      canEditSchedule: false,
      canEditTitleDescription: true,
      canSave: true,
    });
  });

  it('E. archived: everything read-only, no save', () => {
    expect(getMenuEditPermissions('archived', 'closed')).toEqual({
      canEditSchedule: false,
      canEditTitleDescription: false,
      canSave: false,
    });
  });

  it('E. archived is read-only regardless of ordering state', () => {
    expect(getMenuEditPermissions('archived', 'not_open')).toEqual({
      canEditSchedule: false,
      canEditTitleDescription: false,
      canSave: false,
    });
  });
});

describe('getMenuItemMutationPermissions', () => {
  it('draft + active outlet + can manage: add, edit, enable/disable, and delete all allowed', () => {
    expect(getMenuItemMutationPermissions('draft', 'not_open', true, true)).toEqual({
      canAdd: true,
      canEdit: true,
      canToggleEnabled: true,
      canDelete: true,
    });
  });

  it('draft ignores ordering state: still fully mutable when "open"', () => {
    expect(getMenuItemMutationPermissions('draft', 'open', true, true)).toEqual({
      canAdd: true,
      canEdit: true,
      canToggleEnabled: true,
      canDelete: true,
    });
  });

  it('published + not open: mutable but never deletable', () => {
    expect(getMenuItemMutationPermissions('published', 'not_open', true, true)).toEqual({
      canAdd: true,
      canEdit: true,
      canToggleEnabled: true,
      canDelete: false,
    });
  });

  it('published + open: mutable but never deletable', () => {
    expect(getMenuItemMutationPermissions('published', 'open', true, true)).toEqual({
      canAdd: true,
      canEdit: true,
      canToggleEnabled: true,
      canDelete: false,
    });
  });

  it('published + closed: every mutation blocked', () => {
    expect(getMenuItemMutationPermissions('published', 'closed', true, true)).toEqual({
      canAdd: false,
      canEdit: false,
      canToggleEnabled: false,
      canDelete: false,
    });
  });

  it('archived: every mutation blocked regardless of ordering state', () => {
    expect(getMenuItemMutationPermissions('archived', 'not_open', true, true)).toEqual({
      canAdd: false,
      canEdit: false,
      canToggleEnabled: false,
      canDelete: false,
    });
  });

  it('inactive outlet blocks every mutation, even for an otherwise-mutable draft', () => {
    expect(getMenuItemMutationPermissions('draft', 'not_open', false, true)).toEqual({
      canAdd: false,
      canEdit: false,
      canToggleEnabled: false,
      canDelete: false,
    });
  });

  it('staff (cannot manage) blocks every mutation, even for an otherwise-mutable draft at an active outlet', () => {
    expect(getMenuItemMutationPermissions('draft', 'not_open', true, false)).toEqual({
      canAdd: false,
      canEdit: false,
      canToggleEnabled: false,
      canDelete: false,
    });
  });
});

describe('canManageMenu', () => {
  it('allows owner and manager to manage menus/items', () => {
    expect(canManageMenu('owner')).toBe(true);
    expect(canManageMenu('manager')).toBe(true);
  });

  it('blocks staff from managing menus/items', () => {
    expect(canManageMenu('staff')).toBe(false);
  });
});

describe('canPublishMenu', () => {
  it('allows publishing a draft menu at an active outlet', () => {
    expect(canPublishMenu('draft', true)).toBe(true);
  });

  it('blocks publishing when the outlet is inactive', () => {
    expect(canPublishMenu('draft', false)).toBe(false);
  });

  it('blocks publishing a menu that is not a draft', () => {
    expect(canPublishMenu('published', true)).toBe(false);
    expect(canPublishMenu('archived', true)).toBe(false);
  });
});

describe('canArchiveMenu', () => {
  it('allows archiving a published menu', () => {
    expect(canArchiveMenu('published')).toBe(true);
  });

  it('blocks archiving a draft or already-archived menu', () => {
    expect(canArchiveMenu('draft')).toBe(false);
    expect(canArchiveMenu('archived')).toBe(false);
  });
});

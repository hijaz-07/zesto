import { describe, expect, it } from 'vitest';
import { getMenuEditPermissions } from './editPermissions';

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

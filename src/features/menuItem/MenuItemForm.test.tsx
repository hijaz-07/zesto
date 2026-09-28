import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { CreateMenuItemInput, UpdateMenuItemInput } from './api';
import { MenuItemForm } from './MenuItemForm';
import type { MenuItem } from './types';

/**
 * Vitest resolves `@lit/react`'s "node" export condition even under
 * `environment: 'jsdom'`, which leaves `IonSelect` inert in tests
 * project-wide (see `OutletForm.test.tsx`'s identical shim). Stand in a
 * native `<select>` so this file can verify the Availability field's own
 * `Controller` wiring without depending on it.
 */
vi.mock('@ionic/react', () => ({
  IonSelect: ({
    label,
    value,
    onIonChange,
    children,
  }: {
    label?: string;
    value?: string;
    onIonChange?: (event: { detail: { value: string } }) => void;
    children?: ReactNode;
  }) => (
    <label>
      {label}
      <select value={value} onChange={(event) => onIonChange?.({ detail: { value: event.target.value } })}>
        {children}
      </select>
    </label>
  ),
  IonSelectOption: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

function buildItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'item-1',
    menuId: 'menu-1',
    name: 'Chicken Biriyani',
    description: 'Spiced rice with chicken',
    priceInPaise: 12000,
    enabled: true,
    displayOrder: 2,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    createdBy: 'U-1',
    ...overrides,
  };
}

describe('MenuItemForm (create)', () => {
  const onSubmit = vi.fn<(input: CreateMenuItemInput) => Promise<MenuItem>>();
  const onSaved = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onSubmit.mockReset();
    onSaved.mockReset();
    onCancel.mockReset();
  });

  function renderForm(defaultDisplayOrder = 0) {
    return render(
      <MenuItemForm
        mode="create"
        defaultDisplayOrder={defaultDisplayOrder}
        onSubmit={onSubmit}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    );
  }

  it('starts with empty name/description/price, a pre-filled display order, and the Add Item action', () => {
    renderForm(3);

    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Price')).toHaveValue('');
    expect(screen.getByLabelText('Display order')).toHaveValue(3);
    expect(screen.getByRole('button', { name: 'Add Item' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Availability')).not.toBeInTheDocument();
  });

  it('requires a non-blank name', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '120' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    expect(await screen.findByText('Item name is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a description over 500 characters', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chicken Biriyani' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'x'.repeat(501) } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    expect(await screen.findByText('Must be 500 characters or fewer.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'Price is required.'],
    ['-10', 'Enter a valid price, e.g. 120 or 99.50.'],
    ['abc', 'Enter a valid price, e.g. 120 or 99.50.'],
    ['99.999', 'Enter a valid price, e.g. 120 or 99.50.'],
  ])('rejects an invalid price %s', async (price, message) => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chicken Biriyani' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: price } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['-1', 'Display order must be a whole number, 0 or greater.'],
    ['1.5', 'Display order must be a whole number, 0 or greater.'],
  ])('rejects an invalid display order %s', async (displayOrder, message) => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chicken Biriyani' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Display order'), { target: { value: displayOrder } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('converts rupees to exact integer paise on submit, trims text fields, and omits a blank description', async () => {
    onSubmit.mockResolvedValue(buildItem());
    renderForm(1);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Chicken Biriyani  ' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '99.50' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Chicken Biriyani',
        description: undefined,
        priceInPaise: 9950,
        displayOrder: 1,
      }),
    );
  });

  it('calls onSaved with the created item on success', async () => {
    const created = buildItem();
    onSubmit.mockResolvedValue(created);
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chicken Biriyani' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '120' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
  });

  it('shows a backend-safe message and does not call onSaved when create fails', async () => {
    onSubmit.mockRejectedValue(
      new ApiError(400, 'invalid_argument', "Ordering has closed; this menu's items can no longer be changed."),
    );
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chicken Biriyani' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '120' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    expect(await screen.findByText("Ordering has closed; this menu's items can no longer be changed.")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('disables the submit button and shows "Creating…" while saving', async () => {
    let resolveSubmit: (value: MenuItem) => void = () => {};
    onSubmit.mockReturnValue(new Promise<MenuItem>((resolve) => (resolveSubmit = resolve)));
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chicken Biriyani' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '120' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();

    resolveSubmit(buildItem());
  });

  it('calls onCancel when Cancel is clicked', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('MenuItemForm (edit)', () => {
  const onSubmit = vi.fn<(input: UpdateMenuItemInput) => Promise<MenuItem>>();
  const onSaved = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onSubmit.mockReset();
    onSaved.mockReset();
    onCancel.mockReset();
  });

  function renderForm(item: MenuItem) {
    return render(<MenuItemForm mode="edit" item={item} onSubmit={onSubmit} onSaved={onSaved} onCancel={onCancel} />);
  }

  it('populates every field from the existing item, including a plain-rupees price', () => {
    renderForm(buildItem({ priceInPaise: 9950 }));

    expect(screen.getByLabelText('Name')).toHaveValue('Chicken Biriyani');
    expect(screen.getByLabelText('Description')).toHaveValue('Spiced rice with chicken');
    expect(screen.getByLabelText('Price')).toHaveValue('99.50');
    expect(screen.getByLabelText('Display order')).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('formats a whole-rupee price without decimals', () => {
    renderForm(buildItem({ priceInPaise: 12000 }));

    expect(screen.getByLabelText('Price')).toHaveValue('120');
  });

  it('shows the Availability select, defaulting to the item\'s current enabled state', () => {
    renderForm(buildItem({ enabled: false }));

    expect(screen.getByLabelText('Availability')).toHaveValue('disabled');
  });

  it('submits a changed availability', async () => {
    const item = buildItem({ enabled: true });
    const updated = { ...item, enabled: false };
    onSubmit.mockResolvedValue(updated);
    renderForm(item);

    fireEvent.change(screen.getByLabelText('Availability'), { target: { value: 'disabled' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
  });

  it('calls onSaved with the updated item on success, sending the current enabled state', async () => {
    const item = buildItem();
    const updated = { ...item, name: 'Updated name' };
    onSubmit.mockResolvedValue(updated);
    renderForm(item);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Updated name',
        description: 'Spiced rice with chicken',
        priceInPaise: 12000,
        displayOrder: 2,
        enabled: true,
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(updated);
  });

  it('shows a backend-safe message and does not call onSaved when save fails', async () => {
    const item = buildItem();
    onSubmit.mockRejectedValue(new ApiError(404, 'not_found', 'Menu item not found.'));
    renderForm(item);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Menu item not found.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('disables Save/Cancel and shows "Saving…" while saving', async () => {
    const item = buildItem();
    let resolveSubmit: (value: MenuItem) => void = () => {};
    onSubmit.mockReturnValue(new Promise<MenuItem>((resolve) => (resolveSubmit = resolve)));
    renderForm(item);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();

    resolveSubmit(item);
  });
});

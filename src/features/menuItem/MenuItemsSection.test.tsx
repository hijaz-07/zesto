import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { MenuItemMutationPermissions } from '../menu/editPermissions';
import { MenuItemsSection } from './MenuItemsSection';
import type { MenuItem } from './types';
import type { UseMenuItemsResult } from './useMenuItems';

const fullPermissions: MenuItemMutationPermissions = {
  canAdd: true,
  canEdit: true,
  canToggleEnabled: true,
  canDelete: true,
};

const item: MenuItem = {
  id: 'item-1',
  menuId: 'menu-1',
  name: 'Chicken Biriyani',
  priceInPaise: 12000,
  enabled: true,
  displayOrder: 0,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: 'U-1',
};

function buildItemsResult(overrides: Partial<UseMenuItemsResult> = {}): UseMenuItemsResult {
  return {
    status: 'ready',
    items: [],
    error: null,
    retry: vi.fn(),
    createMenuItem: vi.fn(),
    updateMenuItem: vi.fn(),
    deleteMenuItem: vi.fn(),
    ...overrides,
  };
}

describe('MenuItemsSection', () => {
  it('1. shows a loading state while items are being fetched', () => {
    render(<MenuItemsSection itemsResult={buildItemsResult({ status: 'loading' })} permissions={fullPermissions} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('4. shows an error state with a working retry when items fail to load', () => {
    const retry = vi.fn();
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    render(
      <MenuItemsSection itemsResult={buildItemsResult({ status: 'error', error, retry })} permissions={fullPermissions} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('2. shows an empty state with an Add Item action when permitted', () => {
    render(<MenuItemsSection itemsResult={buildItemsResult()} permissions={fullPermissions} />);

    expect(screen.getByText('No menu items yet.')).toBeInTheDocument();
    expect(screen.getByText('Add the first item to this menu.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add Item' }).length).toBeGreaterThan(0);
  });

  it('offers no Add Item action anywhere when mutation is not permitted', () => {
    render(
      <MenuItemsSection
        itemsResult={buildItemsResult()}
        permissions={{ canAdd: false, canEdit: false, canToggleEnabled: false, canDelete: false }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Add Item' })).not.toBeInTheDocument();
  });

  it('2b. renders a card per item, in the order useMenuItems() returned them, without re-sorting', () => {
    const items = [
      { ...item, id: 'item-2', name: 'Veg Meals', displayOrder: 5 },
      { ...item, id: 'item-1', name: 'Chicken Biriyani', displayOrder: 0 },
    ];
    render(<MenuItemsSection itemsResult={buildItemsResult({ items })} permissions={fullPermissions} />);

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Veg Meals', 'Chicken Biriyani']);
  });

  it('6. creating an item calls createMenuItem with the next display order, then returns to the list', async () => {
    const createMenuItem = vi.fn().mockResolvedValue({ ...item, id: 'item-2', name: 'Veg Meals', displayOrder: 1 });
    render(
      <MenuItemsSection
        itemsResult={buildItemsResult({ items: [item], createMenuItem })}
        permissions={fullPermissions}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Add Item' })[0]);
    expect(screen.getByLabelText('Display order')).toHaveValue(1);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Veg Meals' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    await waitFor(() => expect(createMenuItem).toHaveBeenCalledWith({
      name: 'Veg Meals',
      description: undefined,
      priceInPaise: 8000,
      displayOrder: 1,
    }));
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
  });

  it('7. editing an item pre-fills the form and calls updateMenuItem for that item, then returns to the list', async () => {
    const updateMenuItem = vi.fn().mockResolvedValue({ ...item, name: 'Updated name' });
    render(
      <MenuItemsSection itemsResult={buildItemsResult({ items: [item], updateMenuItem })} permissions={fullPermissions} />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Edit ${item.name}` }));
    expect(screen.getByLabelText('Name')).toHaveValue('Chicken Biriyani');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateMenuItem).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({ name: 'Updated name' }),
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
  });

  it('cancelling create or edit returns to the list without calling the mutation', () => {
    const createMenuItem = vi.fn();
    render(
      <MenuItemsSection itemsResult={buildItemsResult({ items: [item], createMenuItem })} permissions={fullPermissions} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Add Item' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Chicken Biriyani' })).toBeInTheDocument();
    expect(createMenuItem).not.toHaveBeenCalled();
  });

  it('10. toggling enabled calls updateMenuItem with the flipped enabled value', async () => {
    const updateMenuItem = vi.fn().mockResolvedValue({ ...item, enabled: false });
    render(
      <MenuItemsSection itemsResult={buildItemsResult({ items: [item], updateMenuItem })} permissions={fullPermissions} />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Disable ${item.name}` }));

    await waitFor(() => expect(updateMenuItem).toHaveBeenCalledWith('item-1', { enabled: false }));
  });

  it('11. deleting (after confirmation) calls deleteMenuItem for that item', async () => {
    const deleteMenuItem = vi.fn().mockResolvedValue(undefined);
    render(
      <MenuItemsSection itemsResult={buildItemsResult({ items: [item], deleteMenuItem })} permissions={fullPermissions} />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Delete ${item.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMenuItem).toHaveBeenCalledWith('item-1'));
  });
});

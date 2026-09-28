import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { MenuItemMutationPermissions } from '../menu/editPermissions';
import { MenuItemCard } from './MenuItemCard';
import type { MenuItem } from './types';

const fullPermissions: MenuItemMutationPermissions = {
  canAdd: true,
  canEdit: true,
  canToggleEnabled: true,
  canDelete: true,
};

const noPermissions: MenuItemMutationPermissions = {
  canAdd: false,
  canEdit: false,
  canToggleEnabled: false,
  canDelete: false,
};

const item: MenuItem = {
  id: 'item-1',
  menuId: 'menu-1',
  name: 'Chicken Biriyani',
  description: 'Spiced rice with chicken',
  priceInPaise: 9950,
  enabled: true,
  displayOrder: 2,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: 'U-1',
};

describe('MenuItemCard', () => {
  it('shows the name, description, formatted price, display order, and an ACTIVE badge when enabled', () => {
    render(
      <MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByText('Spiced rice with chicken')).toBeInTheDocument();
    expect(screen.getByText('₹99.50')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('shows a DISABLED badge for a disabled item, and still renders it (never hidden)', () => {
    render(
      <MenuItemCard
        item={{ ...item, enabled: false }}
        permissions={fullPermissions}
        onEdit={vi.fn()}
        onToggleEnabled={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('DISABLED')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Chicken Biriyani' })).toBeInTheDocument();
  });

  it('never renders technical fields like id, menuId, or createdBy', () => {
    render(
      <MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.queryByText('item-1')).not.toBeInTheDocument();
    expect(screen.queryByText('menu-1')).not.toBeInTheDocument();
    expect(screen.queryByText('U-1')).not.toBeInTheDocument();
  });

  it('18. hides every mutation control when permissions deny them all', () => {
    render(
      <MenuItemCard item={item} permissions={noPermissions} onEdit={vi.fn()} onToggleEnabled={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('12. hides Delete when the parent menu is not a draft, but keeps Edit and Enable/Disable', () => {
    render(
      <MenuItemCard
        item={item}
        permissions={{ ...fullPermissions, canDelete: false }}
        onEdit={vi.fn()}
        onToggleEnabled={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: `Edit ${item.name}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Disable ${item.name}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Delete ${item.name}` })).not.toBeInTheDocument();
  });

  it('calls onEdit when Edit is clicked', () => {
    const onEdit = vi.fn();
    render(<MenuItemCard item={item} permissions={fullPermissions} onEdit={onEdit} onToggleEnabled={vi.fn()} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: `Edit ${item.name}` }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('9. offers Disable for an enabled item and calls onToggleEnabled', async () => {
    const onToggleEnabled = vi.fn().mockResolvedValue(undefined);
    render(
      <MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={onToggleEnabled} onDelete={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Disable ${item.name}` }));

    await waitFor(() => expect(onToggleEnabled).toHaveBeenCalledTimes(1));
  });

  it('9b. offers Enable for a disabled item', () => {
    render(
      <MenuItemCard
        item={{ ...item, enabled: false }}
        permissions={fullPermissions}
        onEdit={vi.fn()}
        onToggleEnabled={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: `Enable ${item.name}` })).toBeInTheDocument();
  });

  it('shows a safe error and keeps the item visible when enable/disable is rejected', async () => {
    const onToggleEnabled = vi.fn().mockRejectedValue(new ApiError(503, 'unavailable', 'Backend down.'));
    render(
      <MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={onToggleEnabled} onDelete={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Disable ${item.name}` }));

    expect(await screen.findByText('Zesto is temporarily unavailable. Please try again in a moment.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Chicken Biriyani' })).toBeInTheDocument();
  });

  it('8. requires confirmation before deleting, with the item name in the prompt', () => {
    render(
      <MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={vi.fn()} onDelete={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Delete ${item.name}` }));

    expect(screen.getByText('Delete “Chicken Biriyani”?')).toBeInTheDocument();
    expect(screen.getByText('This item has not been published yet.')).toBeInTheDocument();
  });

  it('cancelling the delete confirmation leaves the item untouched', () => {
    const onDelete = vi.fn();
    render(<MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${item.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete “Chicken Biriyani”?')).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('confirming delete calls onDelete', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${item.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('13. shows a safe error and keeps the item visible when delete is rejected on a published menu', async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'invalid_argument', 'Only items on a draft menu can be deleted; disable the item instead.'));
    render(<MenuItemCard item={item} permissions={fullPermissions} onEdit={vi.fn()} onToggleEnabled={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${item.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText('Only items on a draft menu can be deleted; disable the item instead.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Chicken Biriyani' })).toBeInTheDocument();
  });
});

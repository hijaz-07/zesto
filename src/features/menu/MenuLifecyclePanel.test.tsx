import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { MenuLifecyclePanel } from './MenuLifecyclePanel';
import type { Menu } from './types';

function buildMenu(overrides: Partial<Menu> = {}): Menu {
  return {
    id: 'menu-1',
    organizationId: 'org-1',
    outletId: 'outlet-1',
    menuDate: '2026-09-29',
    title: 'Tuesday Special',
    status: 'draft',
    orderingOpensAt: '2026-09-29T08:00:00+05:30',
    orderingClosesAt: '2026-09-29T10:00:00+05:30',
    pickupStartsAt: '2026-09-29T12:00:00+05:30',
    pickupEndsAt: '2026-09-29T14:00:00+05:30',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'U-1',
    ...overrides,
  };
}

describe('MenuLifecyclePanel (draft: publish)', () => {
  it('19. disables Publish Menu and shows guidance when there is no enabled item', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={0}
        enabledItemCount={0}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeDisabled();
    expect(screen.getByText('Add at least one enabled menu item before publishing.')).toBeInTheDocument();
    expect(screen.getByText('At least 1 enabled item required')).toBeInTheDocument();
  });

  it('20. disables Publish Menu when items exist but all are disabled', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={3}
        enabledItemCount={0}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeDisabled();
  });

  it('21. enables Publish Menu when one item is enabled', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeEnabled();
    expect(screen.getByText('1 menu item')).toBeInTheDocument();
    expect(screen.getByText('At least 1 enabled item')).toBeInTheDocument();
  });

  it('22. enables Publish Menu with a mix of enabled and disabled items', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={3}
        enabledItemCount={2}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeEnabled();
    expect(screen.getByText('3 menu items')).toBeInTheDocument();
  });

  it('disables Publish Menu while the outlet is inactive, even with an enabled item', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive={false}
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeDisabled();
  });

  it('disables Publish Menu while items are still loading', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={0}
        enabledItemCount={0}
        itemsReady={false}
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeDisabled();
  });

  it('23. clicking Publish Menu shows a confirmation with title, date, item counts, and the ordering/pickup windows', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={3}
        enabledItemCount={2}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));

    expect(screen.getByText('Publish this menu?')).toBeInTheDocument();
    expect(screen.getByText('Tuesday Special')).toBeInTheDocument();
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
    expect(screen.getByText('3 total')).toBeInTheDocument();
    expect(
      screen.getByText('After publishing, the menu will be visible to customers according to its ordering schedule.'),
    ).toBeInTheDocument();
  });

  it('24. cancelling the confirmation leaves the menu a draft without calling onPublish', () => {
    const onPublish = vi.fn();
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={onPublish}
        onArchive={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Publish this menu?')).not.toBeInTheDocument();
    expect(screen.getByText('Publish checklist')).toBeInTheDocument();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('25. confirming calls onPublish, showing Publishing… meanwhile', async () => {
    let resolvePublish: (value: Menu) => void = () => {};
    const onPublish = vi.fn().mockReturnValue(new Promise<Menu>((resolve) => (resolvePublish = resolve)));
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={onPublish}
        onArchive={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));

    expect(await screen.findByRole('button', { name: 'Publishing…' })).toBeDisabled();
    expect(onPublish).toHaveBeenCalledTimes(1);

    resolvePublish(buildMenu({ status: 'published' }));
  });

  it('26+27. shows a backend-safe error and stays a draft when publish is rejected', async () => {
    const onPublish = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'invalid_argument', 'A menu must have at least one enabled item before it can be published.'));
    render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={onPublish}
        onArchive={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));

    expect(
      await screen.findByText('A menu must have at least one enabled item before it can be published.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Publish this menu?')).toBeInTheDocument();
  });

  it('staff (cannot manage) sees no Publish Menu button and no checklist, even with an enabled item', () => {
    const { container } = render(
      <MenuLifecyclePanel
        menu={buildMenu()}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage={false}
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Publish checklist')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MenuLifecyclePanel (published: archive)', () => {
  it('30. offers Archive Menu for a published menu', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'published' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Archive Menu' })).toBeInTheDocument();
  });

  it('archive remains available even when the outlet is inactive', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'published' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive={false}
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Archive Menu' })).toBeEnabled();
  });

  it('31. clicking Archive Menu shows a confirmation', () => {
    render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'published' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));

    expect(screen.getByText('Archive this menu?')).toBeInTheDocument();
    expect(screen.getByText('This menu will become read-only.')).toBeInTheDocument();
    expect(screen.getByText('Its historical information will remain available.')).toBeInTheDocument();
  });

  it('32. cancelling the confirmation leaves the menu published without calling onArchive', () => {
    const onArchive = vi.fn();
    render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'published' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={onArchive}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Archive this menu?')).not.toBeInTheDocument();
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('33. confirming calls onArchive, showing Archiving… meanwhile', async () => {
    let resolveArchive: (value: Menu) => void = () => {};
    const onArchive = vi.fn().mockReturnValue(new Promise<Menu>((resolve) => (resolveArchive = resolve)));
    render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'published' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={onArchive}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));

    expect(await screen.findByRole('button', { name: 'Archiving…' })).toBeDisabled();
    expect(onArchive).toHaveBeenCalledTimes(1);

    resolveArchive(buildMenu({ status: 'archived' }));
  });

  it('shows a backend-safe error and stays published when archive is rejected', async () => {
    const onArchive = vi.fn().mockRejectedValue(new ApiError(400, 'invalid_argument', 'Only a published menu can be archived.'));
    render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'published' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={onArchive}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));

    expect(await screen.findByText('Only a published menu can be archived.')).toBeInTheDocument();
  });

  it('staff (cannot manage) sees no Archive Menu button for a published menu', () => {
    const { container } = render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'published' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage={false}
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MenuLifecyclePanel (archived)', () => {
  it('34. renders nothing — no publish, no archive, fully read-only', () => {
    const { container } = render(
      <MenuLifecyclePanel
        menu={buildMenu({ status: 'archived' })}
        itemCount={1}
        enabledItemCount={1}
        itemsReady
        outletActive
        canManage
        onPublish={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

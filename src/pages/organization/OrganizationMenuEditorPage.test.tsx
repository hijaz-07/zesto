import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outlet, OrganizationMemberRole } from '../../domain/types';
import type { Menu } from '../../features/menu/types';
import { useMenu } from '../../features/menu/useMenu';
import type { MenuItem } from '../../features/menuItem/types';
import { useMenuItems } from '../../features/menuItem/useMenuItems';
import { useOutlets } from '../../features/outlet/useOutlets';
import { ApiError } from '../../lib/api/client';
import { OrganizationMenuEditorPage } from './OrganizationMenuEditorPage';

vi.mock('../../features/menu/useMenu');
vi.mock('../../features/menuItem/useMenuItems');
vi.mock('../../features/outlet/useOutlets');

const mockedUseMenu = vi.mocked(useMenu);
const mockedUseMenuItems = vi.mocked(useMenuItems);
const mockedUseOutlets = vi.mocked(useOutlets);

const NOW = '2026-09-28T12:00:00+05:30';

function buildMenu(overrides: Partial<Menu> = {}): Menu {
  return {
    id: 'menu-1',
    organizationId: 'org-1',
    outletId: 'outlet-1',
    menuDate: '2026-09-29',
    title: 'Tuesday Special',
    description: "Chef's picks",
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

const activeOutlet: Outlet = {
  id: 'outlet-1',
  organizationId: 'org-1',
  name: 'Main Canteen',
  slug: 'main-canteen',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'U-1',
};

const inactiveOutlet: Outlet = { ...activeOutlet, status: 'inactive' };

function buildItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'item-1',
    menuId: 'menu-1',
    name: 'Chicken Biriyani',
    priceInPaise: 12000,
    enabled: true,
    displayOrder: 0,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    createdBy: 'U-1',
    ...overrides,
  };
}

function mockMenu(overrides: Partial<ReturnType<typeof useMenu>>) {
  mockedUseMenu.mockReturnValue({
    status: 'ready',
    menu: null,
    error: null,
    retry: vi.fn(),
    updateMenu: vi.fn(),
    publishMenu: vi.fn(),
    archiveMenu: vi.fn(),
    ...overrides,
  });
}

function mockItems(overrides: Partial<ReturnType<typeof useMenuItems>>) {
  mockedUseMenuItems.mockReturnValue({
    status: 'ready',
    items: [],
    error: null,
    retry: vi.fn(),
    createMenuItem: vi.fn(),
    updateMenuItem: vi.fn(),
    deleteMenuItem: vi.fn(),
    ...overrides,
  });
}

function mockOutlets(overrides: Partial<ReturnType<typeof useOutlets>>) {
  mockedUseOutlets.mockReturnValue({
    status: 'ready',
    outlets: [activeOutlet],
    error: null,
    retry: vi.fn(),
    createOutlet: vi.fn(),
    updateOutlet: vi.fn(),
    ...overrides,
  });
}

function renderPage(outletId = 'outlet-1', menuId = 'menu-1', role: OrganizationMemberRole = 'owner') {
  return render(
    <MemoryRouter initialEntries={[`/org/menus/${outletId}/${menuId}`]}>
      <Routes>
        <Route path="/org/menus" element={<div>Outlet picker page</div>} />
        <Route path="/org/menus/:outletId" element={<div>Menu list page</div>} />
        <Route
          path="/org/menus/:outletId/:menuId"
          element={<OrganizationMenuEditorPage organizationId="org-1" role={role} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrganizationMenuEditorPage', () => {
  beforeEach(() => {
    mockedUseMenu.mockReset();
    mockedUseMenuItems.mockReset();
    mockedUseOutlets.mockReset();
    mockItems({});
    mockOutlets({});
    // Date-only mock (no vi.useFakeTimers()): some tests below `await`, which
    // relies on real timers for RTL's own polling.
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('17. shows a loading state while the menu is being fetched', () => {
    mockMenu({ status: 'loading', menu: null });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows a loading state while the outlet is being fetched', () => {
    mockMenu({ status: 'ready', menu: buildMenu() });
    mockOutlets({ status: 'loading', outlets: [] });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('18. shows a not-found state for a menu that does not exist', () => {
    mockMenu({ status: 'error', error: new ApiError(404, 'not_found', 'Menu not found.') });

    renderPage();

    expect(screen.getByText('Menu not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows an error state with a working retry for a non-404 failure', () => {
    const retry = vi.fn();
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    mockMenu({ status: 'error', error, retry });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("shows an outlet-not-found state when the menu's outlet is not one of the organization's outlets", () => {
    mockMenu({ status: 'ready', menu: buildMenu() });
    mockOutlets({ status: 'ready', outlets: [] });

    renderPage();

    expect(screen.getByText('Outlet not found')).toBeInTheDocument();
  });

  it('renders the menu details: date, ordering window, pickup window, and description', () => {
    mockMenu({ status: 'ready', menu: buildMenu() });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Tuesday Special' })).toBeInTheDocument();
    expect(screen.getByText("Chef's picks")).toBeInTheDocument();
  });

  it('28a. draft + not open', () => {
    mockMenu({
      status: 'ready',
      menu: buildMenu({ status: 'draft', orderingOpensAt: '2026-09-30T08:00:00+05:30', orderingClosesAt: '2026-09-30T10:00:00+05:30' }),
    });
    renderPage();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('NOT OPEN')).toBeInTheDocument();
  });

  it('28b. published + not open', () => {
    mockMenu({
      status: 'ready',
      menu: buildMenu({ status: 'published', orderingOpensAt: '2026-09-30T08:00:00+05:30', orderingClosesAt: '2026-09-30T10:00:00+05:30' }),
    });
    renderPage();
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('NOT OPEN')).toBeInTheDocument();
  });

  it('28c. published + open', () => {
    mockMenu({
      status: 'ready',
      menu: buildMenu({ status: 'published', orderingOpensAt: '2026-09-28T08:00:00+05:30', orderingClosesAt: '2026-09-28T18:00:00+05:30' }),
    });
    renderPage();
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('28d. published + closed', () => {
    mockMenu({
      status: 'ready',
      menu: buildMenu({ status: 'published', orderingOpensAt: '2026-09-28T04:00:00+05:30', orderingClosesAt: '2026-09-28T10:00:00+05:30' }),
    });
    renderPage();
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('28e. archived + closed', () => {
    mockMenu({
      status: 'ready',
      menu: buildMenu({ status: 'archived', orderingOpensAt: '2026-09-27T04:00:00+05:30', orderingClosesAt: '2026-09-27T10:00:00+05:30' }),
    });
    renderPage();
    expect(screen.getByText('ARCHIVED')).toBeInTheDocument();
    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('offers Edit Menu for a draft, opening the form on click', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Menu' }));

    expect(screen.getByLabelText('Title')).toHaveValue('Tuesday Special');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('offers no Edit Menu action for an archived menu', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'archived' }) });

    renderPage();

    expect(screen.queryByRole('button', { name: 'Edit Menu' })).not.toBeInTheDocument();
  });

  it('27. returns to the read-only view after a successful save', async () => {
    const menu = buildMenu({ status: 'draft' });
    const updateMenu = vi.fn().mockResolvedValue({ ...menu, title: 'Updated title' });
    mockMenu({ status: 'ready', menu, updateMenu });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Menu' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Menu' })).toBeInTheDocument());
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(updateMenu).toHaveBeenCalled();
  });

  it('cancelling the edit form returns to the read-only view without saving', () => {
    const menu = buildMenu({ status: 'draft' });
    const updateMenu = vi.fn();
    mockMenu({ status: 'ready', menu, updateMenu });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Edit Menu' })).toBeInTheDocument();
    expect(updateMenu).not.toHaveBeenCalled();
  });

  it('navigates back to the outlet\'s menu list', () => {
    mockMenu({ status: 'ready', menu: buildMenu() });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Menus' }));

    expect(screen.getByText('Menu list page')).toBeInTheDocument();
  });

  it('35. shows the real Menu Items section, with an empty state when there are no items', () => {
    mockMenu({ status: 'ready', menu: buildMenu() });

    renderPage();

    expect(screen.getByText('Menu Items')).toBeInTheDocument();
    expect(screen.getByText('No menu items yet.')).toBeInTheDocument();
    expect(screen.queryByText('Menu item management will be added in the next step.')).not.toBeInTheDocument();
  });

  it('renders a card per menu item, in the order useMenuItems() returned them', () => {
    mockMenu({ status: 'ready', menu: buildMenu() });
    mockItems({ status: 'ready', items: [buildItem({ id: 'item-2', name: 'Veg Meals', displayOrder: 1 }), buildItem({ id: 'item-1', name: 'Chicken Biriyani', displayOrder: 0 })] });

    renderPage();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Veg Meals', 'Chicken Biriyani']);
  });

  it('36. disables Publish Menu and explains why when there is no enabled item', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockItems({ status: 'ready', items: [] });

    renderPage();

    const publishButton = screen.getByRole('button', { name: 'Publish Menu' });
    expect(publishButton).toBeDisabled();
    expect(screen.getByText('Add at least one enabled menu item before publishing.')).toBeInTheDocument();
  });

  it('enables Publish Menu once at least one enabled item exists', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockItems({ status: 'ready', items: [buildItem()] });

    renderPage();

    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeEnabled();
  });

  it('publishing requires confirmation, then calls publishMenu()', async () => {
    const menu = buildMenu({ status: 'draft' });
    const publishMenu = vi.fn().mockResolvedValue({ ...menu, status: 'published' });
    mockMenu({ status: 'ready', menu, publishMenu });
    mockItems({ status: 'ready', items: [buildItem()] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));
    expect(screen.getByText('Publish this menu?')).toBeInTheDocument();
    expect(publishMenu).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Publish Menu' }));

    await waitFor(() => expect(publishMenu).toHaveBeenCalledTimes(1));
  });

  it('hides the Publish placeholder once the menu is no longer a draft', () => {
    mockMenu({
      status: 'ready',
      menu: buildMenu({ status: 'published', orderingOpensAt: '2026-09-30T08:00:00+05:30', orderingClosesAt: '2026-09-30T10:00:00+05:30' }),
    });

    renderPage();

    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
  });

  it('offers Archive Menu for a published menu, requiring confirmation before archiving', async () => {
    const menu = buildMenu({ status: 'published' });
    const archiveMenu = vi.fn().mockResolvedValue({ ...menu, status: 'archived' });
    mockMenu({ status: 'ready', menu, archiveMenu });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));
    expect(screen.getByText('Archive this menu?')).toBeInTheDocument();
    expect(archiveMenu).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Menu' }));

    await waitFor(() => expect(archiveMenu).toHaveBeenCalledTimes(1));
  });

  it('offers no Publish or Archive action for an archived menu', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'archived' }) });

    renderPage();

    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();
  });

  it('17b. shows a clear notice and blocks item mutation when the outlet is inactive', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockOutlets({ status: 'ready', outlets: [inactiveOutlet] });

    renderPage();

    expect(screen.getByText('This outlet is inactive. Menu changes are unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Item' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeDisabled();
  });

  it('hides Edit Menu when the outlet is inactive, for an otherwise-editable draft menu', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockOutlets({ status: 'ready', outlets: [inactiveOutlet] });

    renderPage();

    expect(screen.queryByRole('button', { name: 'Edit Menu' })).not.toBeInTheDocument();
  });

  it('inactive outlet still displays read-only menu details and menu items', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockOutlets({ status: 'ready', outlets: [inactiveOutlet] });
    mockItems({ status: 'ready', items: [buildItem()] });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Tuesday Special' })).toBeInTheDocument();
    expect(screen.getByText("Chef's picks")).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Chicken Biriyani' })).toBeInTheDocument();
  });

  it('published + inactive outlet still offers Archive Menu, matching existing backend behavior', () => {
    const menu = buildMenu({ status: 'published' });
    mockMenu({ status: 'ready', menu });
    mockOutlets({ status: 'ready', outlets: [inactiveOutlet] });

    renderPage();

    expect(screen.getByText('This outlet is inactive. Menu changes are unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive Menu' })).toBeEnabled();
  });

  it('owner sees every management control: Edit Menu, Add Item, item Edit/Enable/Delete, and Publish Menu', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockItems({ status: 'ready', items: [buildItem()] });

    renderPage('outlet-1', 'menu-1', 'owner');

    expect(screen.getByRole('button', { name: 'Edit Menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeInTheDocument();
  });

  it('manager sees every management control: Edit Menu, Add Item, item Edit/Enable/Delete, and Publish Menu', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockItems({ status: 'ready', items: [buildItem()] });

    renderPage('outlet-1', 'menu-1', 'manager');

    expect(screen.getByRole('button', { name: 'Edit Menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish Menu' })).toBeInTheDocument();
  });

  it('staff sees no management control anywhere on the page, while menu and item data (including disabled items) remain visible', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });
    mockItems({
      status: 'ready',
      items: [
        buildItem({ id: 'item-1', name: 'Chicken Biriyani', enabled: true }),
        buildItem({ id: 'item-2', name: 'Veg Meals', enabled: false }),
      ],
    });

    renderPage('outlet-1', 'menu-1', 'staff');

    // Reads remain available.
    expect(screen.getByRole('heading', { level: 1, name: 'Tuesday Special' })).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('NOT OPEN')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Chicken Biriyani' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Veg Meals' })).toBeInTheDocument();
    expect(screen.getByText('DISABLED')).toBeInTheDocument();

    // No mutation control is rendered anywhere.
    expect(screen.queryByRole('button', { name: 'Edit Menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit (Chicken Biriyani|Veg Meals)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /(Enable|Disable) (Chicken Biriyani|Veg Meals)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete (Chicken Biriyani|Veg Meals)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Publish checklist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();
  });

  it('staff sees no Archive Menu action on a published menu either', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'published' }) });

    renderPage('outlet-1', 'menu-1', 'staff');

    expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();
  });
});

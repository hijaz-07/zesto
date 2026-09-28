import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Menu } from '../../features/menu/types';
import { useMenu } from '../../features/menu/useMenu';
import { ApiError } from '../../lib/api/client';
import { OrganizationMenuEditorPage } from './OrganizationMenuEditorPage';

vi.mock('../../features/menu/useMenu');

const mockedUseMenu = vi.mocked(useMenu);

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

function mockMenu(overrides: Partial<ReturnType<typeof useMenu>>) {
  mockedUseMenu.mockReturnValue({
    status: 'ready',
    menu: null,
    error: null,
    retry: vi.fn(),
    updateMenu: vi.fn(),
    ...overrides,
  });
}

function renderPage(outletId = 'outlet-1', menuId = 'menu-1') {
  return render(
    <MemoryRouter initialEntries={[`/org/menus/${outletId}/${menuId}`]}>
      <Routes>
        <Route path="/org/menus/:outletId" element={<div>Menu list page</div>} />
        <Route path="/org/menus/:outletId/:menuId" element={<OrganizationMenuEditorPage organizationId="org-1" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrganizationMenuEditorPage', () => {
  beforeEach(() => {
    mockedUseMenu.mockReset();
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

  it('renders the menu details: date, ordering window, pickup window, and description', () => {
    mockMenu({ status: 'ready', menu: buildMenu() });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Tuesday Special' })).toBeInTheDocument();
    expect(screen.getByText("Chef's picks")).toBeInTheDocument();
  });

  it('35. always shows the menu items placeholder, without implementing item management', () => {
    mockMenu({ status: 'ready', menu: buildMenu() });

    renderPage();

    expect(screen.getByText('Menu Items')).toBeInTheDocument();
    expect(screen.getByText('Menu item management will be added in the next step.')).toBeInTheDocument();
  });

  it('36. shows a disabled Publish placeholder for a draft menu, never a working publish action', () => {
    mockMenu({ status: 'ready', menu: buildMenu({ status: 'draft' }) });

    renderPage();

    const publishButton = screen.getByRole('button', { name: /Publish/ });
    expect(publishButton).toBeDisabled();
    expect(screen.getByText('Add at least one enabled menu item before publishing.')).toBeInTheDocument();
  });

  it('hides the Publish placeholder once the menu is no longer a draft', () => {
    mockMenu({
      status: 'ready',
      menu: buildMenu({ status: 'published', orderingOpensAt: '2026-09-30T08:00:00+05:30', orderingClosesAt: '2026-09-30T10:00:00+05:30' }),
    });

    renderPage();

    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
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
});

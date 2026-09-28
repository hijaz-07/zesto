import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outlet } from '../../domain/types';
import type { Menu } from '../../features/menu/types';
import { ApiError } from '../../lib/api/client';
import { formatTime } from '../../utils/date';
import { useMenus } from '../../features/menu/useMenus';
import { useOutlets } from '../../features/outlet/useOutlets';
import { OrganizationOutletMenusPage } from './OrganizationOutletMenusPage';

vi.mock('../../features/outlet/useOutlets');
vi.mock('../../features/menu/useMenus');

const mockedUseOutlets = vi.mocked(useOutlets);
const mockedUseMenus = vi.mocked(useMenus);

const NOW = '2026-09-28T12:00:00+05:30';

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

const inactiveOutlet: Outlet = { ...activeOutlet, id: 'outlet-1', status: 'inactive' };

function mockOutlets(overrides: Partial<ReturnType<typeof useOutlets>>) {
  mockedUseOutlets.mockReturnValue({
    status: 'ready',
    outlets: [],
    error: null,
    retry: vi.fn(),
    createOutlet: vi.fn(),
    updateOutlet: vi.fn(),
    ...overrides,
  });
}

function mockMenus(overrides: Partial<ReturnType<typeof useMenus>>) {
  mockedUseMenus.mockReturnValue({
    status: 'ready',
    menus: [],
    error: null,
    retry: vi.fn(),
    createMenu: vi.fn(),
    updateMenu: vi.fn(),
    publishMenu: vi.fn(),
    archiveMenu: vi.fn(),
    ...overrides,
  });
}

function buildMenu(overrides: Pick<
  Menu,
  'id' | 'title' | 'menuDate' | 'status' | 'orderingOpensAt' | 'orderingClosesAt' | 'pickupStartsAt' | 'pickupEndsAt'
>): Menu {
  return {
    organizationId: 'org-1',
    outletId: 'outlet-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'U-1',
    ...overrides,
  };
}

const draftNotOpen = buildMenu({
  id: 'menu-draft',
  title: 'Draft Menu',
  menuDate: '2026-09-29',
  status: 'draft',
  orderingOpensAt: '2026-09-29T08:00:00+05:30',
  orderingClosesAt: '2026-09-29T10:00:00+05:30',
  pickupStartsAt: '2026-09-29T12:00:00+05:30',
  pickupEndsAt: '2026-09-29T14:00:00+05:30',
});

const publishedNotOpen = buildMenu({
  id: 'menu-not-open',
  title: 'Upcoming Menu',
  menuDate: '2026-09-30',
  status: 'published',
  orderingOpensAt: '2026-09-30T08:00:00+05:30',
  orderingClosesAt: '2026-09-30T10:00:00+05:30',
  pickupStartsAt: '2026-09-30T12:00:00+05:30',
  pickupEndsAt: '2026-09-30T14:00:00+05:30',
});

const publishedOpen = buildMenu({
  id: 'menu-open',
  title: 'Today’s Menu',
  menuDate: '2026-09-28',
  status: 'published',
  orderingOpensAt: '2026-09-28T08:00:00+05:30',
  orderingClosesAt: '2026-09-28T18:00:00+05:30',
  pickupStartsAt: '2026-09-28T18:30:00+05:30',
  pickupEndsAt: '2026-09-28T19:30:00+05:30',
});

const publishedClosed = buildMenu({
  id: 'menu-closed',
  title: 'Closed Menu',
  menuDate: '2026-09-28',
  status: 'published',
  orderingOpensAt: '2026-09-28T04:00:00+05:30',
  orderingClosesAt: '2026-09-28T10:00:00+05:30',
  pickupStartsAt: '2026-09-28T12:00:00+05:30',
  pickupEndsAt: '2026-09-28T14:00:00+05:30',
});

const archivedClosed = buildMenu({
  id: 'menu-archived',
  title: 'Archived Menu',
  menuDate: '2026-09-27',
  status: 'archived',
  orderingOpensAt: '2026-09-27T04:00:00+05:30',
  orderingClosesAt: '2026-09-27T10:00:00+05:30',
  pickupStartsAt: '2026-09-27T12:00:00+05:30',
  pickupEndsAt: '2026-09-27T14:00:00+05:30',
});

function renderPage(outletId = 'outlet-1') {
  return render(
    <MemoryRouter initialEntries={[`/org/menus/${outletId}`]}>
      <Routes>
        <Route path="/org/menus" element={<div>Outlet picker page</div>} />
        <Route
          path="/org/menus/:outletId"
          element={<OrganizationOutletMenusPage organizationId="org-1" />}
        />
        <Route path="/org/menus/:outletId/new" element={<div>Create menu page</div>} />
        <Route path="/org/menus/:outletId/:menuId" element={<div>Menu detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrganizationOutletMenusPage', () => {
  beforeEach(() => {
    mockedUseOutlets.mockReset();
    mockedUseMenus.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('8a. shows a loading state while the outlet is still being resolved', () => {
    mockOutlets({ status: 'loading', outlets: [] });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('8b. shows a loading state while menus are being fetched', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'loading', menus: [] });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('9. handles an unknown outletId safely, without fetching its menus', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    renderPage('does-not-exist');

    expect(screen.getByText('Outlet not found')).toBeInTheDocument();
    expect(mockedUseMenus).not.toHaveBeenCalled();
  });

  it('10. shows the outlet name as the page title with a supporting subtitle', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [] });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Main Canteen' })).toBeInTheDocument();
    expect(screen.getByText('Menus for this outlet.')).toBeInTheDocument();
  });

  it('11. clearly indicates when the outlet is inactive', () => {
    mockOutlets({ status: 'ready', outlets: [inactiveOutlet] });
    mockMenus({ status: 'ready', menus: [] });

    renderPage();

    expect(screen.getByText('INACTIVE')).toBeInTheDocument();
    expect(
      screen.getByText('New menus cannot be created while this outlet is inactive.'),
    ).toBeInTheDocument();
  });

  it('12. offers no create action anywhere on the page for an inactive outlet', () => {
    mockOutlets({ status: 'ready', outlets: [inactiveOutlet] });
    mockMenus({ status: 'ready', menus: [] });

    renderPage();

    expect(screen.queryByRole('button', { name: /Create Menu/ })).not.toBeInTheDocument();
  });

  it('13. shows an empty state when the outlet has no menus', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [] });

    renderPage();

    expect(screen.getByText('No menus yet')).toBeInTheDocument();
    expect(screen.getByText('Create a future menu for this outlet.')).toBeInTheDocument();
  });

  it('14. offers a Create Menu action in the empty state for an active outlet', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [] });

    renderPage();

    expect(screen.getAllByRole('button', { name: /Create Menu/ }).length).toBeGreaterThan(0);
  });

  it('15. renders a card per menu, preserving the order the backend returned', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedOpen, draftNotOpen, archivedClosed] });

    renderPage();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Today’s Menu', 'Draft Menu', 'Archived Menu']);
  });

  it('16. shows DRAFT and NOT OPEN for a draft menu before ordering opens', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [draftNotOpen] });

    renderPage();

    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('NOT OPEN')).toBeInTheDocument();
  });

  it('17. shows PUBLISHED and NOT OPEN for a published menu before ordering opens', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedNotOpen] });

    renderPage();

    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('NOT OPEN')).toBeInTheDocument();
  });

  it('18. shows PUBLISHED and OPEN for a published menu while ordering is open', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedOpen] });

    renderPage();

    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('19. shows PUBLISHED and CLOSED for a published menu after ordering closes', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedClosed] });

    renderPage();

    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('20. shows ARCHIVED and CLOSED for an archived menu', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [archivedClosed] });

    renderPage();

    expect(screen.getByText('ARCHIVED')).toBeInTheDocument();
    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('21. displays the ordering window', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedOpen] });

    renderPage();

    const expected = `${formatTime(publishedOpen.orderingOpensAt)} – ${formatTime(publishedOpen.orderingClosesAt)}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('22. displays the pickup window', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedOpen] });

    renderPage();

    const expected = `${formatTime(publishedOpen.pickupStartsAt)} – ${formatTime(publishedOpen.pickupEndsAt)}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('23. shows an error state with a working retry when menus fail to load', () => {
    const retry = vi.fn();
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'error', menus: [], error, retry });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('24. navigates back to the outlet picker', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Outlets' }));

    expect(screen.getByText('Outlet picker page')).toBeInTheDocument();
  });

  it('25. Create Menu navigates to the draft-menu creation form', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedOpen] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Menu' }));

    expect(screen.getByText('Create menu page')).toBeInTheDocument();
  });

  it('26. Manage Menu navigates to that menu\'s detail page', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    mockMenus({ status: 'ready', menus: [publishedOpen] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: `Manage ${publishedOpen.title}` }));

    expect(screen.getByText('Menu detail page')).toBeInTheDocument();
  });
});

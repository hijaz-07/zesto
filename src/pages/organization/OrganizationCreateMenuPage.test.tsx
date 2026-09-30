import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outlet } from '../../domain/types';
import { ApiError } from '../../lib/api/client';
import type { Menu } from '../../features/menu/types';
import { useOutlets } from '../../features/outlet/useOutlets';
import { OrganizationCreateMenuPage } from './OrganizationCreateMenuPage';

vi.mock('../../features/outlet/useOutlets');

const createMenuMock = vi.hoisted(() => vi.fn());
vi.mock('../../features/menu/api', () => ({
  createMenu: createMenuMock,
}));

const mockedUseOutlets = vi.mocked(useOutlets);

// Fixed clock (business date 2026-09-28) so the schedule dates below stay valid.
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

const inactiveOutlet: Outlet = { ...activeOutlet, status: 'inactive' };

const createdMenu: Menu = {
  id: 'menu-1',
  organizationId: 'org-1',
  outletId: 'outlet-1',
  menuDate: '2026-09-29',
  title: 'Tuesday Special',
  status: 'draft',
  orderingOpensAt: '2026-09-28T08:00:00+05:30',
  orderingClosesAt: '2026-09-29T10:00:00+05:30',
  pickupStartsAt: '2026-09-29T12:00:00+05:30',
  pickupEndsAt: '2026-09-29T14:00:00+05:30',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: 'U-1',
};

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

function renderPage(outletId = 'outlet-1') {
  return render(
    <MemoryRouter initialEntries={[`/org/menus/${outletId}/new`]}>
      <Routes>
        <Route path="/org/menus" element={<div>Outlet picker page</div>} />
        <Route path="/org/menus/:outletId" element={<div>Menu list page</div>} />
        <Route path="/org/menus/:outletId/new" element={<OrganizationCreateMenuPage organizationId="org-1" />} />
        <Route path="/org/menus/:outletId/:menuId" element={<div>Menu detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrganizationCreateMenuPage', () => {
  beforeEach(() => {
    // Date-only mock (no vi.useFakeTimers()): the tests below `await`, which relies on
    // real timers for RTL's polling.
    vi.setSystemTime(new Date(NOW));
    mockedUseOutlets.mockReset();
    createMenuMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. renders a loading state while the outlet is being resolved', () => {
    mockOutlets({ status: 'loading', outlets: [] });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when outlets fail to load', () => {
    const retry = vi.fn();
    const error = new ApiError(503, 'unavailable', 'Backend unavailable.');
    mockOutlets({ status: 'error', outlets: [], error, retry });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Zesto is temporarily unavailable. Please try again in a moment.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows a not-found state for an outletId that is not one of this organization\'s outlets', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    renderPage('does-not-exist');

    expect(screen.getByText('Outlet not found')).toBeInTheDocument();
  });

  it('33. keeps the create form unavailable for an inactive outlet', () => {
    mockOutlets({ status: 'ready', outlets: [inactiveOutlet] });

    renderPage();

    expect(screen.getByText('This outlet is inactive')).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('1. renders the create form for an active outlet', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Create Menu' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Draft' })).toBeInTheDocument();
  });

  it('navigates to the menu detail page using the created menu, on success', async () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });
    createMenuMock.mockResolvedValue({ menu: createdMenu });

    renderPage();

    fireEvent.change(screen.getByLabelText('Menu date'), { target: { value: '2026-09-29' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tuesday Special' } });
    fireEvent.change(screen.getByLabelText('Opens date'), { target: { value: '2026-09-28' } });
    fireEvent.change(screen.getByLabelText('Opens time'), { target: { value: '08:00' } });
    fireEvent.change(screen.getByLabelText('Closes date'), { target: { value: '2026-09-29' } });
    fireEvent.change(screen.getByLabelText('Closes time'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText('Starts date'), { target: { value: '2026-09-29' } });
    fireEvent.change(screen.getByLabelText('Starts time'), { target: { value: '12:00' } });
    fireEvent.change(screen.getByLabelText('Ends date'), { target: { value: '2026-09-29' } });
    fireEvent.change(screen.getByLabelText('Ends time'), { target: { value: '14:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));

    await waitFor(() => expect(screen.getByText('Menu detail page')).toBeInTheDocument());
    expect(createMenuMock).toHaveBeenCalledWith('org-1', 'outlet-1', expect.objectContaining({ title: 'Tuesday Special' }));
  });

  it('3./5. Back to Menus navigates to this outlet\'s menu list', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Menus' }));

    expect(screen.getByText('Menu list page')).toBeInTheDocument();
  });

  it('Cancel navigates to this outlet\'s menu list', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Menu list page')).toBeInTheDocument();
  });
});

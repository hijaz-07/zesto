import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outlet } from '../../domain/types';
import { ApiError } from '../../lib/api/client';
import { useOutlets } from '../../features/outlet/useOutlets';
import { OrganizationMenusPage } from './OrganizationMenusPage';

vi.mock('../../features/outlet/useOutlets');

const mockedUseOutlets = vi.mocked(useOutlets);

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

const inactiveOutlet: Outlet = { ...activeOutlet, id: 'outlet-2', name: 'Old Kiosk', status: 'inactive' };

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

function renderPage(initialPath = '/org/menus') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/org/menus" element={<OrganizationMenusPage organizationId="org-1" />} />
        <Route path="/org/menus/:outletId" element={<div>Menu list page</div>} />
        <Route path="/org/outlets" element={<div>Outlets page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrganizationMenusPage', () => {
  beforeEach(() => {
    mockedUseOutlets.mockReset();
  });

  it('1. shows a loading state while outlets are being fetched', () => {
    mockOutlets({ status: 'loading', outlets: [] });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('2. shows an error state with a working retry when the fetch fails', () => {
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

  it('3. shows an empty state directing the caller to Outlets when the organization has none', () => {
    mockOutlets({ status: 'ready', outlets: [] });

    renderPage();

    expect(screen.getByText('No outlets yet')).toBeInTheDocument();
    expect(screen.getByText('Create an outlet before creating menus.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Go to Outlets/ }));
    expect(screen.getByText('Outlets page')).toBeInTheDocument();
  });

  it('4. automatically navigates to the single outlet when the organization has exactly one', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet] });

    renderPage();

    expect(screen.getByText('Menu list page')).toBeInTheDocument();
  });

  it('5. renders a card per outlet when the organization has multiple', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet, inactiveOutlet] });

    renderPage();

    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
    expect(screen.getByText('Old Kiosk')).toBeInTheDocument();
  });

  it('6. still lists an inactive outlet, clearly marked, alongside active ones', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet, inactiveOutlet] });

    renderPage();

    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('INACTIVE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Menus for Old Kiosk' })).toBeInTheDocument();
  });

  it('7. navigates to that outlet\'s menu list when Open Menus is clicked', () => {
    mockOutlets({ status: 'ready', outlets: [activeOutlet, inactiveOutlet] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Menus for Main Canteen' }));

    expect(screen.getByText('Menu list page')).toBeInTheDocument();
  });
});

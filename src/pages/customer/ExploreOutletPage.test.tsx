import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExploreOutlet, ExploreOutletMenu } from '../../features/explore/types';
import { useExploreOutlet } from '../../features/explore/useExploreOutlet';
import { ApiError } from '../../lib/api/client';
import { ExploreOutletPage } from './ExploreOutletPage';

vi.mock('../../features/explore/useExploreOutlet');

const mockedUseExploreOutlet = vi.mocked(useExploreOutlet);

function mockOutlet(overrides: Partial<ReturnType<typeof useExploreOutlet>>) {
  mockedUseExploreOutlet.mockReturnValue({
    status: 'ready',
    outlet: null,
    menus: [],
    error: null,
    retry: vi.fn(),
    ...overrides,
  });
}

const outlet: ExploreOutlet = {
  id: 'outlet-1',
  name: 'Main Canteen',
  description: 'Campus canteen serving lunch and dinner.',
  address: { city: 'Kochi', state: 'Kerala' },
};

const menu: ExploreOutletMenu = {
  id: 'menu-1',
  menuDate: '2026-09-30',
  title: 'Tuesday Special Menu',
  orderingOpensAt: '2026-09-29T18:00:00+05:30',
  orderingClosesAt: '2026-09-30T09:00:00+05:30',
  pickupStartsAt: '2026-09-30T12:30:00+05:30',
  pickupEndsAt: '2026-09-30T14:00:00+05:30',
  orderingState: 'not_open',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/explore/outlets/outlet-1']}>
      <Routes>
        <Route path="/explore" element={<div>Explore page</div>} />
        <Route path="/explore/outlets/:outletId" element={<ExploreOutletPage />} />
        <Route path="/explore/outlets/:outletId/menus/:menuId" element={<div>Menu detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExploreOutletPage', () => {
  beforeEach(() => {
    mockedUseExploreOutlet.mockReset();
  });

  it('shows a loading state while the outlet is being fetched', () => {
    mockOutlet({ status: 'loading' });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when the outlet fails to load', () => {
    const retry = vi.fn();
    const error = new ApiError(404, 'not_found', 'Not found.');
    mockOutlet({ status: 'error', error, retry });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Outlet not available.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders the outlet name, description, and address', () => {
    mockOutlet({ status: 'ready', outlet, menus: [] });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Main Canteen' })).toBeInTheDocument();
    expect(screen.getByText('Campus canteen serving lunch and dinner.')).toBeInTheDocument();
    expect(screen.getByText('Kochi, Kerala')).toBeInTheDocument();
  });

  it('shows an empty state when the outlet has no upcoming menus', () => {
    mockOutlet({ status: 'ready', outlet, menus: [] });

    renderPage();

    expect(screen.getByText('No upcoming menus')).toBeInTheDocument();
  });

  it('renders a card per upcoming menu', () => {
    mockOutlet({ status: 'ready', outlet, menus: [menu] });

    renderPage();

    expect(screen.getByText('Tuesday Special Menu')).toBeInTheDocument();
  });

  it('navigates to the menu detail page when a menu is tapped', () => {
    mockOutlet({ status: 'ready', outlet, menus: [menu] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'View Tuesday Special Menu' }));

    expect(screen.getByText('Menu detail page')).toBeInTheDocument();
  });

  it('navigates back to Explore', () => {
    mockOutlet({ status: 'ready', outlet, menus: [] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Explore' }));

    expect(screen.getByText('Explore page')).toBeInTheDocument();
  });
});

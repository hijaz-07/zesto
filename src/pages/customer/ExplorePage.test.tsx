import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExploreOutletSummary } from '../../features/explore/types';
import { useExploreOutlets } from '../../features/explore/useExploreOutlets';
import { ApiError } from '../../lib/api/client';
import { ExplorePage } from './ExplorePage';

vi.mock('../../features/explore/useExploreOutlets');

const mockedUseExploreOutlets = vi.mocked(useExploreOutlets);

function mockOutlets(overrides: Partial<ReturnType<typeof useExploreOutlets>>) {
  mockedUseExploreOutlets.mockReturnValue({
    status: 'ready',
    outlets: [],
    error: null,
    retry: vi.fn(),
    ...overrides,
  });
}

const outletSummary: ExploreOutletSummary = {
  id: 'outlet-1',
  name: 'Main Canteen',
  nextMenu: {
    id: 'menu-1',
    menuDate: '2026-09-30',
    title: 'Tuesday Special Menu',
    orderingOpensAt: '2026-09-29T18:00:00+05:30',
    orderingClosesAt: '2026-09-30T09:00:00+05:30',
    pickupStartsAt: '2026-09-30T12:30:00+05:30',
    pickupEndsAt: '2026-09-30T14:00:00+05:30',
    orderingState: 'not_open',
  },
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/explore']}>
      <Routes>
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/explore/outlets/:outletId" element={<div>Outlet detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExplorePage', () => {
  beforeEach(() => {
    mockedUseExploreOutlets.mockReset();
  });

  it('shows a loading state while outlets are being fetched', () => {
    mockOutlets({ status: 'loading', outlets: [] });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an empty state when no outlets are returned', () => {
    mockOutlets({ status: 'ready', outlets: [] });

    renderPage();

    expect(screen.getByText('No outlets available')).toBeInTheDocument();
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

  it('renders a card per outlet', () => {
    mockOutlets({ status: 'ready', outlets: [outletSummary] });

    renderPage();

    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
  });

  it('navigates to the outlet detail page when an outlet is tapped', () => {
    mockOutlets({ status: 'ready', outlets: [outletSummary] });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'View Main Canteen' }));

    expect(screen.getByText('Outlet detail page')).toBeInTheDocument();
  });
});

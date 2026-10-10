import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ExploreOutletSummary } from '../../features/explore/types';
import { useExploreOutlets } from '../../features/explore/useExploreOutlets';
import { CustomerMenuPage } from './CustomerMenuPage';

vi.mock('../../features/explore/useExploreOutlets');
vi.mock('../../features/notification/NotificationBell', () => ({ NotificationBell: () => null }));

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
    orderingState: 'open',
  },
};

describe('CustomerMenuPage', () => {
  it('shows the real outlet feed instead of sample content', () => {
    vi.mocked(useExploreOutlets).mockReturnValue({ status: 'ready', outlets: [outletSummary], error: null, retry: vi.fn() });

    render(
      <MemoryRouter>
        <CustomerMenuPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Upcoming menus' })).toBeInTheDocument();
    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
    expect(screen.queryByText(/Development preview/)).not.toBeInTheDocument();
  });
});

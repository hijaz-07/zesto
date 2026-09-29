import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExploreMenuDetail } from '../../features/explore/types';
import { useExploreMenu } from '../../features/explore/useExploreMenu';
import { ApiError } from '../../lib/api/client';
import { formatDate, formatTime } from '../../utils/date';
import { ExploreMenuDetailPage } from './ExploreMenuDetailPage';

vi.mock('../../features/explore/useExploreMenu');

const mockedUseExploreMenu = vi.mocked(useExploreMenu);

function mockMenu(overrides: Partial<ReturnType<typeof useExploreMenu>>) {
  mockedUseExploreMenu.mockReturnValue({
    status: 'ready',
    outlet: null,
    menu: null,
    error: null,
    retry: vi.fn(),
    ...overrides,
  });
}

const menuDetail: ExploreMenuDetail = {
  id: 'menu-1',
  menuDate: '2026-09-30',
  title: 'Tuesday Special Menu',
  description: 'A special weekday spread.',
  orderingOpensAt: '2026-09-29T18:00:00+05:30',
  orderingClosesAt: '2026-09-30T09:00:00+05:30',
  pickupStartsAt: '2026-09-30T12:30:00+05:30',
  pickupEndsAt: '2026-09-30T14:00:00+05:30',
  orderingState: 'open',
  items: [
    {
      id: 'item-chicken-biriyani',
      name: 'Chicken Biriyani',
      description: 'Slow-cooked basmati rice with spiced chicken.',
      priceInPaise: 12000,
      displayOrder: 1,
    },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/explore/outlets/outlet-1/menus/menu-1']}>
      <Routes>
        <Route path="/explore/outlets/:outletId" element={<div>Outlet detail page</div>} />
        <Route path="/explore/outlets/:outletId/menus/:menuId" element={<ExploreMenuDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExploreMenuDetailPage', () => {
  beforeEach(() => {
    mockedUseExploreMenu.mockReset();
  });

  it('shows a loading state while the menu is being fetched', () => {
    mockMenu({ status: 'loading' });

    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when the menu fails to load', () => {
    const retry = vi.fn();
    const error = new ApiError(404, 'not_found', 'Not found.');
    mockMenu({ status: 'error', error, retry });

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Menu not available.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders the menu title, date, description, and ordering state', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Tuesday Special Menu' })).toBeInTheDocument();
    expect(screen.getByText(formatDate(menuDetail.menuDate))).toBeInTheDocument();
    expect(screen.getByText('A special weekday spread.')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('renders the pickup window', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    const expected = `Pickup ${formatTime(menuDetail.pickupStartsAt)} – ${formatTime(menuDetail.pickupEndsAt)}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders the published menu items with formatted prices', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
    expect(screen.getByText('₹120')).toBeInTheDocument();
  });

  it('never renders any ordering, cart, or checkout affordance', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    expect(screen.queryByText(/add to cart/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/checkout/i)).not.toBeInTheDocument();
  });

  it('navigates back to the outlet page', () => {
    mockMenu({ status: 'ready', menu: menuDetail });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Outlet' }));

    expect(screen.getByText('Outlet detail page')).toBeInTheDocument();
  });
});

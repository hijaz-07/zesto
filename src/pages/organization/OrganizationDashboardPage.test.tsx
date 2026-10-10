import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outlet } from '../../domain/types';
import { getMenuDemand, getMenus } from '../../features/menu/api';
import type { Menu } from '../../features/menu/types';
import { getOutlets } from '../../features/outlet/api';
import { businessToday } from '../../utils/date';
import { OrganizationDashboardPage } from './OrganizationDashboardPage';

vi.mock('../../features/outlet/api');
vi.mock('../../features/menu/api');
vi.mock('../../components/layout/OrganizationPageToolbar', () => ({ OrganizationPageToolbar: () => null }));

const outlet: Outlet = {
  id: 'outlet-1',
  organizationId: 'org-1',
  name: 'Main Test Canteen',
  slug: 'main-test-canteen',
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'U-owner',
};

function upcomingMenu(): Menu {
  const today = businessToday();
  return {
    id: 'menu-1',
    organizationId: 'org-1',
    outletId: 'outlet-1',
    menuDate: today,
    title: 'Staging Test Menu',
    status: 'published',
    orderingOpensAt: '2026-01-01T00:00:00.000Z',
    orderingClosesAt: '2099-01-01T00:00:00.000Z',
    pickupStartsAt: `${today}T07:00:00.000Z`,
    pickupEndsAt: `${today}T08:30:00.000Z`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    createdBy: 'U-owner',
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <OrganizationDashboardPage organizationId="org-1" />
    </MemoryRouter>,
  );
}

describe('OrganizationDashboardPage', () => {
  beforeEach(() => {
    vi.mocked(getOutlets).mockResolvedValue({ outlets: [outlet] });
    vi.mocked(getMenus).mockResolvedValue({ menus: [upcomingMenu()] });
  });

  it("shows each active outlet's next menu with the demand the server computed", async () => {
    vi.mocked(getMenuDemand).mockResolvedValue({
      demand: {
        menuId: 'menu-1',
        paidOrders: 2,
        totalPortions: 5,
        items: [
          { itemId: 'i1', name: 'Test Biriyani', portions: 5 },
          { itemId: 'i2', name: 'Test Meals', portions: 0 },
        ],
        computedAt: '2026-10-10T08:00:00.000Z',
      },
    });

    renderPage();

    expect(await screen.findByText('Staging Test Menu')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Main Test Canteen' })).toBeInTheDocument();
    expect(await screen.findByText('Test Biriyani')).toBeInTheDocument();
    expect(screen.getByText('Test Meals')).toBeInTheDocument();
    expect(screen.getByText(/paid orders only/i)).toBeInTheDocument();
    expect(getMenuDemand).toHaveBeenCalledWith('org-1', 'outlet-1', 'menu-1');
    // The old development placeholder is gone.
    expect(screen.queryByText(/not yet connected to a backend/i)).not.toBeInTheDocument();
  });

  it('says so when there are no paid orders yet', async () => {
    vi.mocked(getMenuDemand).mockResolvedValue({
      demand: { menuId: 'menu-1', paidOrders: 0, totalPortions: 0, items: [], computedAt: '2026-10-10T08:00:00.000Z' },
    });

    renderPage();

    expect(await screen.findByText('No paid orders yet.')).toBeInTheDocument();
  });

  it('points to Menus when an outlet has no upcoming published menu', async () => {
    vi.mocked(getMenus).mockResolvedValue({ menus: [] });

    renderPage();

    expect(await screen.findByText(/No upcoming published menu/)).toBeInTheDocument();
    expect(getMenuDemand).not.toHaveBeenCalled();
  });

  it('skips inactive outlets', async () => {
    vi.mocked(getOutlets).mockResolvedValue({ outlets: [{ ...outlet, status: 'inactive' }] });

    renderPage();

    expect(await screen.findByText('No active outlets')).toBeInTheDocument();
  });
});

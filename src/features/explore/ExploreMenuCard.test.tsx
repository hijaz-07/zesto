import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { formatDate } from '../../utils/date';
import type { ExploreOutletMenu } from './types';
import { ExploreMenuCard } from './ExploreMenuCard';

function buildMenu(overrides: Partial<ExploreOutletMenu> = {}): ExploreOutletMenu {
  return {
    id: 'menu-1',
    menuDate: '2026-09-30',
    title: 'Tuesday Special Menu',
    orderingOpensAt: '2026-09-29T18:00:00+05:30',
    orderingClosesAt: '2026-09-30T09:00:00+05:30',
    pickupStartsAt: '2026-09-30T12:30:00+05:30',
    pickupEndsAt: '2026-09-30T14:00:00+05:30',
    orderingState: 'not_open',
    ...overrides,
  };
}

describe('ExploreMenuCard', () => {
  it('renders the menu title and date', () => {
    render(<ExploreMenuCard menu={buildMenu()} onClick={vi.fn()} />);

    expect(screen.getByText('Tuesday Special Menu')).toBeInTheDocument();
    expect(screen.getByText(formatDate('2026-09-30'))).toBeInTheDocument();
  });

  it("shows the backend-provided ordering state, not a recomputed one", () => {
    render(<ExploreMenuCard menu={buildMenu({ orderingState: 'open' })} onClick={vi.fn()} />);

    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('shows CLOSED when the backend reports the ordering window has closed', () => {
    render(<ExploreMenuCard menu={buildMenu({ orderingState: 'closed' })} onClick={vi.fn()} />);

    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('calls onClick when tapped', () => {
    const onClick = vi.fn();
    render(<ExploreMenuCard menu={buildMenu()} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'View Tuesday Special Menu' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

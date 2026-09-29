import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExploreOutletSummary } from './types';
import { ExploreOutletCard } from './ExploreOutletCard';

const baseOutlet: ExploreOutletSummary = {
  id: 'outlet-1',
  name: 'Main Canteen',
};

describe('ExploreOutletCard', () => {
  it('renders the outlet name', () => {
    render(<ExploreOutletCard outlet={baseOutlet} onClick={vi.fn()} />);

    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
  });

  it('renders the description when available', () => {
    render(
      <ExploreOutletCard
        outlet={{ ...baseOutlet, description: 'Campus canteen serving lunch and dinner.' }}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('Campus canteen serving lunch and dinner.')).toBeInTheDocument();
  });

  it('omits the description when not available', () => {
    render(<ExploreOutletCard outlet={baseOutlet} onClick={vi.fn()} />);

    expect(screen.queryByText(/canteen serving/)).not.toBeInTheDocument();
  });

  it('renders the city/state address when available', () => {
    render(
      <ExploreOutletCard
        outlet={{ ...baseOutlet, address: { city: 'Kochi', state: 'Kerala' } }}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('Kochi, Kerala')).toBeInTheDocument();
  });

  it('indicates an upcoming menu is available', () => {
    render(
      <ExploreOutletCard
        outlet={{
          ...baseOutlet,
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
        }}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('Menu available')).toBeInTheDocument();
    expect(screen.getByText(/Tuesday Special Menu/)).toBeInTheDocument();
  });

  it('does not render any organization/outlet ID in the UI', () => {
    render(<ExploreOutletCard outlet={baseOutlet} onClick={vi.fn()} />);

    expect(screen.queryByText('outlet-1')).not.toBeInTheDocument();
  });

  it('calls onClick when tapped', () => {
    const onClick = vi.fn();
    render(<ExploreOutletCard outlet={baseOutlet} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'View Main Canteen' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

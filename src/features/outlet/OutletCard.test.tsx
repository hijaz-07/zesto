import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Outlet } from '../../domain/types';
import { OutletCard } from './OutletCard';

const baseOutlet: Outlet = {
  id: 'outlet-1',
  organizationId: 'org-1',
  name: 'Main Canteen',
  slug: 'main-canteen',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'U-1',
};

describe('OutletCard', () => {
  it('shows an ACTIVE badge for an active outlet', () => {
    render(<OutletCard outlet={baseOutlet} onEdit={vi.fn()} />);

    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.queryByText('INACTIVE')).not.toBeInTheDocument();
  });

  it('shows an INACTIVE badge for an inactive outlet', () => {
    render(<OutletCard outlet={{ ...baseOutlet, status: 'inactive' }} onEdit={vi.fn()} />);

    expect(screen.getByText('INACTIVE')).toBeInTheDocument();
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
  });

  it('shows the description when present, and omits it when absent', () => {
    const { rerender } = render(
      <OutletCard outlet={{ ...baseOutlet, description: 'Main campus food outlet' }} onEdit={vi.fn()} />,
    );
    expect(screen.getByText('Main campus food outlet')).toBeInTheDocument();

    rerender(<OutletCard outlet={baseOutlet} onEdit={vi.fn()} />);
    expect(screen.queryByText('Main campus food outlet')).not.toBeInTheDocument();
  });

  it('shows a city/state summary when the address has one, and omits it otherwise', () => {
    const { rerender } = render(
      <OutletCard
        outlet={{ ...baseOutlet, address: { city: 'Kasaragod', state: 'Kerala' } }}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Kasaragod, Kerala')).toBeInTheDocument();

    rerender(<OutletCard outlet={baseOutlet} onEdit={vi.fn()} />);
    expect(screen.queryByText('Kasaragod, Kerala')).not.toBeInTheDocument();
  });

  it('never renders technical fields like id, organizationId, slug, or timestamps', () => {
    render(<OutletCard outlet={baseOutlet} onEdit={vi.fn()} />);

    expect(screen.queryByText('outlet-1')).not.toBeInTheDocument();
    expect(screen.queryByText('org-1')).not.toBeInTheDocument();
    expect(screen.queryByText('main-canteen')).not.toBeInTheDocument();
    expect(screen.queryByText('2026-01-01T00:00:00.000Z')).not.toBeInTheDocument();
  });

  it('calls onEdit when the Edit button is clicked', () => {
    const onEdit = vi.fn();
    render(<OutletCard outlet={baseOutlet} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

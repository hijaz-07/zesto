import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrganizationMenuOverview } from './OrganizationMenuOverview';

describe('OrganizationMenuOverview', () => {
  it("renders tomorrow's menu schedule, items, and demand overview for the organization", () => {
    render(<OrganizationMenuOverview />);

    expect(screen.getByText("Tomorrow's Menu")).toBeInTheDocument();
    expect(screen.getByText('Menu date')).toBeInTheDocument();
    // "Chicken Biriyani" / "Veg Meals" appear both in the items table and the demand chart.
    expect(screen.getAllByText('Chicken Biriyani').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Veg Meals').length).toBeGreaterThan(0);
    expect(screen.getByText('Demand overview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add item/ })).toBeInTheDocument();
  });
});

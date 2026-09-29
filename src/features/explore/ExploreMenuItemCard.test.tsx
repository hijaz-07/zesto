import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExploreMenuItem } from './types';
import { ExploreMenuItemCard } from './ExploreMenuItemCard';

const baseItem: ExploreMenuItem = {
  id: 'item-1',
  name: 'Chicken Biriyani',
  priceInPaise: 12000,
  displayOrder: 1,
};

describe('ExploreMenuItemCard', () => {
  it('renders the item name and formatted price', () => {
    render(<ExploreMenuItemCard item={baseItem} />);

    expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
    expect(screen.getByText('₹120')).toBeInTheDocument();
  });

  it('renders the description when available', () => {
    render(
      <ExploreMenuItemCard
        item={{ ...baseItem, description: 'Slow-cooked basmati rice with spiced chicken.' }}
      />,
    );

    expect(screen.getByText('Slow-cooked basmati rice with spiced chicken.')).toBeInTheDocument();
  });

  it('omits the description when not available', () => {
    render(<ExploreMenuItemCard item={baseItem} />);

    expect(screen.queryByText(/basmati rice/)).not.toBeInTheDocument();
  });

  it('has no quantity control or add-to-cart affordance', () => {
    render(<ExploreMenuItemCard item={baseItem} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

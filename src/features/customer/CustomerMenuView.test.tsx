import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CustomerMenuView } from './CustomerMenuView';

describe('CustomerMenuView', () => {
  it("renders tomorrow's placeholder menu items with prices", () => {
    render(<CustomerMenuView />);

    expect(screen.getByText("Tomorrow's Menu")).toBeInTheDocument();
    expect(screen.getByText('Chicken Biriyani')).toBeInTheDocument();
    expect(screen.getByText('Beef Biriyani')).toBeInTheDocument();
    expect(screen.getByText('Veg Meals')).toBeInTheDocument();
    expect(screen.getByText('₹120')).toBeInTheDocument();
  });

  it('lets a customer adjust the quantity for an item without placing an order', () => {
    render(<CustomerMenuView />);

    const quantity = screen.getByTestId('quantity-item-chicken-biriyani');
    expect(quantity).toHaveTextContent('0');

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' }));
    expect(quantity).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: 'Decrease quantity for Chicken Biriyani' }));
    expect(quantity).toHaveTextContent('0');
  });
});

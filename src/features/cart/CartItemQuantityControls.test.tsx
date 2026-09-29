import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyCart } from './cart';
import { CartItemQuantityControls } from './CartItemQuantityControls';
import { setCart } from './store';
import type { CartContext, CartItemSnapshot } from './types';

const context: CartContext = { outletId: 'outlet-1', menuId: 'menu-1' };
const biriyani: CartItemSnapshot = { itemId: 'item-biriyani', name: 'Chicken Biriyani', priceInPaise: 12000 };

describe('CartItemQuantityControls', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setCart(createEmptyCart());
  });

  it('starts at 0 with decrease disabled', () => {
    render(<CartItemQuantityControls context={context} item={biriyani} />);

    expect(screen.getByTestId('cart-quantity-item-biriyani')).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: 'Decrease quantity for Chicken Biriyani' })).toBeDisabled();
  });

  it('increments on +', () => {
    render(<CartItemQuantityControls context={context} item={biriyani} />);

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' }));

    expect(screen.getByTestId('cart-quantity-item-biriyani')).toHaveTextContent('1');
  });

  it('never goes negative when decrementing from 0', () => {
    render(<CartItemQuantityControls context={context} item={biriyani} />);

    const decreaseButton = screen.getByRole('button', { name: 'Decrease quantity for Chicken Biriyani' });
    fireEvent.click(decreaseButton);

    expect(screen.getByTestId('cart-quantity-item-biriyani')).toHaveTextContent('0');
  });

  it('decrements back down and re-disables decrease at 0', () => {
    render(<CartItemQuantityControls context={context} item={biriyani} />);

    const increaseButton = screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' });
    const decreaseButton = screen.getByRole('button', { name: 'Decrease quantity for Chicken Biriyani' });

    fireEvent.click(increaseButton);
    fireEvent.click(decreaseButton);

    expect(screen.getByTestId('cart-quantity-item-biriyani')).toHaveTextContent('0');
    expect(decreaseButton).toBeDisabled();
  });

  it('disables the increase button when a context conflict is flagged', () => {
    render(<CartItemQuantityControls context={context} item={biriyani} disabled />);

    expect(screen.getByRole('button', { name: 'Increase quantity for Chicken Biriyani' })).toBeDisabled();
  });
});

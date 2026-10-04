import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  cancelledSummary,
  confirmedSummary,
  pendingSummary,
  preparingSummary,
  readySummary,
} from '../../test/orderHistoryFixtures';
import { OrderHistoryCard } from './OrderHistoryCard';
import type { OrderSummary } from './types';

describe('OrderHistoryCard', () => {
  it('shows the outlet, menu title and menu date', () => {
    render(<OrderHistoryCard order={confirmedSummary} onClick={vi.fn()} />);

    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
    expect(screen.getByText(/Tuesday Special Menu · 29 Sep(t)? 2026/)).toBeInTheDocument();
  });

  it('shows the item summary lines with quantities', () => {
    render(<OrderHistoryCard order={confirmedSummary} onClick={vi.fn()} />);

    expect(screen.getByText('Chicken Biriyani × 2')).toBeInTheDocument();
    expect(screen.getByText('Veg Meals × 1')).toBeInTheDocument();
  });

  it('shows how many further item lines are not listed', () => {
    render(<OrderHistoryCard order={{ ...confirmedSummary, moreItemLines: 2 }} onClick={vi.fn()} />);

    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('does not show a "more" line when every line is listed', () => {
    render(<OrderHistoryCard order={confirmedSummary} onClick={vi.fn()} />);

    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it('shows the stored total in rupees and the portion count', () => {
    render(<OrderHistoryCard order={confirmedSummary} onClick={vi.fn()} />);

    expect(screen.getByText('₹300')).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
  });

  it('uses the singular for a single item', () => {
    render(<OrderHistoryCard order={pendingSummary} onClick={vi.fn()} />);

    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it("shows when the order was placed, in Zesto's business time zone", () => {
    render(<OrderHistoryCard order={confirmedSummary} onClick={vi.fn()} />);

    expect(screen.getByText(/^Placed 28 Sep(t)? 2026, 10:30\s?(am|AM)$/)).toBeInTheDocument();
  });

  it('shows a preparing order as Preparing and Paid, rather than failing to render', () => {
    render(<OrderHistoryCard order={preparingSummary} onClick={vi.fn()} />);

    expect(screen.getByText('Preparing')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment pending')).not.toBeInTheDocument();
  });

  it('shows a ready order as Ready and Paid, rather than failing to render', () => {
    render(<OrderHistoryCard order={readySummary} onClick={vi.fn()} />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
  });

  it('shows an order in a status this build does not know as words, never a blank or a crash', () => {
    const future = { ...confirmedSummary, status: 'picked_up' as OrderSummary['status'] };

    render(<OrderHistoryCard order={future} onClick={vi.fn()} />);

    expect(screen.getByText('Picked up')).toBeInTheDocument();
    expect(screen.getByText('Main Canteen')).toBeInTheDocument();
  });

  it('shows a confirmed, paid order as Confirmed and Paid', () => {
    render(<OrderHistoryCard order={confirmedSummary} onClick={vi.fn()} />);

    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText('Payment pending')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
  });

  it('shows an unpaid order as Payment pending', () => {
    render(<OrderHistoryCard order={pendingSummary} onClick={vi.fn()} />);

    expect(screen.getByText('Payment pending')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });

  it('shows a cancelled order as Cancelled only', () => {
    render(<OrderHistoryCard order={cancelledSummary} onClick={vi.fn()} />);

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Payment pending')).not.toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });

  it('degrades gracefully when the outlet and menu no longer exist', () => {
    render(<OrderHistoryCard order={{ ...confirmedSummary, outlet: undefined, menu: undefined }} onClick={vi.fn()} />);

    expect(screen.getByText('Order')).toBeInTheDocument();
    expect(screen.getByText('Chicken Biriyani × 2')).toBeInTheDocument();
    expect(screen.getByText('₹300')).toBeInTheDocument();
  });

  it('calls onClick when the card is activated', () => {
    const onClick = vi.fn();
    render(<OrderHistoryCard order={confirmedSummary} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

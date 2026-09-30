import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HomePage } from './HomePage';

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/explore" element={<div>Explore page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  it('renders the Zesto brand and tagline as the hero', () => {
    renderHome();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Know the demand before you cook.' }),
    ).toBeInTheDocument();
  });

  it('no longer shows the development-status placeholder', () => {
    renderHome();

    expect(screen.queryByText('Development status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customer App' })).not.toBeInTheDocument();
  });

  it('describes the customer and organization flows', () => {
    renderHome();

    expect(screen.getByRole('heading', { name: 'How Zesto works' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'For customers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'For organizations' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Why Zesto' })).toBeInTheDocument();
    expect(screen.getByText('Pre-order')).toBeInTheDocument();
    expect(screen.getByText('Receive demand')).toBeInTheDocument();
  });

  it('does not make unverified claims', () => {
    renderHome();

    expect(screen.queryByText(/\bAI\b|forecast|delivery|loyalty|subscription|trusted by/i)).not.toBeInTheDocument();
  });

  it('links the primary CTA and header to /explore', () => {
    renderHome();

    const links = screen.getAllByRole('link', { name: /Explore Menus/ });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/explore');
    }
  });

  it('links the organization action to sign-in', () => {
    renderHome();

    const header = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(header).getByRole('link', { name: 'Organization sign-in' })).toHaveAttribute('href', '/login');
  });

  it('exposes all policy and contact links in the footer', () => {
    renderHome();

    const footer = screen.getByRole('navigation', { name: 'Footer' });
    expect(within(footer).getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(within(footer).getByRole('link', { name: 'Refund & Cancellation' })).toHaveAttribute(
      'href',
      '/refund-cancellation',
    );
    expect(within(footer).getByRole('link', { name: 'Contact' })).toHaveAttribute('href', '/contact');
  });
});

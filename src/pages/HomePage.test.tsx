import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HomePage } from './HomePage';

describe('HomePage', () => {
  it('renders the Zesto brand, tagline, development status, and app entry points', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Zesto' })).toBeInTheDocument();
    expect(screen.getByText('Know the demand before you cook.')).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('Ionic')).toBeInTheDocument();
    expect(screen.getByText('Tailwind')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customer App' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Organization Dashboard' })).toBeInTheDocument();
  });
});

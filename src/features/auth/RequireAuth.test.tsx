import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth } from './RequireAuth';
import type { AuthContextValue } from './types';
import { useAuth } from './useAuth';

vi.mock('./useAuth');

const mockedUseAuth = vi.mocked(useAuth);

function renderWithGuard(initialEntries: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<div>Public home</div>} />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <div>Protected content</div>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function authValue(overrides: Partial<AuthContextValue>): AuthContextValue {
  return {
    user: null,
    status: 'initializing',
    isAuthenticated: false,
    signOut: vi.fn(),
    ...overrides,
  };
}

describe('RequireAuth', () => {
  it('shows a loading state while auth is initializing, without revealing protected content', () => {
    mockedUseAuth.mockReturnValue(authValue({ status: 'initializing' }));

    renderWithGuard(['/app']);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders protected content for authenticated users', () => {
    mockedUseAuth.mockReturnValue(
      authValue({ status: 'signedIn', isAuthenticated: true, user: { uid: 'user-123' } as never }),
    );

    renderWithGuard(['/app']);

    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });

  it('redirects signed-out users away from protected content', () => {
    mockedUseAuth.mockReturnValue(authValue({ status: 'signedOut' }));

    renderWithGuard(['/app']);

    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(screen.getByText('Public home')).toBeInTheDocument();
  });
});
